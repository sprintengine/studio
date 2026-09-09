import { existsSync } from 'fs'
import { copyFile, mkdir, readFile, rm, writeFile } from 'fs/promises'
import { homedir } from 'os'
import { join, resolve, sep } from 'path'
import type { AgentPhase, AgentStateSource, SessionActivity } from '../shared/electron-api'
import type { PluginAgentStateSpec } from '../shared/plugin-manifest'
import { isAbsoluteObservedPath, MAX_OBSERVED_CWD_LENGTH } from '../shared/observed-checkout'
import { isRecord } from '../shared/records'
import { parsePullRequestUrl } from '../shared/review/pr-url'
import type { ChangelistEdit } from '../shared/git/changelists'
import { resolveClaudeConfigDir } from './conversation-peek/locate'

// =============================================================================
// Authoritative agent state — pure core (no Electron deps, fully unit-testable)
//
// This module owns three concerns that need no main-process runtime:
//   1. Resolving a reporter frame against a CLI's manifest-declared
//      `agentStateSpec` (event → AgentPhase, discriminators, turn-end flags).
//      The per-CLI vocabulary is DATA on each plugin manifest, never code here.
//   2. The AgentPhase → legacy SessionActivity bridge (so existing consumers
//      keep working untouched while the richer phase rides alongside).
//   3. Validating an untrusted reporter frame and (un)installing the reporter
//      into a workspace, dispatched by the spec's registration kind.
//
// The Electron-bound half (the socket listener + session resolution + renderer
// broadcast + launch-time install) lives in a sibling service module so this
// stays importable from a plain Node test harness.
// =============================================================================

export const AGENT_STATE_HOOK_TAG = 'multicode-agent-state'

// Where the reporter script is copied inside a workspace. The reporter also
// honours a MULTICODE_AGENT_STATE_SOCKET env fallback (see the .mjs), but the
// install always passes the socket via --socket, so it is not referenced here.
export const AGENT_STATE_HOOK_SCRIPT_REL = join('.multicode', 'hooks', 'agent-state.mjs')

// =============================================================================
// Frame resolution against a manifest agentStateSpec
//
// The reporter forwards the RAW event name (plus the payload discriminator
// fields the specs consult — today only `notificationType`); the mapping to a
// phase happens HERE, from the resolving plugin's manifest data. That keeps
// every CLI's vocabulary in one authored, validated place and out of the
// reporter scripts, which used to carry a second copy that had to be mirrored
// by hand.
//
// Turn-end and turn-failure ride the same table as per-event flags, raw-event-
// level deliberately: several events share a phase (Claude's Stop and
// SubagentStop both map to `idle`; OpenCode's session.error maps to `idle` like
// its session.idle), so only the event name can tell a session's turn end from
// a subagent's, or a crash from a clean finish. Consumers read the computed
// flags off the phase event, never event names.
// =============================================================================

export type AgentStateEventResolution =
  | { action: 'drop' }
  | { action: 'apply'; phase: AgentPhase; turnEnd: boolean; turnFailure: boolean; background?: 'start' | 'stop' }

export type AppliedAgentStateEvent = Extract<AgentStateEventResolution, { action: 'apply' }>

/**
 * Fold an event name to the form event matching compares on: lower-cased with
 * `_` and `-` removed, so `PreToolUse`, `pre_tool_use`, `pre-tool-use` and
 * `preToolUse` are all one event.
 *
 * Why this exists (MC-2520): a CLI's CONFIG spelling and its PAYLOAD spelling
 * need not agree. Grok Build reads `PreToolUse` in `.grok/hooks/*.json` (and
 * accepts the snake_case and Cursor camelCase spellings there too) but stamps
 * the payload `"hookEventName": "pre_tool_use"`. Matching the manifest's
 * PascalCase against that frame exactly dropped EVERY Grok frame, so a Grok
 * agent never left `starting` until the stall watch flagged it.
 *
 * One fold, not per-event aliases: an alias table is a second vocabulary to
 * maintain per CLI, and it is silently wrong for the next event nobody listed.
 * The manifests keep the CLI's own written spelling (Grok/Claude PascalCase,
 * Cursor camelCase, OpenCode dotted) — this only decides EQUALITY.
 *
 * `.` is deliberately NOT stripped: OpenCode's `session.idle` /
 * `tool.execute.before` are structured names whose dots separate real segments,
 * and folding them would collapse distinct events.
 *
 * Collision safety is a per-manifest property (two entries in ONE spec must not
 * fold together); every shipped manifest is checked by test, since the first
 * canonical match wins.
 */
export function canonicalEventName(event: string): string {
  return event.replace(/[_-]/g, '').toLowerCase()
}

// Read the frame field a discriminator NAMES, never a hardcoded one, so a
// widened field enum can't silently misread.
function discriminatorValue(
  field: 'notificationType' | 'status',
  frame: Pick<AgentStateFrame, 'notificationType' | 'status'>
): string | undefined {
  return field === 'notificationType' ? frame.notificationType : frame.status
}

export function resolveAgentStateEvent(
  spec: PluginAgentStateSpec | null | undefined,
  frame: Pick<AgentStateFrame, 'event' | 'phase' | 'notificationType' | 'status'>
): AgentStateEventResolution {
  if (spec && frame.event) {
    // Canonical, not exact: the frame carries the CLI's PAYLOAD spelling, which
    // can differ in case/underscores from the manifest's written form (see
    // canonicalEventName). An exact compare dropped every Grok frame.
    const frameEvent = canonicalEventName(frame.event)
    const entry = spec.events.find((candidate) => canonicalEventName(candidate.event) === frameEvent)
    // An event the spec does not name carries no phase for this CLI — the
    // prior phase stands. (This is also what makes a discriminator allow-list
    // fail SAFE: see below.)
    if (!entry) return { action: 'drop' }
    // Failure discriminator: a turn-end whose payload carries the outcome
    // (Cursor's stop status error|aborted) counts as a failed turn — a crash
    // finalized as completed opens a PR from failed work.
    const failureValue = entry.failureWhen ? discriminatorValue(entry.failureWhen.field, frame) : undefined
    const turnFailure =
      entry.failure === true
      || Boolean(entry.failureWhen && failureValue && entry.failureWhen.oneOf.includes(failureValue))
    if (entry.when) {
      // Discriminator: the phase applies only for allow-listed payload values.
      // Claude's `Notification` is the canonical case — it fires for real
      // permission/elicitation prompts AND informational nudges (idle_prompt),
      // and `awaiting_input` is sticky for a dormant agent, so an unlisted or
      // absent value must drop (falsely "needs input" parks a session forever;
      // a false idle is recoverable — the 2026-07-07 parked-agents incident).
      const value = discriminatorValue(entry.when.field, frame)
      if (!value || !entry.when.oneOf.includes(value)) {
        // Stale-reporter compatibility: a reporter copy from before the
        // dumb-forwarder change filtered discriminated events CLIENT-side and
        // asserted the mapped phase without forwarding the discriminator
        // field. Until the next successful install replaces it (install is
        // best-effort and can fail on e.g. a read-only tree), honor its own
        // filtering: no discriminator + the exact phase this entry maps to
        // means the old allow-list already passed. Anything else drops.
        if (!value && frame.phase === entry.phase) {
          return {
            action: 'apply',
            phase: entry.phase,
            turnEnd: entry.turnEnd === true,
            turnFailure,
            ...(entry.background ? { background: entry.background } : {}),
          }
        }
        return { action: 'drop' }
      }
    }
    return {
      action: 'apply',
      phase: entry.phase,
      turnEnd: entry.turnEnd === true,
      turnFailure,
      ...(entry.background ? { background: entry.background } : {}),
    }
  }
  // No spec (a CLI outside the manifest capability whose reporter still emits
  // frames) or an event-less frame: trust the reporter-asserted phase, with no
  // turn-end semantics — those are manifest data only.
  if (frame.phase) return { action: 'apply', phase: frame.phase, turnEnd: false, turnFailure: false }
  return { action: 'drop' }
}

// =============================================================================
// Background work (pure; the runtime keeps the count on the session)
//
// Claude Code fires `Stop` the moment the MODEL stops — including when it has
// parked itself on "Waiting for N background agents to finish" and will be
// re-invoked, with no prompt from the person, the moment they do. Read as a
// turn end, that Stop marked the sidebar row finished and finalized runs whose
// work was still in flight (owner, 2026-09-04). The manifest's `background`
// flag names the events that open and close such work (SubagentStart /
// SubagentStop); the count of what is still open decides whether a turn end
// is real.
//
// A held turn end lands on `tool_use` — the session is inside a tool whose
// result has not come back — with `turnEnd` false, so no consumer finalizes.
// A FAILED turn end is never held: an aborted or crashed turn is over whatever
// was outstanding. The count clamps at zero (a stop with nothing open is a
// subagent that started before the reporter was installed) and the runtime
// resets it on a session start (a fresh process owns nothing from its previous
// life) and on a stall (the watchdog found the pane quiet, which a live
// background agent's spinner never is — so the count had drifted).
// =============================================================================

export function applyBackgroundWork(outstanding: number, background: 'start' | 'stop' | undefined): number {
  if (background === 'start') return outstanding + 1
  if (background === 'stop') return Math.max(0, outstanding - 1)
  return outstanding
}

export function holdTurnEndForBackgroundWork(
  resolution: AppliedAgentStateEvent,
  outstanding: number
): AppliedAgentStateEvent {
  if (!resolution.turnEnd || resolution.turnFailure || outstanding <= 0) return resolution
  return { ...resolution, phase: 'tool_use', turnEnd: false }
}

// The registration subset of a spec's event table: what actually gets written
// into the CLI's hook config. `register: false` entries are mapped if a frame
// ever arrives (a stale registration from an older release) but never
// registered anew — e.g. Claude's PreToolUse, dropped because PostToolUse alone
// clears awaiting_input and halves the per-tool reporter spawns (the manifest
// $comment on the claude-code plugin carries the full rationale).
/**
 * The hook events on which the reporter forwards the person's prompt
 * (`resources/hooks/multicode-agent-state.mjs`). `UserPromptSubmit` is
 * Claude/Codex/Kimi vocabulary; Cursor spells the same moment
 * `beforeSubmitPrompt`. Named here because the reporter's list and any reader's
 * idea of "does this runtime report messages" have to be the same list.
 *
 * Held canonically (see canonicalEventName) and compared canonically, for the
 * same reason resolveAgentStateEvent does: a manifest that writes the moment
 * `user_prompt_submit` names the same event as one that writes
 * `UserPromptSubmit`, and this question must not turn on the spelling.
 */
const PROMPT_REPORTING_EVENTS: ReadonlySet<string> = new Set(
  ['UserPromptSubmit', 'beforeSubmitPrompt'].map(canonicalEventName)
)

/**
 * True when this CLI's manifest declares an event that carries what the person
 * typed. The conversation peek asks this to tell "has said nothing yet" apart
 * from "cannot report at all" — OpenCode has an agentStateSpec and still
 * forwards no prompt, so the presence of a spec is not the same question.
 */
export function agentStateSpecReportsPrompts(
  spec: Pick<PluginAgentStateSpec, 'events'> | null | undefined
): boolean {
  return Boolean(spec?.events.some((entry) => PROMPT_REPORTING_EVENTS.has(canonicalEventName(entry.event))))
}

export function registeredAgentStateEvents(
  spec: Pick<PluginAgentStateSpec, 'events'>
): Array<{ event: string; matcher?: string }> {
  return spec.events
    .filter((entry) => entry.register !== false)
    .map(({ event, matcher }) => (matcher === undefined ? { event } : { event, matcher }))
}

// =============================================================================
// Phase → legacy SessionActivity bridge
//
// Keeps the existing 4-variant activity field honest from the richer phase so
// every current consumer (sidebar bolding, reaping, diagnostics) keeps working.
// Returns null for terminal phases (`exited`/`failed`): a real process exit is
// owned authoritatively by the pty onExit handler, which carries the exit code
// a hook frame does not — we never synthesize an exit from a hook.
// =============================================================================

// At-rest phases the idle reaper may reclaim once rested past its threshold:
// 'idle' (authoritative turn end) and 'stalled' (inferred quiet ≥90s). Stalled
// counts as rest deliberately — a lost Stop frame lands a genuinely-finished
// agent there, and treating stalled as protected parked sessions forever
// (2026-07-07 incident). Shared by the reap candidate mapping and the
// sprint-agent inactive-run guard so the two can't drift.
export function isAtRestAgentPhase(phase: AgentPhase | null | undefined): boolean {
  return phase === 'idle' || phase === 'stalled'
}

export function deriveActivityFromPhase(phase: AgentPhase, since: number): SessionActivity | null {
  switch (phase) {
    case 'starting':
    case 'thinking':
    case 'tool_use':
      return { kind: 'working', since }
    case 'awaiting_input':
    case 'idle':
    case 'stalled':
      return { kind: 'idle', since }
    case 'exited':
    case 'failed':
      return null
    default:
      return null
  }
}

// =============================================================================
// Stall evaluation (pure; the runtime drives the timer from this decision)
//
// A hook-reported working phase (`starting`/`thinking`/`tool_use`) that goes
// quiet — no newer frame and no terminal output — past the threshold is treated
// as stalled. Output advancing `lastOutputAt` (a streaming tool, a startup
// banner) or a newer frame keeps it alive; the runtime re-checks after the
// returned delay rather than firing once. `starting` is included so a resumed
// session that never receives a prompt (SessionStart is its only frame — no
// Stop ever follows) converts to `stalled` and becomes reclaimable via the
// reap policy's stalled expiry, instead of parking as "working" forever.
// =============================================================================

export type StallEvaluation =
  | { action: 'stalled' }
  | { action: 'recheck'; afterMs: number }
  | { action: 'clear' }

export function evaluateAgentStall(input: {
  phase: AgentPhase
  source: AgentStateSource
  phaseSince: number
  lastOutputAt: number | null
  now: number
  thresholdMs: number
}): StallEvaluation {
  if (input.phase !== 'starting' && input.phase !== 'thinking' && input.phase !== 'tool_use') {
    return { action: 'clear' }
  }
  // A hook-driven working phase can stall, and so can the `starting` lifecycle
  // stamp every agent gets at spawn: a session whose hooks never fire at all (a
  // broken or failed install — there is no output-timing fallback any more)
  // must convert to `stalled` and expire via the reap policy rather than
  // reading as working, and being reaper-protected, forever. No lifecycle
  // thinking/tool_use exists to be evaluated: those only ever come from hooks.
  if (input.source !== 'hook' && input.phase !== 'starting') return { action: 'clear' }
  const lastActivityAt = Math.max(input.phaseSince, input.lastOutputAt ?? 0)
  const quietForMs = input.now - lastActivityAt
  if (quietForMs >= input.thresholdMs) return { action: 'stalled' }
  return { action: 'recheck', afterMs: input.thresholdMs - quietForMs }
}

// =============================================================================
// Untrusted frame validation
//
// Frames arrive over a local socket from a reporter process. Treat every field
// as untrusted data: validate shape and the phase enum, never act on anything
// beyond the typed fields below.
// =============================================================================

// A self-scheduled wakeup reported by the CLI's PostToolUse hook (Claude Code's
// ScheduleWakeup tool; Codex shares the hook payload schema, and the OpenCode
// adapter can emit the same field if that CLI grows an equivalent). `stop`
// tears the loop down; `delaySeconds` arms a timer inside the CLI process.
type AgentStateFrameWakeup = { stop: true } | { delaySeconds: number }

// ScheduleWakeup's runtime clamps delaySeconds to [60, 3600]. Anything past
// clamp+slack is a reporter/clock anomaly — cap it so one bad frame cannot
// park a session on a far-future hold.
export const MAX_WAKEUP_DELAY_SECONDS = 2 * 3600

// Absurd lengths are a reporter/payload anomaly, not a path. Cap so an unbounded
// untrusted string cannot ride the frame into a consumer.
export const MAX_TRANSCRIPT_PATH_LENGTH = 4096

// One file the agent's PostToolUse hook says it just changed: the path plus the
// line counts the reporter summed off the tool's own diff hunks. Never the
// patch or the content — see the reporter.
export type AgentStateFrameFileChange = {
  path: string
  additions: number
  deletions: number
  // The MINIMAL changed regions of the call, in git's hunk convention (agent
  // changelists): four small ints each, and the only thing that lets an agent's
  // changelist own the LINES it wrote in a file two agents share. Absent when
  // the reporter could not read the patch's shape — a file-level claim, which
  // is what every consumer already falls back to.
  edits?: ChangelistEdit[]
}

// A single tool call that rewrote more than this many separate regions is a
// whole-file rewrite in all but name. The reporter caps too; this is the
// enforcement, since the reporter is untrusted input.
export const MAX_FILE_CHANGE_EDITS = 200

// A path this long is a broken reporter, not a file. Same bound as the observed
// cwd, and for the same reason: the value is retained per session and broadcast
// to every renderer.
export const MAX_FILE_CHANGE_PATH_LENGTH = MAX_OBSERVED_CWD_LENGTH

// A single tool call cannot honestly add ten million lines; past that the frame
// is anomalous. Capped rather than dropped, so an absurd count degrades to a
// large one instead of erasing the fact that the file was edited.
export const MAX_FILE_CHANGE_COUNT = 10_000_000

// One pull request the agent's PostToolUse hook says it just OPENED (epic
// `pull-request-marks`, decision 8b): the URL, and nothing else. The reporter
// matched the creation and extracted the URL out of the tool's result, so no
// command and no output ever rides the frame — and the app learns about the
// pull request the moment it exists instead of waiting for the branch lookup.
//
// Where it belongs is the URL's own question: an agent that ran
// `cd ../website && gh pr create` opened one in a repository its session does
// not sit in, and the URL is the only thing that says so (decision 10).
export type AgentStateFramePullRequest = { url: string }

// A URL this long is a broken reporter, not a pull request. The reporter caps
// too; this is the enforcement, since the reporter is untrusted input.
export const MAX_PULL_REQUEST_URL_LENGTH = 2048

// Same ceiling for the status line's own numbers (the context window size in
// tokens, and the session's cumulative line counts). Capped rather than dropped:
// an absurd number degrades to a large one instead of erasing the reading.
export const MAX_STATUS_LINE_COUNT = MAX_FILE_CHANGE_COUNT

// Cap on the forwarded user prompt. The reporter truncates too, but it is
// untrusted, so this is the enforcement: the value is retained per session and
// broadcast to every renderer, and an unbounded string would ride into both.
// Sized well above a title (~42 chars) because the same field feeds the tab
// hover preview, which shows several lines.
const MAX_AGENT_PROMPT_LENGTH = 2000

export type AgentStateFrame = {
  type: 'agent_state'
  agentId: string
  workspaceId: string | null
  sessionId: string | null
  // The reporter-asserted phase. Optional: the stdin-filter reporter is a dumb
  // forwarder (event + discriminator fields only; the phase is derived in main
  // via the resolving plugin's agentStateSpec). Present on frames from the
  // OpenCode plugin reporter (which maps internally for its dedup) and from
  // stale reporter copies of older releases — consumed only when no spec entry
  // resolves the event (see resolveAgentStateEvent).
  phase?: AgentPhase
  event: string | null
  // The payload discriminator fields specs may consult (Claude's
  // `notification_type`; Cursor's turn-outcome `status`), forwarded under one
  // spelling each. Untrusted, capped.
  notificationType?: string
  status?: string
  ts: number
  wakeup?: AgentStateFrameWakeup
  // The CLI's session transcript, forwarded by the reporter on a turn end only.
  // Untrusted: this is a file path chosen by the reporter, so whoever READS it
  // owns containment (absolute + `.jsonl` + size cap). Validation here is shape
  // only, and a bad value drops the field, never the frame.
  transcriptPath?: string
  // The verbatim text the person submitted, forwarded by the reporter on
  // `UserPromptSubmit` only. Untrusted like every other reporter field: capped
  // on receipt, and a value over the cap is truncated rather than dropping the
  // frame (a long prompt is a normal prompt, not an anomaly — unlike a 4KB
  // "path", which signals a broken reporter).
  prompt?: string
  // The session's current working directory as the CLI's hook payload reports
  // it (`cwd` is in the base payload of every Claude Code / Codex / Grok hook),
  // forwarded by the reporter on every frame that carries one (MC-2440). A cwd
  // only changes through a tool call, so the PostToolUse frame that follows
  // carries the new one — no dedicated event is registered for it. Untrusted:
  // shape-checked on receipt (absolute, capped) and a bad value drops the
  // field, never the frame — the phase it rides with is still real.
  cwd?: string
  // The file the agent just edited, forwarded on the PostToolUse of an editing
  // tool (Edit/Write/MultiEdit/NotebookEdit). Folded into the session's file
  // ledger. Untrusted like the rest: absolute path, bounded, non-negative
  // integer counts — a bad value drops the FIELD, never the frame, so a
  // malformed count cannot cost the session its phase transition.
  fileChange?: AgentStateFrameFileChange
  // The CLI's OWN id for the tool call this frame reports, forwarded on every
  // PostToolUse-shaped frame that carries one (Claude/Codex/Kimi `tool_use_id`,
  // Grok `toolUseId`, OpenCode `callID`; Cursor's `afterFileEdit` has none).
  //
  // It exists for exactly one job: telling a SECOND registration of the same
  // reporter apart from a second edit. Two registrations — the by-hand merge in
  // `.claude/settings.local.json` and the plugin's own `hooks/hooks.json` —
  // fire the same hook on the same tool call, and the two frames are identical
  // down to this id, because it is the CLI's, not the reporter's. A genuinely
  // second edit is a second tool call and carries a different one. See the ring
  // in terminal-session.ts (`noteFoldedFileChange`).
  //
  // Untrusted like the rest: bounded, control-character-free, and a bad value
  // drops the FIELD, never the frame — a frame without it falls back to the
  // ring's timestamp-windowed key rather than losing its edit.
  toolUseId?: string
  // What the session's own status line last said about itself, forwarded by the
  // status-line forwarder on `event: 'StatusLine'` — an event no manifest names,
  // so the frame's phase resolution DROPS it and the status line is folded in
  // before that drop, exactly like a file change. Every field is optional
  // because the payload's are: `usedPercentage` is null before the first API
  // call and again right after a /compact, and a session is unnamed until it is
  // named. Untrusted like the rest: a bad value drops the FIELD.
  statusLine?: AgentStateFrameStatusLine
  // The pull request the agent just opened, forwarded on the PostToolUse of a
  // `gh pr create` (or of the sprint MCP tool that runs one). Folded in before
  // the phase drop, exactly like a status line: a `PostToolUse` resolves to
  // `thinking` and could roll a phase backward, but the pull request it carries
  // is true whatever the frame's fate. Untrusted like the rest: a URL that is
  // not a pull request URL drops the FIELD, never the frame.
  pullRequest?: AgentStateFramePullRequest
}

// One reading from a session's status line. The numbers are the CLI's own —
// nothing here is derived, and nothing else from the status-line payload (the
// transcript path, the repo identity, the rate limits, the prompt cache) is
// carried: see the forwarder.
export type AgentStateFrameStatusLine = {
  // 0..100, rounded to a whole percent on the way in: it is rendered as a ring
  // and a number, and a broadcast per hundredth of a percent is a broadcast per
  // token. Absent when the CLI does not know yet.
  usedPercentage?: number
  contextWindowSize?: number
  totalCostUsd?: number
  linesAdded?: number
  linesRemoved?: number
  model?: string
  sessionName?: string
}

// Cap on the two free-text status-line fields. A model display name is a word
// and a session name is a title; anything longer is a broken forwarder, and the
// value is retained per session for however long that session lives.
export const MAX_STATUS_LINE_NAME_LENGTH = 256

// And a ceiling on the cost, so that every number off this socket is bounded.
// A session cannot honestly have spent a million dollars; past that the frame is
// anomalous. Capped rather than dropped, like the counts.
export const MAX_STATUS_LINE_COST_USD = 1_000_000

const VALID_PHASES: ReadonlySet<AgentPhase> = new Set<AgentPhase>([
  'starting',
  'thinking',
  'tool_use',
  'awaiting_input',
  'idle',
  'exited',
  'failed',
  'stalled',
])

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

// Cap on the forwarded tool-call id. Every CLI's is a short opaque token
// (Claude's `toolu_…` is 29 chars); anything longer is a payload anomaly, and
// the value is only ever compared for equality, so an oversized string is
// dropped rather than truncated — a truncated id could collide with another.
export const MAX_TOOL_USE_ID_LENGTH = 256

// Cap on the forwarded discriminator value: documented notification types are
// short tokens; anything longer is a payload anomaly, and the value is compared
// against manifest allow-lists so an oversized string is dropped, not truncated.
const MAX_NOTIFICATION_TYPE_LENGTH = 128

export function parseAgentStateFrame(raw: unknown, now: number): AgentStateFrame | null {
  if (!isRecord(raw)) return null
  if (raw.type !== 'agent_state') return null
  const agentId = optionalString(raw.agentId)
  if (!agentId) return null
  // A frame must carry a raw event name (mapped in main via the resolving
  // plugin's agentStateSpec), a reporter-asserted phase (the OpenCode plugin,
  // stale reporter copies), or both. Neither ⇒ nothing to apply.
  const event = optionalString(raw.event)
  const phase =
    typeof raw.phase === 'string' && VALID_PHASES.has(raw.phase as AgentPhase)
      ? (raw.phase as AgentPhase)
      : null
  if (!event && !phase) return null
  // Clamp to server arrival time: raw.ts is reporter-supplied and compared
  // cross-clock against the main-process clock (terminal-runtime drops frames
  // where since > frame.ts, and since is written from Date.now()). A far-future
  // ts would pin the phase forever and future-date "working since"; a reporter
  // cannot legitimately be ahead of now, so cap it.
  const ts = typeof raw.ts === 'number' && Number.isFinite(raw.ts) ? Math.min(raw.ts, now) : now
  const frame: AgentStateFrame = {
    type: 'agent_state',
    agentId,
    workspaceId: optionalString(raw.workspaceId),
    sessionId: optionalString(raw.sessionId),
    event,
    ts,
  }
  if (phase) frame.phase = phase
  const notificationType = optionalString(raw.notificationType)
  if (notificationType && notificationType.length <= MAX_NOTIFICATION_TYPE_LENGTH) {
    frame.notificationType = notificationType
  }
  const status = optionalString(raw.status)
  if (status && status.length <= MAX_NOTIFICATION_TYPE_LENGTH) {
    frame.status = status
  }
  const wakeup = parseFrameWakeup(raw.wakeup)
  if (wakeup) frame.wakeup = wakeup
  const transcriptPath = optionalString(raw.transcriptPath)
  if (transcriptPath && transcriptPath.length <= MAX_TRANSCRIPT_PATH_LENGTH) frame.transcriptPath = transcriptPath
  const prompt = optionalString(raw.prompt)
  if (prompt) {
    const trimmed = prompt.trim()
    if (trimmed) frame.prompt = trimmed.slice(0, MAX_AGENT_PROMPT_LENGTH)
  }
  const cwd = parseFrameCwd(raw.cwd)
  if (cwd) frame.cwd = cwd
  const fileChange = parseFrameFileChange(raw.fileChange)
  if (fileChange) frame.fileChange = fileChange
  const toolUseId = parseFrameToolUseId(raw.toolUseId)
  if (toolUseId) frame.toolUseId = toolUseId
  const statusLine = parseFrameStatusLine(raw.statusLine)
  if (statusLine) frame.statusLine = statusLine
  const pullRequest = parseFramePullRequest(raw.pullRequest)
  if (pullRequest) frame.pullRequest = pullRequest
  return frame
}

// A captured pull request, or nothing. The URL must be one the app's OWN parser
// recognises as a pull request (`parsePullRequestUrl` — GitHub and GitHub
// Enterprise; a Bitbucket URL is a typed "unsupported", which is not a capture
// either), bounded, and free of control characters like every other string off
// this socket.
//
// A bad value drops the FIELD and never the frame: the reporter is untrusted
// input, and a malformed capture must not cost the session the phase, the cwd or
// the ledger entry the same frame carries. There is exactly ONE URL parser in
// main — the reporter's regex is its documented wire-side twin, and this is
// where the two meet.
function parseFramePullRequest(raw: unknown): AgentStateFramePullRequest | null {
  if (!isRecord(raw)) return null
  const url = optionalString(raw.url)?.trim()
  if (!url || url.length > MAX_PULL_REQUEST_URL_LENGTH) return null
  if (hasControlCharacters(url)) return null
  const parsed = parsePullRequestUrl(url)
  if (!parsed || 'unsupported' in parsed) return null
  return { url }
}

// A status-line reading, field by field: each one that fails its own rule is
// simply absent, because they are independent readings and a bad cost must not
// cost the session its context percentage. A reading with NOTHING valid in it
// drops entirely — the field then never reaches the session, which is what lets
// the ingest treat "present" as "there is something to fold".
//
// The path rules follow the file ledger's: bounded, control characters refused,
// counts finite and not negative.
function parseFrameStatusLine(raw: unknown): AgentStateFrameStatusLine | null {
  if (!isRecord(raw)) return null
  const statusLine: AgentStateFrameStatusLine = {}
  // A percentage outside 0..100 is not a percentage. Refused rather than
  // clamped: a forwarder that reports 900% has read the wrong field, and
  // clamping it to 100 would paint a full context ring on an empty session.
  const usedPercentage = raw.usedPercentage
  if (typeof usedPercentage === 'number' && Number.isFinite(usedPercentage) && usedPercentage >= 0 && usedPercentage <= 100) {
    statusLine.usedPercentage = Math.round(usedPercentage)
  }
  const contextWindowSize = parseStatusLineCount(raw.contextWindowSize)
  if (contextWindowSize !== null) statusLine.contextWindowSize = contextWindowSize
  // Cost is money, not a line count: it keeps the fraction the counts floor
  // away, and is refused when negative or not finite, capped when absurd.
  if (typeof raw.totalCostUsd === 'number' && Number.isFinite(raw.totalCostUsd) && raw.totalCostUsd >= 0) {
    statusLine.totalCostUsd = Math.min(raw.totalCostUsd, MAX_STATUS_LINE_COST_USD)
  }
  const linesAdded = parseStatusLineCount(raw.linesAdded)
  if (linesAdded !== null) statusLine.linesAdded = linesAdded
  const linesRemoved = parseStatusLineCount(raw.linesRemoved)
  if (linesRemoved !== null) statusLine.linesRemoved = linesRemoved
  const model = parseStatusLineName(raw.model)
  if (model) statusLine.model = model
  const sessionName = parseStatusLineName(raw.sessionName)
  if (sessionName) statusLine.sessionName = sessionName
  return Object.keys(statusLine).length > 0 ? statusLine : null
}

function parseStatusLineCount(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return null
  return Math.min(Math.floor(raw), MAX_STATUS_LINE_COUNT)
}

// A name is a name: trimmed, bounded, and free of control characters for the
// same reason a reported path is — it is retained per session, and the surfaces
// that will read it paint it. (The rule is the paths' one: C0 and DEL. A model
// name is display text rather than a path, so it is a loose fit, but one rule
// for every string off this socket beats two.)
function parseStatusLineName(raw: unknown): string | null {
  const value = optionalString(raw)?.trim()
  if (!value || value.length > MAX_STATUS_LINE_NAME_LENGTH) return null
  if (hasControlCharacters(value)) return null
  return value
}

// The CLI's tool-call id, or nothing. Bounded and free of control characters
// like every other string off this socket; it is keyed on in a per-session ring
// and never rendered, so it is compared, never truncated. A bad value drops the
// FIELD and never the frame — the ring simply falls back to its no-id key.
function parseFrameToolUseId(raw: unknown): string | null {
  const value = optionalString(raw)?.trim()
  if (!value || value.length > MAX_TOOL_USE_ID_LENGTH) return null
  if (hasControlCharacters(value)) return null
  return value
}

// A reported file change must name an absolute path (a relative one is
// meaningless off the reporter's own process cwd, and the ledger is shown to a
// person as the file they can open) with two counts that are real, finite and
// not negative. Anything else drops the field — the frame still carries its
// phase, and a missing ledger entry is a smaller lie than a wrong one.
function parseFrameFileChange(raw: unknown): AgentStateFrameFileChange | null {
  if (!isRecord(raw)) return null
  const path = optionalString(raw.path)?.trim()
  if (!path || !isValidFileChangePath(path)) return null
  const additions = parseFileChangeCount(raw.additions)
  const deletions = parseFileChangeCount(raw.deletions)
  if (additions === null || deletions === null) return null
  const edits = parseFrameFileChangeEdits(raw.edits)
  return { path, additions, deletions, ...(edits ? { edits } : {}) }
}

// The changed regions, or nothing. Every one of the four numbers must be a
// whole, finite, non-negative int in git's hunk convention (a zero-length side
// is an anchor, and `+0,0` is a real deletion at the head of a file — which is
// why zero is allowed on a `start`), and a malformed member drops the whole
// FIELD rather than the frame: the file was still edited, and a file-level claim
// is a smaller lie than a line range that is off by a region.
//
// Over the cap the list is TRUNCATED rather than dropped: the regions ascend, so
// the ones that are kept are still exactly right, and the rest fall to the
// changelist model's remainder rule.
function parseFrameFileChangeEdits(raw: unknown): ChangelistEdit[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null
  const edits: ChangelistEdit[] = []
  for (const entry of raw.slice(0, MAX_FILE_CHANGE_EDITS)) {
    if (!isRecord(entry)) return null
    const bound = (value: unknown): number | null =>
      typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
    const oldStart = bound(entry.oldStart)
    const oldLines = bound(entry.oldLines)
    const newStart = bound(entry.newStart)
    const newLines = bound(entry.newLines)
    if (oldStart === null || oldLines === null || newStart === null || newLines === null) return null
    edits.push({ oldStart, oldLines, newStart, newLines })
  }
  return edits.length > 0 ? edits : null
}

// What a file path in the ledger has to be, wherever it arrives from — a
// reporter frame over the socket, or a snapshot sidecar read back off disk.
// Absolute (a relative path is meaningless off the process that reported it, and
// the ledger hands a person a file to open), bounded, and free of control
// characters: `isAbsoluteObservedPath` only inspects a prefix, and this value is
// retained per session, written to disk, keyed on and painted in every window.
export function isValidFileChangePath(path: string): boolean {
  if (path.length === 0 || path.length > MAX_FILE_CHANGE_PATH_LENGTH) return false
  if (hasControlCharacters(path)) return false
  return isAbsoluteObservedPath(path)
}

// Counts are whole lines: a fractional value is rounded down rather than
// dropped (the edit still happened), a negative or non-finite one is refused
// outright, and an absurd one is capped.
//
// Refusing (rather than defaulting to zero) is deliberate, and is the one place
// this differs from the reporter's "record the touch even when the shape cannot
// be counted" rule: the reporter emits a real 0 for a shape it cannot read, so a
// count arriving as anything but a number means the FRAME is malformed, not that
// the count is unknown — and a malformed frame is not something to half-believe.
function parseFileChangeCount(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null
  if (raw < 0) return null
  return Math.min(Math.floor(raw), MAX_FILE_CHANGE_COUNT)
}

// A reported cwd must be absolute (a relative value is meaningless off the
// reporter's own process cwd) and bounded; anything else drops the field.
// Trailing whitespace is trimmed — a `\n`-terminated value from a reporter that
// piped a command's output is still the same directory.
function parseFrameCwd(raw: unknown): string | null {
  const value = optionalString(raw)?.trim()
  if (!value) return null
  if (value.length > MAX_OBSERVED_CWD_LENGTH) return null
  if (hasControlCharacters(value)) return null
  if (!isAbsoluteObservedPath(value)) return null
  return value
}

// `isAbsoluteObservedPath` only inspects a path's PREFIX, so a value that starts
// `/` passes however it continues. A real path from a real CLI carries no
// control characters; one that does is either a broken reporter or an attempt to
// smuggle a NUL, an embedded newline or an ANSI escape into a value the app
// retains per session, writes to a sidecar, keys a map on and paints in every
// window. Refuse it at the door rather than at each of those.
function hasControlCharacters(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value)
}

// A malformed wakeup drops (frame stands without it) — the reporter is
// untrusted, and a bogus hold is worse than a missed one: it parks a session.
function parseFrameWakeup(raw: unknown): AgentStateFrameWakeup | null {
  if (!isRecord(raw)) return null
  if (raw.stop === true) return { stop: true }
  if (typeof raw.delaySeconds === 'number' && Number.isFinite(raw.delaySeconds) && raw.delaySeconds > 0) {
    return { delaySeconds: Math.min(raw.delaySeconds, MAX_WAKEUP_DELAY_SECONDS) }
  }
  return null
}

// =============================================================================
// Frame → session resolution (pure; tested independently of the runtime)
//
// The reporter frame carries MULTICODE_AGENT_ID — for an interactively-launched
// agent that equals the session's agentId; we also match the execution and PTY
// session ids so resolution is robust to launch paths that key identity
// differently. When more than one live session matches the same id (e.g. a
// relaunch reusing it), prefer the one in the reported workspace, then the most
// recently started.
// =============================================================================

export type AgentStateCandidate<T> = {
  value: T
  agentId?: string
  executionId?: string
  sessionId?: string
  workspaceId?: string
  startedAt: number
}

function candidateMatchesAgent<T>(candidate: AgentStateCandidate<T>, agentId: string): boolean {
  return candidate.agentId === agentId || candidate.executionId === agentId || candidate.sessionId === agentId
}

export function selectAgentStateTarget<T>(
  candidates: ReadonlyArray<AgentStateCandidate<T>>,
  frame: { agentId: string; workspaceId: string | null }
): T | undefined {
  const matches = candidates.filter((candidate) => candidateMatchesAgent(candidate, frame.agentId))
  if (matches.length <= 1) return matches[0]?.value
  const scoped = frame.workspaceId
    ? matches.filter((candidate) => candidate.workspaceId === frame.workspaceId)
    : matches
  const pool = scoped.length > 0 ? scoped : matches
  return pool.reduce((latest, candidate) => (candidate.startedAt > latest.startedAt ? candidate : latest)).value
}

// =============================================================================
// settings.local.json merge / unmerge (idempotent, tagged)
//
// Mirrors the proven pattern in memory-activity.ts: preserve every hook the user
// or another feature configured, replace only our prior tagged entries, and
// drop emptied blocks/events on uninstall so nothing dangles.
// =============================================================================

type ClaudeHookEntry = {
  type: 'command'
  command: string
  _multicode?: string
}

type ClaudeMatcherBlock = {
  matcher?: string
  hooks?: ClaudeHookEntry[]
}

type ClaudeSettings = {
  hooks?: Record<string, ClaudeMatcherBlock[]>
  [key: string]: unknown
}

// Raw shell command both install paths embed (Claude into JSON, Codex into TOML).
// `scriptPath` MUST be absolute: hook commands run with no guaranteed cwd (the
// session's working directory can drift into a subdirectory mid-run), so a
// workspace-relative path would misresolve and fail with MODULE_NOT_FOUND. The
// path is normalized to forward slashes (Node accepts them everywhere, incl.
// `C:/...` on Windows, which also avoids embedding unescaped backslashes).
// `socketPath` is VERBATIM: on Windows it is a `\\.\pipe\...` named pipe whose
// backslashes must survive (a separator rewrite would corrupt it to
// `//./pipe/...`, which connect() can't open); on POSIX it has none. Both args
// are double-quoted so spaces survive the shell.
export function buildAgentStateReporterCommand(scriptPath: string, socketPath: string): string {
  return `node "${scriptPath.split(sep).join('/')}" --socket "${socketPath}"`
}

async function readJsonIfExists<T>(path: string): Promise<T | null> {
  try {
    const text = await readFile(path, 'utf8')
    if (!text.trim()) return {} as T
    return JSON.parse(text) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

// Reporter entries are recognized primarily by the `_multicode` tag, but other
// writers round-trip settings.local.json through schemas that drop unknown keys
// (Claude Code does this when it records e.g. enabledMcpjsonServers), stripping
// the tag. An untagged entry is unremovable by tag alone, and once the workspace
// root moves its absolute script path dangles, firing MODULE_NOT_FOUND on every
// event forever. So also claim untagged entries whose command has the exact
// shape buildAgentStateReporterCommand emits: the script path is always
// forward-slashed and ends in this suffix, immediately followed by `--socket`.
const AGENT_STATE_COMMAND_SIGNATURE = '/.multicode/hooks/agent-state.mjs" --socket "'

function isAgentStateEntry(entry: ClaudeHookEntry): boolean {
  if (entry?._multicode === AGENT_STATE_HOOK_TAG) return true
  return (
    typeof entry?.command === 'string' &&
    entry.command.startsWith('node "') &&
    entry.command.includes(AGENT_STATE_COMMAND_SIGNATURE)
  )
}

function ensureMatcherBlock(blocks: ClaudeMatcherBlock[], matcher: string | undefined): ClaudeMatcherBlock {
  const found = blocks.find((b) => b.matcher === matcher)
  if (found) {
    if (!Array.isArray(found.hooks)) found.hooks = []
    return found
  }
  const next: ClaudeMatcherBlock = matcher === undefined ? { hooks: [] } : { matcher, hooks: [] }
  blocks.push(next)
  return next
}

// Remove every Multicode-tagged reporter entry from ALL event keys, pruning
// emptied matcher-blocks and then emptied event keys. Sweeping all keys — rather
// than only the currently-registered event set — self-heals an
// entry left behind by a prior release that registered an event we have since
// dropped (e.g. PreToolUse). Without this, that stale hook would keep spawning
// the reporter on every tool call and uninstall could never reach it.
function stripAgentStateEntries(hooks: Record<string, ClaudeMatcherBlock[]>): void {
  for (const event of Object.keys(hooks)) {
    const blocks = hooks[event]
    if (!Array.isArray(blocks)) continue
    for (const block of blocks) {
      if (!Array.isArray(block.hooks)) continue
      block.hooks = block.hooks.filter((entry) => !isAgentStateEntry(entry))
    }
    const kept = blocks.filter((b) => Array.isArray(b.hooks) && b.hooks.length > 0)
    if (kept.length === 0) delete hooks[event]
    else hooks[event] = kept
  }
}

export async function mergeAgentStateHooks(
  settingsPath: string,
  command: string,
  events: ReadonlyArray<{ event: string; matcher?: string }>,
  // The status line to write in the same pass, when this spec declares one.
  // ONE read-modify-write, deliberately: this file is shared with Claude Code
  // itself, which rewrites it whenever a person answers "allow always", so a
  // second write cycle here is a window in which their permission is silently
  // clobbered.
  statusLine?: StatusLineForwarderInstall | null
): Promise<void> {
  const existing = (await readJsonIfExists<ClaudeSettings>(settingsPath)) ?? {}
  const settings: ClaudeSettings = { ...existing }
  if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {}

  // Clean up first (incl. entries for events we no longer register), then add the
  // current set — so install is both idempotent and a migration for stale hooks.
  stripAgentStateEntries(settings.hooks)

  for (const { event, matcher } of events) {
    if (!Array.isArray(settings.hooks[event])) settings.hooks[event] = []
    const blocks = settings.hooks[event]
    const block = ensureMatcherBlock(blocks, matcher)
    const ours: ClaudeHookEntry = { type: 'command', command, _multicode: AGENT_STATE_HOOK_TAG }
    const filtered = (block.hooks ?? []).filter((entry) => !isAgentStateEntry(entry))
    filtered.push(ours)
    block.hooks = filtered
  }

  if (statusLine) applyStatusLineForwarder(settings, statusLine)

  await mkdir(resolve(settingsPath, '..'), { recursive: true })
  await writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8')
}

async function unmergeAgentStateHooks(settingsPath: string): Promise<void> {
  const existing = await readJsonIfExists<ClaudeSettings>(settingsPath)
  if (!existing?.hooks || typeof existing.hooks !== 'object') return

  // Sweep ALL event keys (not just the currently-registered ones) so uninstall
  // also removes hooks left by an older release under a since-dropped event.
  stripAgentStateEntries(existing.hooks)
  if (Object.keys(existing.hooks).length === 0) delete existing.hooks

  await writeFile(settingsPath, JSON.stringify(existing, null, 2) + '\n', 'utf8')
}

// =============================================================================
// Status line (Claude Code's `statusLine` setting) — install / uninstall
//
// Hooks say what an agent is DOING; none of them says how much of the model's
// context window is gone. Claude Code puts that number (and the session's cost,
// line counts, model and name) on stdin of the `statusLine` command, refreshed
// after every assistant message, after a /compact, on a permission-mode change
// and on a rate-limit reset. So the app makes itself that command — the
// forwarder script beside the reporter — and turns each refresh into a frame.
//
// A person may already have a status line, and taking it away to read a number
// would be a straight theft of their terminal. So install WRAPS: their command
// is base64'd into `--wrap`, the forwarder runs it with the same stdin bytes and
// passes its stdout and exit code through, and the object we displaced is kept
// verbatim under `_multicodeWrapped` so uninstall can put it back exactly.
//
// Same `_multicode` discipline as the hooks: our entry is recognizable, ours
// alone is ever replaced, every other key in the file is preserved, and install
// is idempotent (a second install unwraps our own entry rather than wrapping
// itself). Serialization is the caller's, and it is the SAME per-target-file
// chain the hooks use — both writers touch settings.local.json.
// =============================================================================

// Where the forwarder script is copied inside a workspace, beside the reporter.
export const STATUS_LINE_HOOK_SCRIPT_REL = join('.multicode', 'hooks', 'status-line.mjs')

// The same tag-stripping problem the hook entries have (a writer round-tripping
// settings.local.json through a schema that drops unknown keys would take
// `_multicode` with it, leaving an unremovable entry pointing at a script path
// that dangles the moment the workspace moves). So ours is claimed by the
// command's shape too, exactly as buildStatusLineForwarderCommand emits it.
const STATUS_LINE_COMMAND_SIGNATURE = '/.multicode/hooks/status-line.mjs" --socket "'

// The person's own command, as it rides in our argv: base64 of
// {"command": "..."}, double-quoted. Read back out of a command string when a
// tag-stripping writer has taken `_multicodeWrapped` — the envelope is then the
// only surviving copy of what we displaced.
const STATUS_LINE_WRAP_ARGUMENT = /--wrap "([A-Za-z0-9+/=]+)"/

// A status line command longer than this is not one we will carry through a
// base64 argv round trip — nothing is installed (their status line stays
// exactly as it is) rather than truncating, because half a command is a
// command.
const MAX_WRAPPED_STATUS_LINE_COMMAND_LENGTH = 4096

// And the rendered command has its own ceiling, because the base64 envelope is
// a third longer than what it carries and the whole string is executed as a
// command line: cmd.exe refuses one past 8191 characters, so a wrapped command
// that is legal on its own can render a status line Windows cannot run. Checked
// on the RENDERED string, which is the thing with the limit.
const MAX_STATUS_LINE_RENDERED_COMMAND_LENGTH = 7000

// Which of the three settings files the wrapped status line was displaced from.
// Recorded because only the LOCAL one is the file we overwrite: a status line
// that lives in the person's `~/.claude/settings.json` is still sitting there
// untouched, so writing a copy of it back into the project's
// settings.local.json on uninstall would leave a stale duplicate shadowing the
// original forever after they next edit it.
export type WrappedStatusLineOrigin = 'local' | 'project' | 'user'

export type WrappedStatusLine = {
  statusLine: Record<string, unknown>
  origin: WrappedStatusLineOrigin
}

// What the settings write does about the status line: put ours in (wrapping the
// status line it displaced, null when it displaced nothing), or take ours out.
export type StatusLineForwarderInstall =
  | { action: 'write'; command: string; wrapped: WrappedStatusLine | null }
  | { action: 'remove' }

const WRAPPED_STATUS_LINE_ORIGINS: ReadonlySet<string> = new Set<WrappedStatusLineOrigin>([
  'local',
  'project',
  'user',
])

// `scriptPath` is forward-slashed and `socketPath` verbatim for exactly the
// reasons buildAgentStateReporterCommand documents. The wrap envelope is
// base64 (alphabet A-Z a-z 0-9 + / =) so no shell on any platform can find
// anything to interpret in the person's own command while it rides in our argv;
// it is double-quoted anyway, like the other two.
export function buildStatusLineForwarderCommand(
  scriptPath: string,
  socketPath: string,
  wrapped: WrappedStatusLine | null
): string {
  const base = `node "${scriptPath.split(sep).join('/')}" --socket "${socketPath}"`
  const command = typeof wrapped?.statusLine.command === 'string' ? wrapped.statusLine.command : null
  if (!command) return base
  const envelope = Buffer.from(JSON.stringify({ command }), 'utf8').toString('base64')
  return `${base} --wrap "${envelope}"`
}

/** Whether a `statusLine` value is one this app wrote. */
function isOurStatusLine(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (value._multicode === true) return true
  return typeof value.command === 'string' && value.command.includes(STATUS_LINE_COMMAND_SIGNATURE)
}

/**
 * A person's status line reduced to "can we run this on their behalf". Only
 * Claude's `command` type exists, so anything else - a missing command, a
 * non-string one, an absurd one, or (defensively) one of ours - is not
 * wrappable.
 *
 * An unwrappable status line is never DISPLACED: see the resolution below. A
 * type this code has not heard of is the case that matters, because it is what
 * a future Claude release looks like, and installing over it would delete a
 * setting we merely failed to recognize.
 */
function wrappableStatusLine(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value) || isOurStatusLine(value)) return null
  if (value.type !== 'command') return null
  const command = value.command
  if (typeof command !== 'string' || !command.trim()) return null
  if (command.length > MAX_WRAPPED_STATUS_LINE_COMMAND_LENGTH) return null
  return value
}

// A settings file that another tool half-wrote (or a `~/.claude/settings.json`
// with a trailing comma in it) must not take the agent-state install down with
// it: an unreadable file simply carries no status line.
async function readSettingsLeniently(path: string): Promise<Record<string, unknown> | null> {
  try {
    return (await readJsonIfExists<Record<string, unknown>>(path)) ?? null
  } catch {
    return null
  }
}

// What the scan tells the writer to do. Three outcomes, kept apart because two
// of them used to be one `null` and the difference between them is a person's
// status line:
//   write  — install ours, wrapping `wrapped` (null = there was nothing to wrap)
//   remove — take ours back out: the person now has a status line we cannot run
//            for them, and ours is the only thing standing in front of it
//   leave  — touch the setting at all and something is lost
export type StatusLineResolution =
  | { kind: 'write'; wrapped: WrappedStatusLine | null }
  | { kind: 'remove' }
  | { kind: 'leave' }

/**
 * What one of our own entries displaced, as far as it can still be told.
 *
 *   value    — the status line we replaced. `origin: 'unknown'` means it was
 *              recovered from the command's own `--wrap` envelope after a writer
 *              stripped the bookkeeping keys, so where it came from is lost.
 *   none     — we installed over nothing, and there is nothing to recover.
 *   unusable — something IS recorded but is not a status line we can re-wrap (a
 *              hand-edit, a type from a later Claude). It is still the record
 *              uninstall restores from, so it must not be overwritten.
 */
type DisplacedStatusLine =
  | { kind: 'value'; statusLine: Record<string, unknown>; origin: WrappedStatusLineOrigin | 'unknown' }
  | { kind: 'none' }
  | { kind: 'unusable' }

// The person's own status line rebuilt out of OUR entry — the only surviving
// copy once a schema-normalizing writer has taken `_multicodeWrapped`. The
// command comes from the base64 in our argv; `padding` and `refreshInterval`
// come from our own entry, which carries them precisely so that Claude keeps
// running their script the way they configured it. `padding: 0` is a setting a
// person can see, not a default, so it is recovered like the rest.
function statusLineFromWrapArgument(ours: Record<string, unknown>): Record<string, unknown> | null {
  const command = ours.command
  if (typeof command !== 'string') return null
  const match = STATUS_LINE_WRAP_ARGUMENT.exec(command)
  if (!match) return null
  try {
    const parsed: unknown = JSON.parse(Buffer.from(match[1], 'base64').toString('utf8'))
    if (!isRecord(parsed) || typeof parsed.command !== 'string') return null
    const recovered: Record<string, unknown> = { type: 'command', command: parsed.command }
    if (typeof ours.padding === 'number' && Number.isFinite(ours.padding)) recovered.padding = ours.padding
    if (typeof ours.refreshInterval === 'number' && Number.isFinite(ours.refreshInterval)) {
      recovered.refreshInterval = ours.refreshInterval
    }
    return wrappableStatusLine(recovered)
  } catch {
    return null
  }
}

// The origin recorded on one of our entries, when it is still there and still
// one of the three we write.
function recordedStatusLineOrigin(ours: Record<string, unknown>): WrappedStatusLineOrigin | null {
  const recorded = ours._multicodeWrappedFrom
  return typeof recorded === 'string' && WRAPPED_STATUS_LINE_ORIGINS.has(recorded)
    ? (recorded as WrappedStatusLineOrigin)
    : null
}

function displacedStatusLine(ours: Record<string, unknown>): DisplacedStatusLine {
  const previous = ours._multicodeWrapped
  if (isRecord(previous)) {
    const statusLine = wrappableStatusLine(previous)
    if (!statusLine) return { kind: 'unusable' }
    return { kind: 'value', statusLine, origin: recordedStatusLineOrigin(ours) ?? 'local' }
  }
  // Explicitly null: we installed over nothing.
  if (previous === null) return { kind: 'none' }
  // Absent: the same writer the command-shape signature exists for has round-
  // tripped this file through a schema that drops unknown keys, taking
  // `_multicodeWrapped` with the tag. It may or may not have taken the origin
  // too — when the origin survived it is still the truth about where the
  // command came from, and using it is what stops a project-level status line
  // being copied down into the local file as a permanent shadow of itself.
  const recovered = statusLineFromWrapArgument(ours)
  if (!recovered) return { kind: 'none' }
  return { kind: 'value', statusLine: recovered, origin: recordedStatusLineOrigin(ours) ?? 'unknown' }
}

/**
 * The status line the person would see if this app installed nothing, read in
 * Claude Code's own precedence: the settings file we write (project-local),
 * then the project settings beside it, then the user's (honouring
 * `CLAUDE_CONFIG_DIR`, first comma entry, the way every other Claude reader in
 * this app resolves it).
 *
 * Our own entry is never wrapped. It is unwrapped instead:
 *   - displaced from THIS file  -> that is the answer, and install is idempotent.
 *   - recovered from the argv envelope, origin lost -> also the answer, and
 *     immediately: the file it was found in outranks everything below, so
 *     deferring to a lower one would run a command Claude never would have and
 *     throw away the only copy of the one it did.
 *   - displaced from the project or user file -> the scan CONTINUES, so the LIVE
 *     value from that file wins. Those two are never restored by uninstall
 *     (they were never removed from their own file), so the copy we hold is only
 *     "what to run", and a person who has since edited it means the edit.
 *   - nothing displaced (we installed over nothing) -> the scan continues, so a
 *     status line added after we installed is picked up rather than shadowed.
 *
 * A status line we cannot run for them stops the scan. If ours is sitting in the
 * local file it is REMOVED — otherwise our entry, which outranks every file
 * below it, would shadow the person's new status line silently and forever.
 */
export async function resolveWrappedStatusLine(
  settingsPath: string,
  options: { homeDir: string; env: NodeJS.ProcessEnv }
): Promise<StatusLineResolution> {
  const projectPath = resolve(settingsPath, '..', 'settings.json')
  const userPath = resolve(resolveClaudeConfigDir(options.homeDir, options.env), 'settings.json')
  // Derived from the registration's own path rather than hardcoded, and
  // de-duplicated: a manifest is only validated to register a settings-JSON
  // kind, not which of Claude's settings files it names.
  const candidates: Array<{ path: string; origin: WrappedStatusLineOrigin }> = [
    { path: settingsPath, origin: 'local' },
  ]
  if (projectPath !== settingsPath) candidates.push({ path: projectPath, origin: 'project' })
  if (userPath !== settingsPath && userPath !== projectPath) candidates.push({ path: userPath, origin: 'user' })

  let oursIsInstalled = false
  for (const { path, origin } of candidates) {
    const settings = await readSettingsLeniently(path)
    const raw = settings?.statusLine
    if (!isRecord(raw)) continue
    if (isOurStatusLine(raw)) {
      if (origin === 'local') oursIsInstalled = true
      const displaced = displacedStatusLine(raw)
      // Something is recorded that we cannot re-wrap: leave the whole setting
      // alone rather than overwrite the record uninstall restores from.
      if (displaced.kind === 'unusable') return { kind: 'leave' }
      if (displaced.kind === 'none') continue
      if (displaced.origin === 'local' || displaced.origin === 'unknown') {
        // The candidate's OWN origin, not a hardcoded 'local': every shipped
        // manifest registers the local file, so these are the same value today,
        // but a manifest registering `.claude/settings.json` would otherwise
        // make one workspace's scan claim another install's record as its own
        // to restore.
        return { kind: 'write', wrapped: { statusLine: displaced.statusLine, origin } }
      }
      continue
    }
    const statusLine = wrappableStatusLine(raw)
    if (statusLine) return { kind: 'write', wrapped: { statusLine, origin } }
    return oursIsInstalled ? { kind: 'remove' } : { kind: 'leave' }
  }
  return { kind: 'write', wrapped: null }
}

/**
 * Write our status line into a settings object, preserving every other key.
 * `padding` and `refreshInterval` are carried over from the status line we
 * displaced: they configure how Claude RUNS the command (indentation, and the
 * timer that re-runs it while the session is idle), so dropping them would
 * silently change the behaviour of the person's own script, which is still the
 * one printing.
 */
function applyStatusLineForwarder(settings: ClaudeSettings, install: StatusLineForwarderInstall): void {
  if (install.action === 'remove') {
    removeStatusLineForwarder(settings)
    return
  }
  // The scan read this file, and the copy of the forwarder happened after. A
  // status line written into that window — Claude Code's own `/statusline`, a
  // person with an editor open — is not the one we resolved against, and
  // overwriting it would lose it AND record the stale value as the thing to
  // restore. Leave it; the next install wraps it properly.
  const current = settings.statusLine
  if (
    isRecord(current)
    && !isOurStatusLine(current)
    && JSON.stringify(current) !== JSON.stringify(install.wrapped?.statusLine ?? null)
  ) {
    return
  }
  const ours: Record<string, unknown> = { type: 'command', command: install.command }
  const padding = install.wrapped?.statusLine.padding
  if (typeof padding === 'number' && Number.isFinite(padding)) ours.padding = padding
  const refreshInterval = install.wrapped?.statusLine.refreshInterval
  if (typeof refreshInterval === 'number' && Number.isFinite(refreshInterval)) {
    ours.refreshInterval = refreshInterval
  }
  ours._multicode = true
  // Verbatim, so restore is byte-identical to what was there. Explicitly null
  // (rather than absent) when we installed over nothing: uninstall reads the
  // difference between "restore this" and "delete the key".
  ours._multicodeWrapped = install.wrapped?.statusLine ?? null
  if (install.wrapped) ours._multicodeWrappedFrom = install.wrapped.origin
  settings.statusLine = ours
}

/**
 * Take our status line back out of a settings object, putting back the one it
 * displaced. Restoring is not the same question as wrapping: this puts a value
 * BACK where it was, so a status line we could no longer run for them is still
 * theirs to have.
 *
 * Only a status line displaced from THIS file is restored — one that came from
 * the project or user settings is still sitting in its own file, untouched, and
 * copying it down here would shadow every later edit of the original. An entry
 * whose bookkeeping a schema-normalizing writer stripped is restored from our
 * own argv, which is then the only copy of it left anywhere; and an entry with
 * no recorded origin predates the bookkeeping. Both of those restore, which is
 * the direction that keeps a command running.
 */
function removeStatusLineForwarder(settings: ClaudeSettings): void {
  const current = settings.statusLine
  if (!isOurStatusLine(current) || !isRecord(current)) return
  const previous = current._multicodeWrapped
  const recordedOrigin = recordedStatusLineOrigin(current)
  const restorable = recordedOrigin === null || recordedOrigin === 'local'
  if (restorable && isRecord(previous) && !isOurStatusLine(previous)) {
    settings.statusLine = previous
    return
  }
  // Gated on the same `restorable`: an origin that survived the stripping still
  // says the command came from another file, where it is still sitting.
  if (restorable && previous === undefined) {
    const recovered = statusLineFromWrapArgument(current)
    if (recovered) {
      settings.statusLine = recovered
      return
    }
  }
  delete settings.statusLine
}

/**
 * Work out what the status line should be and copy the forwarder into place,
 * ready for the settings write to carry it. Returns null when nothing should be
 * written - and null is the safe answer for every failure here, because the
 * hooks are the load-bearing half of this install and a status line must never
 * cost a workspace its agent state.
 *
 * Nothing is written when the person's own status line is one we cannot run for
 * them: displacing a setting we merely failed to recognize would delete it.
 */
async function prepareStatusLineForwarder(
  workspaceRoot: string,
  settingsPath: string,
  options: { statusLineScriptPath: string; socketPath: string; homeDir: string; env: NodeJS.ProcessEnv }
): Promise<StatusLineForwarderInstall | null> {
  try {
    const resolved = await resolveWrappedStatusLine(settingsPath, {
      homeDir: options.homeDir,
      env: options.env,
    })
    if (resolved.kind === 'leave') return null
    // Resolved BEFORE the script is looked for: taking ours back out of the way
    // of a status line we cannot wrap is exactly the thing a build that shipped
    // without the forwarder still has to be able to do.
    if (resolved.kind === 'remove') return { action: 'remove' }
    if (!existsSync(options.statusLineScriptPath)) return null
    const destScript = resolve(workspaceRoot, STATUS_LINE_HOOK_SCRIPT_REL)
    const command = buildStatusLineForwarderCommand(destScript, options.socketPath, resolved.wrapped)
    // A command the platform will not run is not one to install: cmd.exe caps a
    // command line at 8191 characters, and the base64 envelope is a third longer
    // than what it carries. Their status line stays exactly as it is.
    if (command.length > MAX_STATUS_LINE_RENDERED_COMMAND_LENGTH) return null
    await mkdir(resolve(destScript, '..'), { recursive: true })
    await copyFile(options.statusLineScriptPath, destScript)
    return { action: 'write', command, wrapped: resolved.wrapped }
  } catch {
    return null
  }
}

/** Put the person's status line back, on disk. */
async function unmergeStatusLineForwarder(settingsPath: string): Promise<void> {
  const existing = await readJsonIfExists<ClaudeSettings>(settingsPath)
  if (!existing) return
  // A status line that is not ours is left exactly as it is — a person who
  // replaced ours by hand has said what they want, and uninstall is not the
  // place to argue.
  if (!isOurStatusLine(existing.statusLine)) return
  removeStatusLineForwarder(existing)
  await writeFile(settingsPath, JSON.stringify(existing, null, 2) + '\n', 'utf8')
}

// =============================================================================
// Flat hooks JSON (registration kind 'flat-hooks-json')
//
// Cursor's hooks.json: { "version": 1, "hooks": { "<event>": [ { "command",
// "timeout"?, "matcher"? } ] } } — event keys map straight to entry arrays,
// with no matcher-block nesting. The file is shared with the user's own hooks,
// so this merges rather than owns. Unlike the Claude settings writer, NO
// `_multicode` tag key is written: the entry schema is the vendor's, an
// unknown key risks strict-validation rejection, and the command-shape
// signature (the same one that reclaims tag-stripped Claude entries) is a
// sufficient identity on its own.
// =============================================================================

type FlatHooksEntry = { command?: unknown; [key: string]: unknown }

type FlatHooksFile = {
  version?: unknown
  hooks?: Record<string, FlatHooksEntry[]>
  [key: string]: unknown
}

function isAgentStateFlatEntry(entry: FlatHooksEntry): boolean {
  return (
    typeof entry?.command === 'string' &&
    entry.command.startsWith('node "') &&
    entry.command.includes(AGENT_STATE_COMMAND_SIGNATURE)
  )
}

function stripFlatAgentStateEntries(hooks: Record<string, FlatHooksEntry[]>): void {
  for (const event of Object.keys(hooks)) {
    const entries = hooks[event]
    if (!Array.isArray(entries)) continue
    const kept = entries.filter((entry) => !isAgentStateFlatEntry(entry))
    if (kept.length === 0) delete hooks[event]
    else hooks[event] = kept
  }
}

async function mergeFlatAgentStateHooks(
  hooksPath: string,
  command: string,
  events: ReadonlyArray<{ event: string; matcher?: string }>
): Promise<void> {
  const existing = (await readJsonIfExists<FlatHooksFile>(hooksPath)) ?? {}
  const file: FlatHooksFile = { ...existing }
  if (typeof file.version !== 'number') file.version = 1
  // An array-shaped `hooks` (malformed — the vendor schema wants an object)
  // would silently swallow string-keyed event assignments; replace it so the
  // registration actually lands rather than reporting ok and installing nothing.
  if (!file.hooks || typeof file.hooks !== 'object' || Array.isArray(file.hooks)) file.hooks = {}

  // Clean up first (all event keys, incl. ones we no longer register), then add
  // the current set — install is both idempotent and a migration.
  stripFlatAgentStateEntries(file.hooks)
  for (const { event, matcher } of events) {
    if (!Array.isArray(file.hooks[event])) file.hooks[event] = []
    const entry: FlatHooksEntry = matcher === undefined ? { command } : { command, matcher }
    file.hooks[event].push(entry)
  }

  await mkdir(resolve(hooksPath, '..'), { recursive: true })
  await writeFile(hooksPath, JSON.stringify(file, null, 2) + '\n', 'utf8')
}

async function unmergeFlatAgentStateHooks(hooksPath: string): Promise<void> {
  const existing = await readJsonIfExists<FlatHooksFile>(hooksPath)
  if (!existing?.hooks || typeof existing.hooks !== 'object' || Array.isArray(existing.hooks)) return
  stripFlatAgentStateEntries(existing.hooks)
  // Match the settings-json unmerge: an emptied hooks map is deleted rather
  // than left as a `"hooks": {}` stub.
  if (Object.keys(existing.hooks).length === 0) delete existing.hooks
  await writeFile(hooksPath, JSON.stringify(existing, null, 2) + '\n', 'utf8')
}

// =============================================================================
// TOML managed block (registration kind 'toml-block')
//
// A single tagged managed block (own markers, never the MCP block's) so the
// rest of the user's config file is preserved and the block is idempotently
// replaceable — the same discipline the MCP writer uses, which avoids the known
// footgun of an installer corrupting config.toml. The marker literals predate
// this generic writer (they shipped with the Codex integration) and MUST stay
// byte-identical so existing installed blocks are still recognized and replaced.
// =============================================================================

const AGENT_STATE_TOML_START = '# >>> multicode agent-state hooks managed'
const AGENT_STATE_TOML_END = '# <<< multicode agent-state hooks managed'

// TOML basic strings share JSON's escaping (matches the repo's MCP writer), so
// JSON.stringify yields a valid quoted value — and correctly escapes the Windows
// pipe path's backslashes.
function tomlBasicString(value: string): string {
  return JSON.stringify(value)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function renderTomlAgentStateHooksBlock(
  command: string,
  events: ReadonlyArray<{ event: string; matcher?: string }>
): string {
  const lines: string[] = [
    AGENT_STATE_TOML_START,
    '# Generated for authoritative agent-state reporting. Remove this block to disable.',
  ]
  for (const { event, matcher } of events) {
    lines.push('', `[[hooks.${event}]]`)
    if (matcher !== undefined) lines.push(`matcher = ${tomlBasicString(matcher)}`)
    lines.push(`[[hooks.${event}.hooks]]`, 'type = "command"', `command = ${tomlBasicString(command)}`)
  }
  lines.push(AGENT_STATE_TOML_END)
  return lines.join('\n')
}

// Replace (or, with an empty block, remove) our managed hooks block, preserving
// everything else in the file. Mirrors the MCP writer's replaceManagedBlock.
function replaceTomlAgentStateBlock(previous: string, block: string): string {
  const pattern = new RegExp(`${escapeRegExp(AGENT_STATE_TOML_START)}[\\s\\S]*?${escapeRegExp(AGENT_STATE_TOML_END)}\\n?`, 'm')
  const trimmed = previous.replace(pattern, '').trimEnd()
  if (!block) return trimmed ? `${trimmed}\n` : ''
  return `${trimmed}${trimmed ? '\n\n' : ''}${block}\n`
}

export function mergeTomlAgentStateHooks(
  previous: string,
  command: string,
  events: ReadonlyArray<{ event: string; matcher?: string }>
): string {
  return replaceTomlAgentStateBlock(previous, renderTomlAgentStateHooksBlock(command, events))
}

export function unmergeTomlAgentStateHooks(previous: string): string {
  return replaceTomlAgentStateBlock(previous, '')
}

// The array-of-tables variant (registration kind 'toml-array-block'): Kimi
// Code's hooks are `[[hooks]]` entries with an `event` key per table, not
// Codex's `[[hooks.<Event>]]` nesting. Same marker discipline (and the same
// marker literals — the two kinds never share a file, since each CLI names its
// own config path).
export function renderTomlArrayAgentStateHooksBlock(
  command: string,
  events: ReadonlyArray<{ event: string; matcher?: string }>
): string {
  const lines: string[] = [
    AGENT_STATE_TOML_START,
    '# Generated for authoritative agent-state reporting. Remove this block to disable.',
  ]
  for (const { event, matcher } of events) {
    lines.push('', '[[hooks]]', `event = ${tomlBasicString(event)}`)
    if (matcher !== undefined) lines.push(`matcher = ${tomlBasicString(matcher)}`)
    lines.push(`command = ${tomlBasicString(command)}`)
  }
  lines.push(AGENT_STATE_TOML_END)
  return lines.join('\n')
}

export function mergeTomlArrayAgentStateHooks(
  previous: string,
  command: string,
  events: ReadonlyArray<{ event: string; matcher?: string }>
): string {
  return replaceTomlAgentStateBlock(previous, renderTomlArrayAgentStateHooksBlock(command, events))
}

async function readTextIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

// =============================================================================
// Owned JSON hook config (registration kind 'owned-json')
//
// For CLIs whose hook discovery is per-file (Grok Build reads standalone JSON
// files under .grok/hooks/*.json) we own our config file outright: install is a
// plain write, uninstall a plain remove — no merge/unmerge bookkeeping. The
// per-event structure ({ matcher?, hooks: [{ type: 'command', command }] })
// mirrors Claude Code's settings hooks, which is the format Grok documents.
//
// SPELLING (MC-2520). Event names are written here EXACTLY as the manifest
// spells them — no folding on the way out. Config spelling is a property of the
// registration kind and is not the same question as frame matching
// (canonicalEventName), which is deliberately spelling-blind because a CLI's
// payload spelling need not match its config spelling.
//
// Verified against grok 1.0.13 on 2026-09-09 by writing candidate
// `.grok/hooks/*.json` files and counting what `grok inspect` loaded (its
// loader filters unknown event names — a file of invented names loads 0):
//   PascalCase  `PreToolUse`    loaded (all 15 events)  <- what we emit
//   snake_case  `pre_tool_use`  loaded
//   camelCase   `preToolUse`    loaded (documented Cursor-compat alias)
//   kebab-case  `pre-tool-use`  SKIPPED
//   SCREAMING   `PRETOOLUSE`    SKIPPED
// So Grok accepts a fixed alias SET, not arbitrary case folding, and the
// manifest's PascalCase is inside it: this emitter needs no per-kind rule
// today. If a future owned-json CLI reads only one spelling, convert HERE
// (keyed off the registration kind) and leave both the manifest's written form
// and canonical matching alone.
// =============================================================================

export function renderOwnedJsonAgentStateHooksConfig(
  command: string,
  events: ReadonlyArray<{ event: string; matcher?: string }>
): string {
  const hooks: Record<string, Array<Record<string, unknown>>> = {}
  for (const { event, matcher } of events) {
    const block: Record<string, unknown> = {}
    if (matcher !== undefined) block.matcher = matcher
    block.hooks = [{ type: 'command', command }]
    hooks[event] = [block]
  }
  return JSON.stringify({ hooks }, null, 2) + '\n'
}

// =============================================================================
// Plugin-file reporter (registration kind 'plugin-file')
//
// For CLIs with no command-hook mechanism (OpenCode auto-loads in-process JS
// plugins and exposes a typed event stream), the reporter is a bundled plugin
// TEMPLATE named by the manifest's registration. It subscribes to the CLI's
// events itself and emits the same socket frames; the manifest's `events` table
// remains the canonical event→phase mapping the main process applies — the
// template's internal mapping only decides which events it reports and dedups
// on (frame `phase` is consulted solely when no spec entry resolves the event).
//
// A plugin can't take a --socket arg, so the live socket path is baked into the
// file at install time (token substitution); the plugin also honours
// MULTICODE_AGENT_STATE_SOCKET as a fallback. Note the OpenCode dest extension
// is .js while the bundled template ships as .mjs (the packaging filter is
// **/*.mjs; OpenCode's loader picks up .js/.ts but not .mjs, verified against
// opencode v1.17.11) — the manifest declares both names, so the rename is data.
// =============================================================================

// The quoted token in a plugin template that install replaces with the live
// socket path. Replacing the WHOLE quoted literal with JSON.stringify(path) keeps
// the value valid even for a Windows pipe path full of backslashes (splicing a
// bare string back inside the quotes would let those backslashes act as JS
// escapes and corrupt the path).
const PLUGIN_SOCKET_PLACEHOLDER = "'__MULTICODE_AGENT_STATE_SOCKET__'"

export function renderAgentStatePluginTemplate(template: string, socketPath: string): string {
  return template.split(PLUGIN_SOCKET_PLACEHOLDER).join(JSON.stringify(socketPath))
}

// =============================================================================
// Install / uninstall — one dispatcher over the spec's registration kind
//
// The caller (the Electron-bound service) resolves the bundled reporter script
// (the shared stdin filter, or the plugin-file template the registration
// names) and the live socket path; this stays free of Electron so it is
// testable. Strictly best-effort at the call site: a failed install must never
// block or break the launch that awaits it.
// =============================================================================

export type AgentStateInstallResult =
  | { ok: true; settingsPath: string; hookScriptPath: string }
  | { ok: false; message: string }

// A user-scoped registration (Kimi Code's user-global config.toml) resolves
// against the home directory instead of the workspace. `homeDir` is injectable
// so tests never touch the real home.
function resolveRegistrationPath(
  workspaceRoot: string,
  registration: PluginAgentStateSpec['registration'],
  homeDir: string
): string {
  const base = registration.scope === 'user' ? homeDir : workspaceRoot
  return resolve(base, ...registration.path.split('/'))
}

export async function installAgentStateReporter(
  workspaceRoot: string,
  spec: PluginAgentStateSpec,
  options: {
    sourceScriptPath: string
    socketPath: string
    homeDir?: string
    // The bundled status-line forwarder, for a spec that opts into it. Null or
    // absent (the script did not ship, or this CLI declares no status line) and
    // the install writes hooks only — a missing forwarder must never cost a
    // workspace its agent state.
    statusLineScriptPath?: string | null
    // Environment the Claude settings precedence is read against
    // (CLAUDE_CONFIG_DIR). Injected so tests never read the real one.
    env?: NodeJS.ProcessEnv
  }
): Promise<AgentStateInstallResult> {
  if (!workspaceRoot?.trim()) return { ok: false, message: 'Workspace root is required.' }
  if (!options.socketPath?.trim()) return { ok: false, message: 'Agent-state socket path is required.' }
  if (!options.sourceScriptPath || !existsSync(options.sourceScriptPath)) {
    return { ok: false, message: 'Agent-state reporter script is missing from this build.' }
  }

  const registration = spec.registration
  try {
    const homeDir = options.homeDir ?? homedir()
    const targetPath = resolveRegistrationPath(workspaceRoot, registration, homeDir)
    await mkdir(resolve(targetPath, '..'), { recursive: true })

    if (registration.kind === 'plugin-file') {
      const template = await readFile(options.sourceScriptPath, 'utf8')
      await writeFile(targetPath, renderAgentStatePluginTemplate(template, options.socketPath), 'utf8')
      return { ok: true, settingsPath: targetPath, hookScriptPath: targetPath }
    }

    // Command-hook kinds share the stdin-filter reporter, referenced by its
    // ABSOLUTE path (hook commands run with no guaranteed cwd). The copy lives
    // where the REGISTRATION lives: a workspace-scoped registration uses the
    // workspace copy; a user-scoped one (a user-global config like Kimi's)
    // gets a home-scoped copy (~/.multicode/hooks/) — pointing a user-global
    // config into a workspace would dangle machine-wide the moment that
    // workspace (or a sprint's finalize-deleted worktree) goes away, firing
    // MODULE_NOT_FOUND for every session of that CLI until reinstalled.
    const destScript =
      registration.scope === 'user'
        ? resolve(homeDir, AGENT_STATE_HOOK_SCRIPT_REL)
        : resolve(workspaceRoot, AGENT_STATE_HOOK_SCRIPT_REL)
    await mkdir(resolve(destScript, '..'), { recursive: true })
    await copyFile(options.sourceScriptPath, destScript)
    const command = buildAgentStateReporterCommand(destScript, options.socketPath)
    const events = registeredAgentStateEvents(spec)

    switch (registration.kind) {
      case 'settings-json': {
        // The status line rides the same settings file and the same WRITE.
        // Workspace-scoped only: the precedence scan reads the project's own
        // .claude/, which a user-global registration has none of. Everything
        // about it is best-effort — it resolves to null rather than throwing,
        // so the hooks land whatever happens to it.
        const statusLine =
          spec.statusLine === true && registration.scope !== 'user' && options.statusLineScriptPath
            ? await prepareStatusLineForwarder(workspaceRoot, targetPath, {
                statusLineScriptPath: options.statusLineScriptPath,
                socketPath: options.socketPath,
                homeDir,
                env: options.env ?? process.env,
              })
            : null
        await mergeAgentStateHooks(targetPath, command, events, statusLine)
        break
      }
      case 'flat-hooks-json':
        await mergeFlatAgentStateHooks(targetPath, command, events)
        break
      case 'toml-block': {
        const previous = (await readTextIfExists(targetPath)) ?? ''
        await writeFile(targetPath, mergeTomlAgentStateHooks(previous, command, events), 'utf8')
        break
      }
      case 'toml-array-block': {
        const previous = (await readTextIfExists(targetPath)) ?? ''
        await writeFile(targetPath, mergeTomlArrayAgentStateHooks(previous, command, events), 'utf8')
        break
      }
      case 'owned-json':
        await writeFile(targetPath, renderOwnedJsonAgentStateHooksConfig(command, events), 'utf8')
        break
    }
    return { ok: true, settingsPath: targetPath, hookScriptPath: destScript }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'Failed to install agent-state reporter.',
    }
  }
}

export async function uninstallAgentStateReporter(
  workspaceRoot: string,
  spec: PluginAgentStateSpec,
  options: { homeDir?: string } = {}
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!workspaceRoot?.trim()) return { ok: false, message: 'Workspace root is required.' }
  const registration = spec.registration
  try {
    const targetPath = resolveRegistrationPath(workspaceRoot, registration, options.homeDir ?? homedir())
    switch (registration.kind) {
      case 'settings-json': {
        if (existsSync(targetPath)) {
          await unmergeAgentStateHooks(targetPath)
          // Unconditional, never gated on spec.statusLine: a spec that turned
          // the flag OFF must still be able to give a person their status line
          // back.
          await unmergeStatusLineForwarder(targetPath)
        }
        const destStatusLine = resolve(workspaceRoot, STATUS_LINE_HOOK_SCRIPT_REL)
        if (existsSync(destStatusLine)) await rm(destStatusLine, { force: true })
        // The copied stdin-filter reporter is shared by every command-hook
        // registration in the workspace; the settings-json uninstall owns its
        // removal (legacy behavior — the other kinds leave it in place).
        const destScript = resolve(workspaceRoot, AGENT_STATE_HOOK_SCRIPT_REL)
        if (existsSync(destScript)) await rm(destScript, { force: true })
        break
      }
      case 'flat-hooks-json':
        if (existsSync(targetPath)) await unmergeFlatAgentStateHooks(targetPath)
        break
      case 'toml-block':
      case 'toml-array-block': {
        const previous = await readTextIfExists(targetPath)
        if (previous !== null) await writeFile(targetPath, unmergeTomlAgentStateHooks(previous), 'utf8')
        break
      }
      case 'owned-json':
      case 'plugin-file':
        if (existsSync(targetPath)) await rm(targetPath, { force: true })
        break
    }
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'Failed to uninstall agent-state reporter.',
    }
  }
}
