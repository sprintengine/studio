// The guide run (MC-1679): the intelligence of the review workspace. The
// workspace's background guide agent reads a ReviewChangeSet plus the knowledge
// graph and emits a ReviewBrief that passes validation — steps ordered for
// understanding, a per-file why, narration, and annotations. The guide explains
// and organizes; it never judges, so nothing here produces verdicts.
//
// This service is built ON the companion-agent surface (MC-1684): it attaches a
// 'review-guide' companion and drives runStructured with the brief validator +
// checkBriefMatchesChangeSet. There is deliberately NO bespoke session plumbing
// here — spawn, retry, interrupt, and JSON extraction all live in the companion
// service. Node/Electron-main only; the renderer reaches it through review IPC.

import { mkdir, readFile, rename, unlink, writeFile } from 'fs/promises'
import { randomUUID } from 'crypto'
import { homedir } from 'os'
import { join } from 'path'
import {
  checkBriefMatchesChangeSet,
  validateReviewBrief,
  type ReviewBrief,
  type ReviewChangeSet,
} from '../../shared/review'
import { homePathLeak } from '../../shared/review/pathSafety'
import {
  CompanionValidationError,
  type CompanionAgentHandle,
  type CompanionAgentService,
  type CompanionValidateResult,
} from '../companion-agent-service'
import { ReviewChangeSetService, reviewChangeSetDir } from './changeset-service'
import {
  guideRunRegistry,
  type GuideRunPhase,
  type GuideRunRecorder,
  type GuideRunRegistry,
  type GuideRunStatus,
} from './guide-run-registry'
import {
  buildGuideChatSystemPrompt,
  buildGuideRerunPrompt,
  buildGuideRunPrompt,
  guideSystemPrompt,
  type BriefRunDepth,
} from './guide-prompt'

export type { BriefRunDepth }

// The IPC channel the review module forwards BriefRunEvent over. Exported so the
// host wiring and the renderer bridge name it from one place.
export const BRIEF_RUN_EVENT_CHANNEL = 'review:brief-run-event'

const BRIEF_FILE = 'brief.json'
// Stable projection key: one guide companion per workspace, so a second attach
// returns the same handle and the one-writer rule enforces one live run.
const GUIDE_AGENT_ID = 'review-guide'
const GUIDE_AGENT_NAME = 'Guide'

// Honest run progress the panel renders. `reading` loads the changeset;
// `grouping` is the guide generating (a retry re-enters it); `annotating` is the
// produced brief being validated (its annotations and coverage cross-checked);
// `writing` persists; `done`/`failed` are terminal. A single generation turn is
// opaque, so these are coarse milestones, never inferred sub-steps. Owned by the
// guide-run registry so the live event stream and the polled run status speak
// the same vocabulary.
export type BriefRunPhase = GuideRunPhase

export interface BriefRunEvent {
  workspaceId: string
  phase: BriefRunPhase
  detail?: string
}

export interface ReviewBriefRunInput {
  workspaceId: string
  workspaceRoot: string
  depth: BriefRunDepth
  // A freshness re-run (MC-1682): the ids of the steps whose files changed since
  // the previous walkthrough. When present and a previous brief exists on disk,
  // the run is incremental — unaffected steps are carried over verbatim (stable
  // ids) and only the affected ones regenerate. Absent = a full first run.
  affectedStepIds?: string[]
  // Replace a run that is already in flight. Without it a start against a live
  // run joins: it reports that run's status and leaves it alone, so pressing
  // Prepare twice never kills work in progress. The freshness re-run sets it,
  // because its whole point is to rebuild against the moved head.
  restart?: boolean
}

export interface ReviewAskGuideInput {
  workspaceId: string
  workspaceRoot: string
  message: string
}

// Sending a chat turn to the guide never fails validation (it is free prose, not
// a brief); it only fails if the guide could not run at all.
export type ReviewAskResult = { ok: true } | { ok: false; error: string }

// Why a run ended without a brief. `validation` = the guide's output failed the
// brief validators on every allowed attempt; `guide-error` = the guide could not
// run at all (no engine installed, session start failed, turn failed, or the run
// was interrupted). Both are visible failures — never a silent fallback.
export type BriefRunFailureReason = 'validation' | 'guide-error'

export type BriefRunResult =
  | { ok: true; brief: ReviewBrief; path: string }
  // Joined an already-live run instead of starting a second one. No brief was
  // produced by this call; the caller follows the run through its phase events.
  | { ok: true; joined: true; status: GuideRunStatus }
  | { ok: false; reason: BriefRunFailureReason; errors: string[] }

export interface ReviewBriefRunServiceDeps {
  companionAgents: Pick<CompanionAgentService, 'attach'>
  changeSets: Pick<ReviewChangeSetService, 'read'>
  // Sink for review:brief-run-event. The review module wires this to the
  // renderer over IPC; tests capture the events.
  emit: (event: BriefRunEvent) => void
  // Run state of record. Defaults to the process-wide registry the review IPC
  // reads back; tests inject their own so runs never leak between cases.
  guideRuns?: GuideRunRegistry
}

export class ReviewBriefRunService {
  private readonly companionAgents: Pick<CompanionAgentService, 'attach'>
  private readonly changeSets: Pick<ReviewChangeSetService, 'read'>
  private readonly emit: (event: BriefRunEvent) => void
  private readonly guideRuns: GuideRunRegistry
  private readonly handles = new Map<string, CompanionAgentHandle>()

  constructor(deps: ReviewBriefRunServiceDeps) {
    this.companionAgents = deps.companionAgents
    this.changeSets = deps.changeSets
    this.emit = deps.emit
    this.guideRuns = deps.guideRuns ?? guideRunRegistry
  }

  // Start (or join) the guide run for a workspace. One live run per workspace:
  // a start against a run already in flight joins it and reports its status,
  // unless `restart` was asked for, in which case the live run is interrupted
  // and replaced. On success the brief is persisted atomically and returned; on
  // a double validation failure or a guide error the run fails visibly, carrying
  // the errors, and the previous brief.json (if any) is left untouched.
  async start(input: ReviewBriefRunInput): Promise<BriefRunResult> {
    const { workspaceId, workspaceRoot, depth, affectedStepIds, restart } = input
    const targetDir = reviewChangeSetDir(workspaceRoot, workspaceId)

    // Join, don't kill: a second Prepare (a remount, an impatient click) reports
    // the live run rather than throwing away the work it has already done. The
    // registry, not a local flag, answers "is one live" — it is the same answer
    // the status IPC gives the renderer, and it survives whoever started the run.
    const live = this.guideRuns.status(workspaceId)
    if (live?.running && !restart) return { ok: true, joined: true, status: live }

    // A restart cancels the run already in flight. The canceled run's start()
    // promise rejects into its own catch; it wrote nothing (writing is the last
    // step), so any earlier brief.json survives.
    if (live?.running) this.handles.get(workspaceId)?.interrupt()

    // This run's own recorder: phases it reports late (an interrupted run
    // failing on its way out) never land on the run that replaced it.
    const recorder = this.guideRuns.begin(workspaceId)

    // Every path out of a begun run ends on a terminal phase, including a throw
    // from reading the change set or attaching the companion. A run left marked
    // live would make every later start join a run that is already dead.
    try {
      this.emitPhase(recorder, workspaceId, 'reading')

      const read = await this.changeSets.read(targetDir)
      if (!read.ok) return this.fail(recorder, workspaceId, 'guide-error', [read.error])
      if (!read.changeset) {
        return this.fail(recorder, workspaceId, 'guide-error', [
          'No change set has been ingested for this workspace yet.',
        ])
      }
      const changeset = read.changeset

      // A re-run reuses the previous walkthrough so unaffected steps keep their ids.
      // If the previous brief is missing or unreadable, fall back to a full run
      // rather than failing — a full walkthrough is always a valid result.
      const previousBrief = affectedStepIds ? await this.readPreviousBrief(targetDir) : null
      const prompt =
        previousBrief && affectedStepIds
          ? buildGuideRerunPrompt(changeset, depth, previousBrief, affectedStepIds)
          : buildGuideRunPrompt(changeset, depth)

      const handle = this.companionAgents.attach({
        workspaceId,
        agentId: GUIDE_AGENT_ID,
        name: GUIDE_AGENT_NAME,
        workspaceRoot,
        contextRoots: { knowledge: true },
        systemPrompt: guideSystemPrompt(),
      })
      this.handles.set(workspaceId, handle)

      const brief = await handle.runStructured<ReviewBrief>({
        prompt,
        validate: (raw) => this.validateBrief(raw, changeset),
        retries: 1,
        onPhase: (phase) => this.onCompanionPhase(recorder, workspaceId, phase),
      })
      this.emitPhase(recorder, workspaceId, 'writing')
      const briefPath = join(targetDir, BRIEF_FILE)
      await writeBriefAtomic(targetDir, brief)
      this.emitPhase(recorder, workspaceId, 'done')
      return { ok: true, brief, path: briefPath }
    } catch (error) {
      if (error instanceof CompanionValidationError) {
        return this.fail(recorder, workspaceId, 'validation', error.errors)
      }
      return this.fail(recorder, workspaceId, 'guide-error', [messageOf(error)])
    }
  }

  // Cancel a workspace's in-flight guide run. No-op if nothing is running.
  interrupt(workspaceId: string): void {
    if (this.guideRuns.status(workspaceId)?.running) this.handles.get(workspaceId)?.interrupt()
  }

  // "Ask the guide": send one chat turn to the SAME 'review-guide' companion the
  // brief run used. attach is idempotent on (workspaceId, agentId), so when the
  // brief-run session is still live this continues that thread with its full
  // context; when it is gone (a fresh app session, history pruned) the companion
  // cold-load contract spawns a new session on this first send, seeded with the
  // chat preamble that points it at the on-disk change + walkthrough. The reply
  // streams back over the conversation event channel the chat pane already
  // observes — this only kicks the turn off. The guide answers; it never writes a
  // comment or touches the code.
  async ask(input: ReviewAskGuideInput): Promise<ReviewAskResult> {
    const { workspaceId, workspaceRoot, message } = input
    const reviewDirRelative = `.multi-code/review/${workspaceId}`
    const handle = this.companionAgents.attach({
      workspaceId,
      agentId: GUIDE_AGENT_ID,
      name: GUIDE_AGENT_NAME,
      workspaceRoot,
      contextRoots: { knowledge: true },
      systemPrompt: buildGuideChatSystemPrompt(reviewDirRelative),
    })
    this.handles.set(workspaceId, handle)
    try {
      await handle.send(message)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: messageOf(error) }
    }
  }

  // Read the walkthrough currently on disk, to seed an incremental re-run.
  private readPreviousBrief(targetDir: string): Promise<ReviewBrief | null> {
    return readBriefFromDir(targetDir)
  }

  // Shape + cross-check the guide's JSON. A failure here feeds the errors back to
  // the guide and retries the turn (companion runStructured), so a near-miss is
  // corrected rather than dropped. A severity-like annotation kind is caught by
  // validateReviewBrief's enum check — the guide cannot smuggle a verdict in.
  private validateBrief(raw: unknown, changeset: ReviewChangeSet): CompanionValidateResult<ReviewBrief> {
    const shape = validateReviewBrief(raw)
    if (!shape.ok) return { ok: false, errors: shape.errors }
    const match = checkBriefMatchesChangeSet(shape.value, changeset)
    if (!match.ok) return { ok: false, errors: match.errors }
    const leak = homePathLeak(shape.value, homedir())
    if (leak) return { ok: false, errors: [leak] }
    return { ok: true, value: shape.value }
  }

  // Map the companion's generic run phases onto the brief's semantic milestones.
  private onCompanionPhase(recorder: GuideRunRecorder, workspaceId: string, phase: string): void {
    if (phase === 'running') this.emitPhase(recorder, workspaceId, 'grouping')
    else if (phase === 'retrying') this.emitPhase(recorder, workspaceId, 'grouping', 'retrying')
    else if (phase === 'validating') this.emitPhase(recorder, workspaceId, 'annotating')
  }

  // Every phase goes to both sinks: the registry (survives the renderer) and the
  // event channel (drives a panel that is already open). A run the registry has
  // already replaced goes silent on both — otherwise an interrupted run's parting
  // `failed` would tell an open panel the live replacement had died.
  private emitPhase(
    recorder: GuideRunRecorder,
    workspaceId: string,
    phase: BriefRunPhase,
    detail?: string
  ): void {
    if (!recorder.record(phase, detail)) return
    this.emit(detail ? { workspaceId, phase, detail } : { workspaceId, phase })
  }

  private fail(
    recorder: GuideRunRecorder,
    workspaceId: string,
    reason: BriefRunFailureReason,
    errors: string[]
  ): BriefRunResult {
    const safe = errors.length > 0 ? errors : ['The guide run failed.']
    this.emitPhase(recorder, workspaceId, 'failed', safe[0])
    return { ok: false, reason, errors: safe }
  }
}

export function createReviewBriefRunService(deps: ReviewBriefRunServiceDeps): ReviewBriefRunService {
  return new ReviewBriefRunService(deps)
}

// Read the walkthrough currently on disk. Any problem (missing file, bad JSON,
// invalid shape) returns null so a caller falls back to a full run — a re-run or a
// plain read never fails just because the old brief is unusable. Shared with the
// review MCP tools (review_get_brief) so both readers agree on "no usable brief".
export async function readBriefFromDir(targetDir: string): Promise<ReviewBrief | null> {
  let raw: string
  try {
    raw = await readFile(join(targetDir, BRIEF_FILE), 'utf-8')
  } catch {
    return null
  }
  try {
    const parsed = validateReviewBrief(JSON.parse(raw))
    return parsed.ok ? parsed.value : null
  } catch {
    return null
  }
}

// Write-temp-then-rename, mirroring the changeset service: a crash mid-write
// leaves the prior brief.json (or nothing) intact rather than a truncated file.
// Exported so the review MCP tools (review_submit_brief) land the brief through
// the same atomic writer the companion path uses.
export async function writeBriefAtomic(targetDir: string, brief: ReviewBrief): Promise<void> {
  await mkdir(targetDir, { recursive: true })
  const finalPath = join(targetDir, BRIEF_FILE)
  const tempPath = join(targetDir, `.${BRIEF_FILE}.${randomUUID()}.tmp`)
  const data = `${JSON.stringify(brief, null, 2)}\n`
  try {
    await writeFile(tempPath, data, 'utf-8')
    await rename(tempPath, finalPath)
  } catch (error) {
    await unlink(tempPath).catch(() => {})
    throw error
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
