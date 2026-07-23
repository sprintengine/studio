// The review guide as an ordinary terminal agent (MC-1783).
//
// The guide used to run on the companion/conversation path: Claude-only, hidden
// from the session manager, and driven by a stream-scraping harness. It now runs
// as a plain agent terminal in the project workspace the review belongs to,
// under whichever CLI the reviewer picked, with the `review-guide` builtin skill
// attached at spawn and the walkthrough delivered through the Studio gateway's
// `review_submit_brief` tool. Nothing here parses the guide's output.
//
// Where the spawn happens: the app's programmatic agent-terminal seam is the
// terminal runtime's spawn handler (the same one the sprint scheduler drives
// in-process), reached here through injected ports so this module stays free of
// Electron. The renderer owns only the AgentState that makes the terminal
// openable as a tab — it reads the agent/session coordinates off this service's
// result, exactly as the session-manager reattach path does.
//
// Progress is tool-call and file truth, never inferred from output:
//   - `reading` when the terminal is spawned or the prompt is delivered,
//   - `grouping` once the guide has the prompt and is working,
//   - `done` when `review_submit_brief` lands (recorded by the gateway),
//   - `failed` when the terminal ends without a brief, or the reviewer stops it.
// Every phase goes to the guide-run registry (which outlives the renderer) and
// the BriefRunEvent channel, so a remount rediscovers a live run.

import { resolve } from 'path'

import type {
  McpSettings,
  ReviewBriefRunDepth,
  TerminalSessionSnapshot,
  TerminalSpawnResult,
} from '../../shared/electron-api'
import { bracketedTerminalPaste } from '../../shared/sprintengine/auto-run-executor'
import type { TerminalSpawnPayload } from '../ipc/terminal-ipc'
import type { BriefRunEvent } from './brief-run-service'
import {
  guideRunRegistry,
  type GuideRunPhase,
  type GuideRunRecorder,
  type GuideRunRegistry,
  type GuideRunStatus,
} from './guide-run-registry'

// The builtin skill that carries every word of the guide's craft and contract
// (MC-1782). It is attached at spawn, so this module never states any of it.
export const REVIEW_GUIDE_SKILL_ID = 'review-guide'
// Session-manager label for the guide's terminal.
export const REVIEW_GUIDE_AGENT_NAME = 'Review guide'
// Where the skill always lands, whatever the CLI: the harness-neutral copy the
// builtin skill manager installs alongside any native ones. Named in the join
// prompt for CLIs whose plugin declares no native skill invocation, so the guide
// can read its own instructions instead of running without them.
const REVIEW_GUIDE_SKILL_FILE = `.agents/skills/${REVIEW_GUIDE_SKILL_ID}/SKILL.md`

// A review id is the on-disk directory name and becomes this agent's id; hold it
// to the same shape the change-set service and the review MCP tools enforce.
const REVIEW_ID_PATTERN = /^[A-Za-z0-9._-]+$/

// Terminal geometry for a session no view has bound yet. The reviewer's terminal
// resizes it on open; this only has to be wide enough that the CLI's own startup
// output is not wrapped into nonsense in the retained scrollback.
const GUIDE_TERMINAL_COLS = 120
const GUIDE_TERMINAL_ROWS = 30

// Bracketed paste, then Enter. Mirrors the sprint auto-run dispatch: a CLI TUI
// needs the paste to settle before the submit or the first line is swallowed.
const PROMPT_SUBMIT_DELAY_MS = 50

// The two ways a guide run ends without a brief. Both point at the terminal,
// because that is where the reason actually is.
const ENDED_WITHOUT_BRIEF_DETAIL =
  'The guide session ended without delivering a walkthrough — its terminal has the details.'
const STOPPED_DETAIL = 'You stopped the guide.'

// One guide agent per review, deterministic in both directions: the terminal
// session id equals the agent id, so a second start finds the live terminal
// instead of spawning a twin, and the renderer can reattach a tab to it.
export function reviewGuideAgentId(reviewId: string): string {
  return `review-guide-${reviewId}`
}

// The coordinates a caller needs to show or focus the guide's terminal.
export interface GuideTerminalHandle {
  workspaceId: string
  agentId: string
  sessionId: string
  cli: string
}

export type GuideRunStartResult =
  | { ok: true; guide: GuideTerminalHandle; reused: boolean }
  // A run was already in flight and this start reported it instead of replacing
  // it: pressing Prepare twice never spawns a second guide.
  | { ok: true; joined: true; status: GuideRunStatus; guide: GuideTerminalHandle }
  | { ok: false; error: string }

export type GuideAskResult =
  | { ok: true; guide: GuideTerminalHandle }
  | { ok: false; error: string }

export interface GuideRunStartInput {
  reviewId: string
  projectRoot: string
  depth: ReviewBriefRunDepth
  // Freshness re-run: the ids of the steps whose files moved. The guide carries
  // every other step over verbatim.
  affectedStepIds?: string[]
  cli?: string
  cliModel?: string
  // Replace a run already in flight instead of joining it.
  restart?: boolean
}

export interface GuideAskInput {
  reviewId: string
  projectRoot: string
  question: string
  cli?: string
  cliModel?: string
}

// A live agent session's exit, as reported by the terminal runtime.
export interface GuideAgentExit {
  agentId?: string
  executionId: string
  exitCode: number
}

// Everything this service touches outside itself. Injected so the module stays
// free of Electron and the workspace store, and so contract tests drive a fake
// terminal runtime rather than a real pty.
export interface GuideTerminalDeps {
  // Workspaces currently open in the app, from the workspace-sync snapshot. The
  // guide runs in the one whose folder is the review's project root.
  listWorkspaces: () => ReadonlyArray<{ id: string; folderPath?: string | null; mode?: string }>
  terminal: {
    list: () => TerminalSessionSnapshot[]
    spawn: (payload: TerminalSpawnPayload) => Promise<TerminalSpawnResult>
    write: (sessionId: string, data: string) => void
    kill: (sessionId: string) => void
    setReapExempt: (sessionId: string, exempt: boolean) => void
    // Fires when any agent session's process exits — the watchdog's only input.
    onAgentSessionExit: (listener: (event: GuideAgentExit) => void) => () => void
  }
  // The CLI-native explicit invocation for the guide skill (`/review-guide` for
  // Claude, `Use $review-guide.` for Codex), or undefined for a CLI whose plugin
  // declares no native skill support.
  resolveSkillInvocation: (cli: string) => string | undefined
  // Launch inputs the renderer mirrors into main: the user's CLI command/WSL
  // overrides and MCP servers. Without them a custom CLI command is ignored.
  launchSettings?: () => { cliRuntimes?: Record<string, { command: string; useWsl: boolean }>; mcp?: McpSettings }
  // Sink for review:brief-run-event, broadcast to every window by the caller.
  emit: (event: BriefRunEvent) => void
  // Run state of record. Defaults to the process-wide registry the status IPC
  // reads back; tests inject their own.
  guideRuns?: GuideRunRegistry
  // Overridable only so tests do not sleep for the paste-submit delay.
  delay?: (ms: number) => Promise<void>
}

// What the watchdog needs to know about a review's open run: the terminal it is
// waiting on, and the recorder that run's phases belong to.
interface InFlightRun {
  executionId: string
  recorder: GuideRunRecorder
}

export class ReviewGuideTerminalService {
  private readonly deps: GuideTerminalDeps
  private readonly guideRuns: GuideRunRegistry
  // At most ONE open run per review, so starting a run replaces (and thereby
  // clears) whatever the review had before — no record accumulates. The entry
  // remembers the terminal's EXECUTION id, which is unique per pty unlike the
  // deliberately stable session id, so a replaced terminal's exit is recognised
  // as belonging to a run that is over and can never fail its successor.
  private readonly inFlight = new Map<string, InFlightRun>()
  private nextExecution = 1
  private readonly stopWatchdog: () => void

  constructor(deps: GuideTerminalDeps) {
    this.deps = deps
    this.guideRuns = deps.guideRuns ?? guideRunRegistry
    this.stopWatchdog = deps.terminal.onAgentSessionExit((event) => this.onAgentExit(event))
  }

  // Release the exit listener. Called when the review module tears down, so a
  // disable/enable cycle never leaves a listener pointed at a dead service.
  dispose(): void {
    this.stopWatchdog()
  }

  // Start (or join) the guide run for a review. One guide terminal per review:
  // a live terminal receives the new prompt, otherwise one is spawned. A start
  // against a run already in flight reports that run instead of interrupting it,
  // unless the caller asked for a restart (the freshness re-run does).
  async startRun(input: GuideRunStartInput): Promise<GuideRunStartResult> {
    const { reviewId, projectRoot, depth, affectedStepIds, restart } = input
    const invalid = validateTarget(reviewId, projectRoot)
    if (invalid) return { ok: false, error: invalid }

    const live = this.guideRuns.status(reviewId)
    if (live?.running && !restart) {
      const joined = this.currentHandle(reviewId)
      // A registry entry that outlived its terminal (the app restarted, the
      // session was reaped) is not a run anyone can join — fall through and
      // start a fresh one rather than reporting a run with nothing behind it.
      if (joined) return { ok: true, joined: true, status: live, guide: joined }
    }

    // Every path out of here reaches a terminal phase: a run left marked live
    // would make every later start join a run that is already dead.
    const recorder = this.guideRuns.begin(reviewId)
    const prepared = this.prepareTerminal(reviewId, projectRoot, input.cli)
    if (!prepared.ok) return this.fail(recorder, reviewId, prepared.error)

    const prompt = this.buildRunPrompt({
      reviewId,
      projectRoot: prepared.projectRoot,
      depth,
      affectedStepIds,
      cli: prepared.handle.cli,
    })
    this.emitPhase(recorder, reviewId, 'reading')

    const delivered = await this.deliver(prepared, prompt, input.cliModel)
    if (!delivered.ok) return this.fail(recorder, reviewId, delivered.error)

    // The guide owns the terminal until it delivers: the idle reaper must not
    // suspend a session that is mid-walkthrough.
    this.deps.terminal.setReapExempt(prepared.handle.sessionId, true)
    this.inFlight.set(reviewId, { executionId: prepared.executionId, recorder })
    this.emitPhase(recorder, reviewId, 'grouping')
    return { ok: true, guide: prepared.handle, reused: delivered.reused }
  }

  // "Ask the guide": send one question to the review's guide terminal, spawning
  // it when none is live. The answer is read in the terminal — that is the point
  // of the redesign — so this reports only where to look, never a reply. Asking
  // is not a run: it records no phase and never touches an in-flight walkthrough.
  async ask(input: GuideAskInput): Promise<GuideAskResult> {
    const { reviewId, projectRoot, question } = input
    const invalid = validateTarget(reviewId, projectRoot)
    if (invalid) return { ok: false, error: invalid }
    if (question.trim().length === 0) return { ok: false, error: 'Ask the guide a question first.' }

    const prepared = this.prepareTerminal(reviewId, projectRoot, input.cli)
    if (!prepared.ok) return { ok: false, error: prepared.error }

    const prompt = this.buildAskPrompt({
      reviewId,
      projectRoot: prepared.projectRoot,
      question: question.trim(),
      cli: prepared.handle.cli,
    })
    const delivered = await this.deliver(prepared, prompt, input.cliModel)
    if (!delivered.ok) return { ok: false, error: delivered.error }
    return { ok: true, guide: prepared.handle }
  }

  // The reviewer stopped the run. Kill the guide's terminal and record the stop
  // as this run's terminal phase, so the panel shows why it ended and the
  // watchdog stays silent for the exit it is about to see.
  stop(reviewId: string): void {
    const sessionId = reviewGuideAgentId(reviewId)
    const entry = this.inFlight.get(reviewId)
    this.inFlight.delete(reviewId)
    if (entry) this.emitPhase(entry.recorder, reviewId, 'failed', STOPPED_DETAIL)
    else if (this.guideRuns.status(reviewId)?.running) {
      // A run this process did not start (a registry record adopted from the
      // review tools) still ends when the reviewer stops its terminal.
      this.guideRuns.record(reviewId, 'failed', STOPPED_DETAIL)
      this.deps.emit({ workspaceId: reviewId, phase: 'failed', detail: STOPPED_DETAIL })
    }
    this.deps.terminal.setReapExempt(sessionId, false)
    this.deps.terminal.kill(sessionId)
  }

  // The watchdog. A guide terminal that ends without a brief failed, whatever
  // the reason — a crashed CLI, a closed tab, an agent that gave up. The
  // registry, not this map, decides whether the run is still open: a brief that
  // landed through review_submit_brief already closed it, and the terminal
  // exiting afterwards is just the CLI quitting.
  private onAgentExit(event: GuideAgentExit): void {
    const found = [...this.inFlight].find(([, entry]) => entry.executionId === event.executionId)
    if (!found) return
    const [reviewId, entry] = found
    this.inFlight.delete(reviewId)
    this.deps.terminal.setReapExempt(reviewGuideAgentId(reviewId), false)
    if (!this.guideRuns.status(reviewId)?.running) return
    this.emitPhase(entry.recorder, reviewId, 'failed', ENDED_WITHOUT_BRIEF_DETAIL)
  }

  // Resolve the workspace, the CLI, and the live-or-fresh terminal for a review.
  private prepareTerminal(
    reviewId: string,
    projectRoot: string,
    requestedCli: string | undefined
  ): PreparedTerminal | { ok: false; error: string } {
    const normalizedRoot = resolve(projectRoot)
    const workspace = this.findProjectWorkspace(normalizedRoot)
    if (!workspace) {
      // The degraded walkthrough keeps the review readable; only the guide needs
      // the project open, and saying so is the whole fix.
      return { ok: false, error: 'Open the project to run the guide.' }
    }

    const sessionId = reviewGuideAgentId(reviewId)
    const existing = this.deps.terminal.list().find((session) => session.sessionId === sessionId)
    const liveSession = existing && existing.processAlive && !existing.suspended ? existing : null
    const cli = requestedCli?.trim() || liveSession?.cli || this.lastAgentCli(workspace.id)
    if (!cli) {
      return { ok: false, error: 'Choose which agent CLI should run the review guide.' }
    }

    return {
      ok: true,
      projectRoot: normalizedRoot,
      liveSession: liveSession !== null,
      // A retained session whose process is gone (exited, or suspended by the
      // reaper) must be disposed before a fresh spawn: the runtime reattaches to
      // any session it still holds under this id, and would launch nothing.
      staleSession: existing !== undefined && liveSession === null,
      // A reused terminal keeps the execution id it was spawned with — that is
      // the id its exit will carry. A fresh one gets a new id, so the pty being
      // replaced cannot be mistaken for the one taking its place.
      executionId: liveSession?.agentSession?.executionId ?? `${sessionId}#${this.nextExecution++}`,
      handle: { workspaceId: workspace.id, agentId: sessionId, sessionId, cli },
    }
  }

  // Deliver a prompt to the guide: paste it into the live terminal, or spawn one
  // with the prompt as its opening input.
  private async deliver(
    prepared: PreparedTerminal,
    prompt: string,
    cliModel: string | undefined
  ): Promise<{ ok: true; reused: boolean } | { ok: false; error: string }> {
    const { handle } = prepared
    if (prepared.liveSession) {
      this.deps.terminal.write(handle.sessionId, bracketedTerminalPaste(prompt))
      await (this.deps.delay ?? sleep)(PROMPT_SUBMIT_DELAY_MS)
      this.deps.terminal.write(handle.sessionId, '\r')
      return { ok: true, reused: true }
    }

    // A retained record under this id has to go before a fresh spawn, or the
    // runtime reattaches to it and launches nothing. Its pty exit arrives after
    // this one starts, which is exactly why in-flight runs are keyed by
    // execution id: the dead terminal's exit cannot touch the new run.
    if (prepared.staleSession) this.deps.terminal.kill(handle.sessionId)

    const settings = this.deps.launchSettings?.()
    const spawned = await this.deps.terminal.spawn({
      sessionId: handle.sessionId,
      cols: GUIDE_TERMINAL_COLS,
      rows: GUIDE_TERMINAL_ROWS,
      cwd: prepared.projectRoot,
      cli: handle.cli,
      initialPrompt: prompt,
      ...(settings?.cliRuntimes ? { cliRuntimes: settings.cliRuntimes } : {}),
      ...(settings?.mcp ? { mcpSettings: settings.mcp } : {}),
      kind: 'agent',
      workspaceId: handle.workspaceId,
      agentId: handle.agentId,
      agentName: REVIEW_GUIDE_AGENT_NAME,
      // The guide reads the change, the surrounding code, and the knowledge
      // graph, then calls the review tools — unattended. On the default preset
      // it stalls at the first approval prompt with nobody watching, so it runs
      // with the same preset the Design Wizard's unattended specialists use.
      cliPermissionPreset: 'bypass_all',
      ...(cliModel?.trim() ? { cliModel: cliModel.trim() } : {}),
      // Installs the skill into this CLI's native skill dir before launch, so
      // the invocation in the prompt resolves to a skill that is really there.
      spawnSkillId: REVIEW_GUIDE_SKILL_ID,
      // No view is bound to this session yet; the reviewer opens it from the
      // session manager (or the run banner's link) when they want to watch.
      visible: false,
      // Gives the runtime an execution identity, which is what makes it report
      // this session's exit to the watchdog.
      agentSession: {
        executionId: prepared.executionId,
        system: 'manual',
        workspaceId: handle.workspaceId,
        workspaceRoot: prepared.projectRoot,
        workId: handle.agentId,
        role: 'review-guide',
        displayName: REVIEW_GUIDE_AGENT_NAME,
      },
    })
    if (!spawned.ok) return { ok: false, error: spawned.message ?? 'The guide terminal could not start.' }
    return { ok: true, reused: false }
  }

  // The join prompt carries ONLY run coordinates. Every word about what a
  // walkthrough is and how to build one lives in the skill.
  private buildRunPrompt(input: {
    reviewId: string
    projectRoot: string
    depth: ReviewBriefRunDepth
    affectedStepIds?: string[]
    cli: string
  }): string {
    const refresh = input.affectedStepIds?.length
      ? [`Refresh: regenerate only these steps, carry the rest over verbatim: ${input.affectedStepIds.join(', ')}`]
      : []
    return [
      this.skillLead(input.cli),
      '',
      'You are the Review guide for this review. Build its walkthrough and deliver it with review_submit_brief.',
      '',
      `Review: ${input.reviewId}`,
      `Project root: ${input.projectRoot}`,
      `Depth: ${input.depth}`,
      ...refresh,
    ].join('\n')
  }

  private buildAskPrompt(input: {
    reviewId: string
    projectRoot: string
    question: string
    cli: string
  }): string {
    return [
      this.skillLead(input.cli),
      '',
      'You are the Review guide for this review. This is a question from the reviewer, not a request for a',
      'walkthrough: answer it in this terminal and submit nothing.',
      '',
      `Review: ${input.reviewId}`,
      `Project root: ${input.projectRoot}`,
      '',
      `Question: ${input.question}`,
    ].join('\n')
  }

  // How the guide gets its instructions. A CLI with native skill support is
  // handed its own invocation; one without is pointed at the installed skill
  // file, which the spawn just wrote into the project. Either way the craft text
  // reaches the agent from the skill and is never restated here.
  private skillLead(cli: string): string {
    return (
      this.deps.resolveSkillInvocation(cli)
      ?? `Read ${REVIEW_GUIDE_SKILL_FILE} and follow it for this whole session.`
    )
  }

  // The open workspace whose folder is this project. A project folder can host
  // more than one workspace (an automations host, a sprint run); the standard
  // one is where a person's agents live, so prefer it and fall back to any.
  private findProjectWorkspace(projectRoot: string): { id: string } | null {
    const matches = this.deps
      .listWorkspaces()
      .filter((workspace) => normalizeFolder(workspace.folderPath) === projectRoot)
    return matches.find((workspace) => workspace.mode === 'standard') ?? matches[0] ?? null
  }

  // The CLI a live guide terminal is already running, or the one the reviewer
  // last used for an agent in this workspace. Only a guess for a caller that
  // named none; when there is nothing to go on, the start fails visibly.
  private lastAgentCli(workspaceId: string): string | undefined {
    return this.deps.terminal
      .list()
      .filter((session) => session.kind === 'agent' && session.workspaceId === workspaceId && session.cli)
      .sort((left, right) => right.startedAt - left.startedAt)[0]?.cli
  }

  // The terminal a joinable run is running in, or null when nothing is live
  // under this review's guide id.
  private currentHandle(reviewId: string): GuideTerminalHandle | null {
    const sessionId = reviewGuideAgentId(reviewId)
    const session = this.deps.terminal
      .list()
      .find((candidate) => candidate.sessionId === sessionId && candidate.processAlive)
    if (!session) return null
    return {
      workspaceId: session.workspaceId ?? '',
      agentId: sessionId,
      sessionId,
      cli: session.cli ?? '',
    }
  }

  // Both sinks, one decision: the registry (which outlives the renderer) and the
  // live event channel. A run the registry has already replaced goes silent on
  // both, so a dying run never reports on the one that replaced it.
  private emitPhase(
    recorder: GuideRunRecorder,
    reviewId: string,
    phase: GuideRunPhase,
    detail?: string
  ): void {
    if (!recorder.record(phase, detail)) return
    this.deps.emit(detail ? { workspaceId: reviewId, phase, detail } : { workspaceId: reviewId, phase })
  }

  private fail(recorder: GuideRunRecorder, reviewId: string, error: string): GuideRunStartResult {
    this.emitPhase(recorder, reviewId, 'failed', error)
    return { ok: false, error }
  }
}

interface PreparedTerminal {
  ok: true
  projectRoot: string
  liveSession: boolean
  staleSession: boolean
  executionId: string
  handle: GuideTerminalHandle
}

export function createReviewGuideTerminalService(deps: GuideTerminalDeps): ReviewGuideTerminalService {
  return new ReviewGuideTerminalService(deps)
}

// Record a brief that landed through the Studio gateway's review_submit_brief
// against the run registry. The gateway broadcasts the event to open windows but
// knows nothing about runs, so without this a terminal guide would finish while
// the status IPC still reported it working — and every later start would join a
// run that already delivered.
export function recordGuideRunEvent(
  event: BriefRunEvent,
  registry: GuideRunRegistry = guideRunRegistry
): void {
  registry.record(event.workspaceId, event.phase, event.detail)
}

function validateTarget(reviewId: string, projectRoot: string): string | null {
  if (typeof reviewId !== 'string' || !REVIEW_ID_PATTERN.test(reviewId)) {
    return 'That review id is not a review this app can address.'
  }
  if (typeof projectRoot !== 'string' || projectRoot.trim().length === 0) {
    return 'Open the project to run the guide.'
  }
  return null
}

function normalizeFolder(folderPath: string | null | undefined): string | null {
  const trimmed = folderPath?.trim()
  return trimmed ? resolve(trimmed) : null
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms))
}
