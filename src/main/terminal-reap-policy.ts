import type { AgentPhase } from '../shared/electron-api'

// Memory-bounded agent lifecycle: decide which idle agent terminals are safe to
// SUSPEND (kill the process, preserve resume) so a long session doesn't
// accumulate dozens of idle agents holding GBs.
//
// This module is PURE and side-effect free. Reaping is driven by RECENCY plus
// the AUTHORITATIVE agent phase reported by the CLI's lifecycle hooks
// (`agentPhase`). The phase is what lets us reclaim a terminal that is on screen
// but dormant while never touching one that is mid-work or waiting on the user:
//   * `agentPhase` — 'idle' (turn finished, at rest) and 'stalled' (claimed
//     working, then BOTH hook frames and output went quiet ≥90s) are the
//     reapable states; both still ride the full idle clock below, so a stalled
//     session is only reclaimed after resting past the threshold. Stalled is
//     inference-sourced and expiring it is deliberate: a lost Stop frame lands
//     a genuinely-finished agent there, and treating it as protected parked
//     sessions forever (2026-07-07 incident). The residual risk — a silent
//     hung-but-recoverable tool call reclaimed after threshold+90s of total
//     silence — is accepted; suspend is non-destructive for plain agents and
//     sprint agents respawn via the dispatch revival path.
//     'starting'/'thinking'/'tool_use' (working) are NEVER reaped: killing
//     them would abort a real command. (A 'starting' session that goes quiet
//     converts to 'stalled' via the runtime stall watch, so a resumed-but-
//     never-prompted agent expires instead of parking.) 'awaiting_input' is
//     NEVER reaped: it needs the user, so freezing it is wrong. Every agent
//     carries a phase from birth (the spawn stamp; output-timing inference was
//     deleted 2026-08-31), so a null phase means a non-agent candidate — the
//     recency floor below is its only clock, and for agents the null branch is
//     defensive dead code kept because ambiguity must hold a terminal ALIVE.
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

// Recency floor: the sweep never reaps below this many live agent terminals —
// the N most recently used stay running even when they qualify for pausing, so
// a user's active set of long-running agents can't all be reclaimed out from
// under them. 0 restores the old reap-everything-idle behavior. All the
// per-session gates above still apply; the floor only bounds how MANY of the
// reapable set are acted on (oldest-rested first).
export const DEFAULT_KEEP_RECENT_TERMINALS_ALIVE = 3
export const MIN_KEEP_RECENT_TERMINALS_ALIVE = 0
export const MAX_KEEP_RECENT_TERMINALS_ALIVE = 20

// Coerce an arbitrary value to a valid keep-alive count, or return the default
// when it isn't a usable finite number. Pure; reused on both sides.
export function clampKeepRecentTerminalsAlive(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_KEEP_RECENT_TERMINALS_ALIVE
  return Math.max(
    MIN_KEEP_RECENT_TERMINALS_ALIVE,
    Math.min(MAX_KEEP_RECENT_TERMINALS_ALIVE, Math.round(value))
  )
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
  // When the agent entered its current at-rest phase (`agentState.since` when
  // the phase is 'idle' or 'stalled'), else null. Pushes the idle clock forward
  // for an agent that worked silently then just went idle — or just stalled, so
  // a stalled session gets the full threshold from the stall flag, not from its
  // last keystroke.
  idleSince: number | null
  // Caller-supplied: the terminal belongs to an active managed run (e.g. a
  // SprintEngine agent). Defaults to the SAFE value (true) when unsure.
  inActiveRun: boolean
  // Caller-supplied: an orchestrator-managed SprintEngine terminal (has a run
  // statePath). Excluded from the recency floor entirely — the floor is a
  // promise about the USER'S terminals: engine agents of a finished run must
  // not occupy keep-alive slots (evicting the user's own terminals from their
  // budget) nor be spared from the dispose path that closes the
  // parked-until-teardown memory gap.
  sprintManaged: boolean
  // User lock ("keep running"): the user explicitly exempted this terminal from
  // reaping via its lock control. Absolute — no idle clock ever overrides it.
  reapExempt: boolean
  // When the agent self-scheduled a wakeup (ScheduleWakeup hook frame), the
  // epoch-ms time it fires; null when none is pending. The timer lives inside
  // the CLI process — reaping cancels it and nothing ever wakes the agent — so
  // a future wakeup holds the session regardless of how long it has rested.
  // A past wakeup never holds: either it fired (any follow-up work shows up
  // through the phase gates) or the process died — both reap-safe.
  pendingWakeupAt: number | null
}

export type ReapPolicyOptions = {
  now?: number
  idleThresholdMs?: number
  // Recency floor: never reap below this many live agent terminals. Omitted
  // means NO floor (pure per-session gates only) — the runtime sweep always
  // passes its configured value, which defaults to
  // DEFAULT_KEEP_RECENT_TERMINALS_ALIVE.
  keepRecentAliveCount?: number
}

export type ReapDecision = {
  // Sessions safe to suspend now.
  reapableSessionIds: string[]
  // Sessions that passed every per-session gate but were spared by the recency
  // floor (they are among the N most recently used live agents). Surfaced so
  // the sweep's skip audit can name the floor as the holding reason.
  heldByRecencyFloorSessionIds: string[]
}

// Which gate held a non-reapable session. Powers the persisted skip audit
// ("would have been reaped but for X") — the 2026-07-07 parked-agents incident
// was diagnosable only by timer-alignment forensics because skips left no
// record of the holding gate.
export type ReapHold =
  | 'dead_process'
  | 'not_agent'
  | 'no_workspace'
  | 'user_locked'
  | 'in_active_run'
  | 'pending_wakeup'
  | 'phase_awaiting_input'
  | 'phase_working'
  | 'phase_unrestful'
  | 'resting_recently'

export type ReapExplanation =
  | { verdict: 'reapable'; restingForMs: number }
  // `restingForMs` is how long the session has been at rest by the same clock
  // the reap decision uses — the skip audit compares it to the threshold to
  // separate "parked past threshold by a gate" (worth logging) from routine
  // "not idle long enough yet" (noise).
  | { verdict: 'held'; hold: ReapHold; restingForMs: number }

// Single source of truth for the reap decision, with the holding gate named.
// Order is cheap-checks-first; `isSessionReapable` is the boolean projection.
export function explainSessionReapDecision(
  candidate: ReapCandidate,
  options: { now: number; idleThresholdMs: number }
): ReapExplanation {
  const restingSince = Math.max(candidate.lastInteractionAt, candidate.idleSince ?? 0)
  const restingForMs = options.now - restingSince

  if (!candidate.processAlive) return { verdict: 'held', hold: 'dead_process', restingForMs }
  if (candidate.kind !== 'agent') return { verdict: 'held', hold: 'not_agent', restingForMs }
  if (candidate.workspaceId === null) return { verdict: 'held', hold: 'no_workspace', restingForMs }
  if (candidate.reapExempt) return { verdict: 'held', hold: 'user_locked', restingForMs }
  if (candidate.inActiveRun) return { verdict: 'held', hold: 'in_active_run', restingForMs }
  if (candidate.pendingWakeupAt !== null && candidate.pendingWakeupAt > options.now) {
    return { verdict: 'held', hold: 'pending_wakeup', restingForMs }
  }

  const phase = candidate.agentPhase
  if (phase !== null) {
    // Never reap an agent waiting on the user or actively working. At-rest
    // phases — 'idle' (authoritative) and 'stalled' (inferred quiet; expires
    // like idle, see header) — proceed to the idle clock. exited/failed are
    // dead and already excluded by processAlive, but guard explicitly.
    if (phase === 'awaiting_input') return { verdict: 'held', hold: 'phase_awaiting_input', restingForMs }
    if (WORKING_PHASES.has(phase)) return { verdict: 'held', hold: 'phase_working', restingForMs }
    if (phase !== 'idle' && phase !== 'stalled') return { verdict: 'held', hold: 'phase_unrestful', restingForMs }
  }

  // Idle clock: time since the user last interacted OR the agent went to rest,
  // whichever is more recent.
  if (restingForMs <= options.idleThresholdMs) {
    return { verdict: 'held', hold: 'resting_recently', restingForMs }
  }
  return { verdict: 'reapable', restingForMs }
}

// True only when EVERY gate passes. Order is cheap-checks-first, but the result
// is the conjunction either way.
export function isSessionReapable(
  candidate: ReapCandidate,
  options: { now: number; idleThresholdMs: number }
): boolean {
  return explainSessionReapDecision(candidate, options).verdict === 'reapable'
}

export function selectReapableSessions(
  candidates: readonly ReapCandidate[],
  options: ReapPolicyOptions = {}
): ReapDecision {
  const now = options.now ?? Date.now()
  const idleThresholdMs = options.idleThresholdMs ?? DEFAULT_SUSPEND_IDLE_AFTER_MS
  const keepRecentAliveCount =
    options.keepRecentAliveCount === undefined
      ? 0
      : clampKeepRecentTerminalsAlive(options.keepRecentAliveCount)

  const reapable = candidates.filter((candidate) =>
    isSessionReapable(candidate, { now, idleThresholdMs })
  )

  // Recency floor: cap how many of the reapable set are acted on so at least
  // `keepRecentAliveCount` live agent terminals remain after the sweep. The
  // floor is a USER-terminal promise, so SprintEngine-managed sessions are out
  // of scope on both sides: they neither occupy keep-alive slots (a finished
  // run's engine agents must not evict the user's own terminals from their
  // budget) nor gain protection (inactive-run agents are disposed to close the
  // parked-until-teardown memory gap; the dispatch respawns them on demand).
  // Held (working / awaiting-input / recently-rested) live user agents already
  // count toward the floor — the cap only bites when reaping the full set would
  // drop the live user-agent population below N. Oldest-rested reap first, so
  // the spared remainder is always the most recently used.
  const sprintReapable = reapable.filter((candidate) => candidate.sprintManaged)
  const userReapable = reapable.filter((candidate) => !candidate.sprintManaged)
  const liveUserAgentCount = candidates.filter(
    (candidate) => candidate.processAlive && candidate.kind === 'agent' && !candidate.sprintManaged
  ).length
  const maxUserReapable = Math.max(0, liveUserAgentCount - keepRecentAliveCount)

  if (userReapable.length <= maxUserReapable) {
    return {
      reapableSessionIds: reapable.map((candidate) => candidate.sessionId),
      heldByRecencyFloorSessionIds: [],
    }
  }

  const restingSince = (candidate: ReapCandidate): number =>
    Math.max(candidate.lastInteractionAt, candidate.idleSince ?? 0)
  const oldestFirst = [...userReapable].sort((a, b) => restingSince(a) - restingSince(b))
  return {
    reapableSessionIds: [
      ...sprintReapable.map((candidate) => candidate.sessionId),
      ...oldestFirst.slice(0, maxUserReapable).map((candidate) => candidate.sessionId),
    ],
    heldByRecencyFloorSessionIds: oldestFirst.slice(maxUserReapable).map((candidate) => candidate.sessionId),
  }
}
