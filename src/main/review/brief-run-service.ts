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
import {
  CompanionValidationError,
  type CompanionAgentHandle,
  type CompanionAgentService,
  type CompanionValidateResult,
} from '../companion-agent-service'
import { ReviewChangeSetService, reviewChangeSetDir } from './changeset-service'
import {
  GUIDE_SYSTEM_PROMPT,
  buildGuideChatSystemPrompt,
  buildGuideRerunPrompt,
  buildGuideRunPrompt,
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
// opaque, so these are coarse milestones, never inferred sub-steps.
export type BriefRunPhase = 'reading' | 'grouping' | 'annotating' | 'writing' | 'done' | 'failed'

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
  | { ok: false; reason: BriefRunFailureReason; errors: string[] }

export interface ReviewBriefRunServiceDeps {
  companionAgents: Pick<CompanionAgentService, 'attach'>
  changeSets: Pick<ReviewChangeSetService, 'read'>
  // Sink for review:brief-run-event. The review module wires this to the
  // renderer over IPC; tests capture the events.
  emit: (event: BriefRunEvent) => void
}

export class ReviewBriefRunService {
  private readonly companionAgents: Pick<CompanionAgentService, 'attach'>
  private readonly changeSets: Pick<ReviewChangeSetService, 'read'>
  private readonly emit: (event: BriefRunEvent) => void
  private readonly handles = new Map<string, CompanionAgentHandle>()
  private readonly inFlight = new Set<string>()

  constructor(deps: ReviewBriefRunServiceDeps) {
    this.companionAgents = deps.companionAgents
    this.changeSets = deps.changeSets
    this.emit = deps.emit
  }

  // Start (or restart) the guide run for a workspace. One live run per workspace:
  // an in-flight run is interrupted first, so the guide never writes two briefs
  // at once. On success the brief is persisted atomically and returned; on a
  // double validation failure or a guide error the run fails visibly, carrying
  // the errors, and the previous brief.json (if any) is left untouched.
  async start(input: ReviewBriefRunInput): Promise<BriefRunResult> {
    const { workspaceId, workspaceRoot, depth, affectedStepIds } = input
    const targetDir = reviewChangeSetDir(workspaceRoot, workspaceId)

    // One live run per workspace: cancel a run already in flight for it. The
    // canceled run's start() promise rejects into its own catch; it wrote
    // nothing (writing is the last step), so any earlier brief.json survives.
    const prior = this.handles.get(workspaceId)
    if (prior && this.inFlight.has(workspaceId)) prior.interrupt()

    this.emitPhase(workspaceId, 'reading')

    const read = await this.changeSets.read(targetDir)
    if (!read.ok) return this.fail(workspaceId, 'guide-error', [read.error])
    if (!read.changeset) {
      return this.fail(workspaceId, 'guide-error', [
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
      systemPrompt: GUIDE_SYSTEM_PROMPT,
    })
    this.handles.set(workspaceId, handle)
    this.inFlight.add(workspaceId)

    try {
      const brief = await handle.runStructured<ReviewBrief>({
        prompt,
        validate: (raw) => this.validateBrief(raw, changeset),
        retries: 1,
        onPhase: (phase) => this.onCompanionPhase(workspaceId, phase),
      })
      this.emitPhase(workspaceId, 'writing')
      const briefPath = join(targetDir, BRIEF_FILE)
      await writeBriefAtomic(targetDir, brief)
      this.emitPhase(workspaceId, 'done')
      return { ok: true, brief, path: briefPath }
    } catch (error) {
      if (error instanceof CompanionValidationError) {
        return this.fail(workspaceId, 'validation', error.errors)
      }
      return this.fail(workspaceId, 'guide-error', [messageOf(error)])
    } finally {
      this.inFlight.delete(workspaceId)
    }
  }

  // Cancel a workspace's in-flight guide run. No-op if nothing is running.
  interrupt(workspaceId: string): void {
    if (this.inFlight.has(workspaceId)) this.handles.get(workspaceId)?.interrupt()
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

  // Read the walkthrough currently on disk, to seed an incremental re-run. Any
  // problem (missing file, bad JSON, invalid shape) returns null so the caller
  // falls back to a full run — a re-run never fails just because the old brief is
  // unusable.
  private async readPreviousBrief(targetDir: string): Promise<ReviewBrief | null> {
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

  // Shape + cross-check the guide's JSON. A failure here feeds the errors back to
  // the guide and retries the turn (companion runStructured), so a near-miss is
  // corrected rather than dropped. A severity-like annotation kind is caught by
  // validateReviewBrief's enum check — the guide cannot smuggle a verdict in.
  private validateBrief(raw: unknown, changeset: ReviewChangeSet): CompanionValidateResult<ReviewBrief> {
    const shape = validateReviewBrief(raw)
    if (!shape.ok) return { ok: false, errors: shape.errors }
    const match = checkBriefMatchesChangeSet(shape.value, changeset)
    if (!match.ok) return { ok: false, errors: match.errors }
    const leak = homePathLeak(shape.value)
    if (leak) return { ok: false, errors: [leak] }
    return { ok: true, value: shape.value }
  }

  // Map the companion's generic run phases onto the brief's semantic milestones.
  private onCompanionPhase(workspaceId: string, phase: string): void {
    if (phase === 'running') this.emitPhase(workspaceId, 'grouping')
    else if (phase === 'retrying') this.emitPhase(workspaceId, 'grouping', 'retrying')
    else if (phase === 'validating') this.emitPhase(workspaceId, 'annotating')
  }

  private emitPhase(workspaceId: string, phase: BriefRunPhase, detail?: string): void {
    this.emit(detail ? { workspaceId, phase, detail } : { workspaceId, phase })
  }

  private fail(workspaceId: string, reason: BriefRunFailureReason, errors: string[]): BriefRunResult {
    const safe = errors.length > 0 ? errors : ['The guide run failed.']
    this.emitPhase(workspaceId, 'failed', safe[0])
    return { ok: false, reason, errors: safe }
  }
}

export function createReviewBriefRunService(deps: ReviewBriefRunServiceDeps): ReviewBriefRunService {
  return new ReviewBriefRunService(deps)
}

// A brief walks project-relative paths; an absolute home-directory path inside it
// means the guide leaked a machine-specific path (or a secret carried through
// one), so the brief is rejected before it can be persisted or rendered.
function homePathLeak(brief: ReviewBrief): string | null {
  const home = homedir()
  if (!home) return null
  return JSON.stringify(brief).includes(home)
    ? `brief contains an absolute home-directory path; briefs must use project-relative paths.`
    : null
}

// Write-temp-then-rename, mirroring the changeset service: a crash mid-write
// leaves the prior brief.json (or nothing) intact rather than a truncated file.
async function writeBriefAtomic(targetDir: string, brief: ReviewBrief): Promise<void> {
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
