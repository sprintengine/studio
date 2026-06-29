import type { AgentPhase } from '../shared/electron-api'

// Memory-bounded agent lifecycle: decide which idle agent terminals are safe to
// SUSPEND (kill the process, preserve resume) so a long session doesn't
// accumulate dozens of idle agents holding GBs.
//
// This module is PURE and side-effect free. Reaping is driven by RECENCY plus
// the AUTHORITATIVE agent phase reported by the CLI's lifecycle hooks
// (`agentPhase`). The phase is what lets us reclaim a terminal that is on screen
// but dormant while never touching one that is mid-work or waiting on the user:
//   * `agentPhase` — 'idle' (turn finished, at rest) is the only reapable state.
//     'starting'/'thinking'/'tool_use' (working) and 'stalled' (claims working,
//     went quiet — may be a long in-flight tool call) are NEVER reaped: killing
//     them would abort a real command. 'awaiting_input' is NEVER reaped: it needs
//     the user, so freezing it is wrong. When no phase is known (a CLI with no
//     hooks and no inferred state), we fall back to the recency floor below.
//   * `lastInteractionAt` — real user input (keystrokes), repaint-immune. Combined
//     with `idleSince` it forms the idle clock. (NOT last *output*, which alt-screen
//     TUIs bump on every repaint.)
//   * `idleSince` — when the agent entered its current 'idle' phase. Stops a
//     freshly-idle agent (which may have worked for a long time with zero
//     keystrokes) from being reaped the instant it finishes its turn.
//   * `inActiveRun` — caller-supplied; protects managed runs (e.g. SprintEngine).
//   * `processAlive` — the pty lifecycle.
//
// Note: there is deliberately NO `visible` gate. "On screen" is not "in use" — a
// user with a dozen tiled terminals has many visible yet dormant. Visibility is
// not a reap signal; agent phase is. Freeze-the-view keeps a reaped terminal's
// painted scrollback readable and resumes it on the next keystroke, so suspending
// a visible-but-idle agent is non-destructive.
//
// Every gate must pass; anything ambiguous keeps the terminal ALIVE.

// How long an agent must sit IDLE (no work, no user interaction) before it's
// suspended. Measured from the last keystroke or the moment it went idle,
// whichever is later — so revealing a workspace can't reset it, and a
// just-finished agent isn't reaped on the spot. This is the DEFAULT/fallback;
// the user-configurable "Pause idle terminals after" setting overrides it at
// runtime (see setIdleSuspendThresholdMs in terminal-runtime).
export const DEFAULT_SUSPEND_IDLE_AFTER_MS = 15 * 60 * 1000

// Clamp bounds for the user-configurable idle-suspend threshold. 1 minute floor
// keeps the reaper from thrashing live agents; 24h ceiling is effectively "never
// for a working day". Shared by the renderer setting normalizer and the main IPC.
export const MIN_SUSPEND_IDLE_AFTER_MS = 60 * 1000
export const MAX_SUSPEND_IDLE_AFTER_MS = 24 * 60 * 60 * 1000

// Coerce an arbitrary value to a valid idle-suspend threshold in ms, or return
// the default when it isn't a usable finite number. Pure; reused on both sides.
export function clampSuspendIdleAfterMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_SUSPEND_IDLE_AFTER_MS
  return Math.max(MIN_SUSPEND_IDLE_AFTER_MS, Math.min(MAX_SUSPEND_IDLE_AFTER_MS, value))
}

// Phases in which the agent is actively doing work. Reaping one would kill an
// in-flight command, so these are never reapable.
const WORKING_PHASES: ReadonlySet<AgentPhase> = new Set(['starting', 'thinking', 'tool_use'])

export type ReapCandidate = {
  sessionId: string
  workspaceId: string | null
  // 'agent' terminals are the only suspend targets. Plain shells are cheap and
  // may hold a foreground command, so they are never suspended here.
  kind: string
  // Informational only (carried into the reap audit log). The policy does not
  // gate on the cli: any idle agent is reapable regardless of which CLI it runs.
  // Reaping kills the PTY; reopen relaunches via the plugin's resume command
  // where one is declared (exact for claude-code; codex reattaches its own
  // latest session). A cli with no resume support would relaunch fresh.
  cli: string | null
  processAlive: boolean
  // Authoritative (or inferred) agent phase from lifecycle hooks. `null` when no
  // agent state exists at all — then only the recency floor applies.
  agentPhase: AgentPhase | null
  // Max of started/lastInput — "when the user last interacted with this
  // terminal". Repaint-immune (real keystrokes only).
  lastInteractionAt: number
  // When the agent entered its current 'idle' phase (`agentState.since` when the
  // phase is idle), else null. Pushes the idle clock forward for an agent that
  // worked silently then just went idle.
  idleSince: number | null
  // Caller-supplied: the terminal belongs to an active managed run (e.g. a
  // SprintEngine agent). Defaults to the SAFE value (true) when unsure.
  inActiveRun: boolean
}

export type ReapPolicyOptions = {
  now?: number
  idleThresholdMs?: number
}

export type ReapDecision = {
  // Sessions safe to suspend now.
  reapableSessionIds: string[]
}

// True only when EVERY gate passes. Order is cheap-checks-first, but the result
// is the conjunction either way.
export function isSessionReapable(
  candidate: ReapCandidate,
  options: { now: number; idleThresholdMs: number }
): boolean {
  if (!candidate.processAlive) return false
  if (candidate.kind !== 'agent') return false
  if (candidate.workspaceId === null) return false
  if (candidate.inActiveRun) return false

  const phase = candidate.agentPhase
  if (phase !== null) {
    // Never reap an agent waiting on the user, stalled mid-tool-call, or
    // actively working. Only an at-rest ('idle') agent is reapable. exited/failed
    // are dead and already excluded by processAlive, but guard explicitly.
    if (phase === 'awaiting_input') return false
    if (phase === 'stalled') return false
    if (WORKING_PHASES.has(phase)) return false
    if (phase !== 'idle') return false
  }

  // Idle clock: time since the user last interacted OR the agent went idle,
  // whichever is more recent.
  const restingSince = Math.max(candidate.lastInteractionAt, candidate.idleSince ?? 0)
  return options.now - restingSince > options.idleThresholdMs
}

export function selectReapableSessions(
  candidates: readonly ReapCandidate[],
  options: ReapPolicyOptions = {}
): ReapDecision {
  const now = options.now ?? Date.now()
  const idleThresholdMs = options.idleThresholdMs ?? DEFAULT_SUSPEND_IDLE_AFTER_MS

  const reapableSessionIds = candidates
    .filter((candidate) => isSessionReapable(candidate, { now, idleThresholdMs }))
    .map((candidate) => candidate.sessionId)

  return { reapableSessionIds }
}
