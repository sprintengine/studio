import { existsSync } from 'fs'
import { copyFile, mkdir, readFile, rm, writeFile } from 'fs/promises'
import { homedir } from 'os'
import { join, resolve, sep } from 'path'
import type { AgentPhase, AgentStateSource, SessionActivity } from '../shared/electron-api'
import type { PluginAgentStateSpec } from '../shared/plugin-manifest'
import { isAbsoluteObservedPath, MAX_OBSERVED_CWD_LENGTH } from '../shared/observed-checkout'
import { isRecord } from '../shared/records'

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
    const entry = spec.events.find((candidate) => candidate.event === frame.event)
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
 */
const PROMPT_REPORTING_EVENTS: ReadonlySet<string> = new Set(['UserPromptSubmit', 'beforeSubmitPrompt'])

/**
 * True when this CLI's manifest declares an event that carries what the person
 * typed. The conversation peek asks this to tell "has said nothing yet" apart
 * from "cannot report at all" — OpenCode has an agentStateSpec and still
 * forwards no prompt, so the presence of a spec is not the same question.
 */
export function agentStateSpecReportsPrompts(
  spec: Pick<PluginAgentStateSpec, 'events'> | null | undefined
): boolean {
  return Boolean(spec?.events.some((entry) => PROMPT_REPORTING_EVENTS.has(entry.event)))
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
}

// A path this long is a broken reporter, not a file. Same bound as the observed
// cwd, and for the same reason: the value is retained per session and broadcast
// to every renderer.
export const MAX_FILE_CHANGE_PATH_LENGTH = MAX_OBSERVED_CWD_LENGTH

// A single tool call cannot honestly add ten million lines; past that the frame
// is anomalous. Capped rather than dropped, so an absurd count degrades to a
// large one instead of erasing the fact that the file was edited.
export const MAX_FILE_CHANGE_COUNT = 10_000_000

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
}

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
  return frame
}

// A reported file change must name an absolute path (a relative one is
// meaningless off the reporter's own process cwd, and the ledger is shown to a
// person as the file they can open) with two counts that are real, finite and
// not negative. Anything else drops the field — the frame still carries its
// phase, and a missing ledger entry is a smaller lie than a wrong one.
function parseFrameFileChange(raw: unknown): AgentStateFrameFileChange | null {
  if (!isRecord(raw)) return null
  const path = optionalString(raw.path)?.trim()
  if (!path) return null
  if (path.length > MAX_FILE_CHANGE_PATH_LENGTH) return null
  if (hasControlCharacters(path)) return null
  if (!isAbsoluteObservedPath(path)) return null
  const additions = parseFileChangeCount(raw.additions)
  const deletions = parseFileChangeCount(raw.deletions)
  if (additions === null || deletions === null) return null
  return { path, additions, deletions }
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
  events: ReadonlyArray<{ event: string; matcher?: string }>
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
  options: { sourceScriptPath: string; socketPath: string; homeDir?: string }
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
      case 'settings-json':
        await mergeAgentStateHooks(targetPath, command, events)
        break
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
        if (existsSync(targetPath)) await unmergeAgentStateHooks(targetPath)
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
