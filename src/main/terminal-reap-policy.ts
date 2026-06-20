// Memory-bounded agent lifecycle: decide which idle agent terminals are safe to
// SUSPEND (kill the process, preserve resume) so a long session doesn't
// accumulate dozens of idle agents holding GBs.
//
// This module is PURE and side-effect free. It is deliberately driven only by
// REPAINT-IMMUNE signals, because alt-screen TUIs (Claude/Codex) repaint on
// resize/reveal and that repaint output would otherwise masquerade as agent
// activity:
//   * `lastInteractionAt` — real user input (keystrokes), which a repaint never
//     generates. This is the idle clock. (NOT last *output*, which repaints bump.)
//   * `visible` — whether the terminal is on screen right now.
//   * `processAlive` — the pty lifecycle.
//   * `inActiveRun` — caller-supplied; protects managed runs.
// We deliberately do NOT gate on `activity === 'idle'` or a live-child probe:
// both were output-/heuristic-derived and unreliable (the activity flag flips to
// "working" on a repaint). A genuinely busy agent is caught by user input or the
// run-active signal; the rare "streaming with zero input for hours" case is
// (correctly) reapable and stays readable + resumable via freeze-the-view.
//
// Every gate must pass; anything ambiguous keeps the terminal ALIVE.

export const DEFAULT_HOT_WORKSPACE_LIMIT = 5
// How long an agent must sit without real user interaction before it's
// suspended. Measured from the last keystroke (not output), so revealing a
// workspace can't reset it. Tunable.
export const DEFAULT_SUSPEND_IDLE_AFTER_MS = 2 * 60 * 60 * 1000

export type ReapCandidate = {
  sessionId: string
  workspaceId: string | null
  // 'agent' terminals are the only suspend targets. Plain shells are cheap and
  // may hold a foreground command, so they are never suspended here.
  kind: string
  // Informational only (carried into the reap audit log). The policy no longer
  // gates on the cli: any idle agent is reapable regardless of which CLI it runs.
  // Reaping kills the PTY; reopen relaunches via the plugin's resume command
  // where one is declared (exact for claude-code; codex reattaches its own
  // latest session). A cli with no resume support would relaunch fresh.
  cli: string | null
  visible: boolean
  processAlive: boolean
  // Max of started/lastInput — "when the user last interacted with this
  // terminal". Repaint-immune (real keystrokes only); drives the idle clock.
  lastInteractionAt: number
  // Caller-supplied: the terminal belongs to an active managed run (e.g. a
  // SprintEngine agent). Defaults to the SAFE value (true) when unsure.
  inActiveRun: boolean
}

export type ReapPolicyOptions = {
  now?: number
  hotWorkspaceLimit?: number
  idleThresholdMs?: number
}

export type ReapDecision = {
  // The most-recently-interacted workspaces kept fully resident (never
  // suspended), ranked by their freshest session.
  hotWorkspaceIds: string[]
  // Sessions safe to suspend now.
  reapableSessionIds: string[]
}

// The N most-recently-interacted workspaces, ranked by their freshest ALIVE
// session's last interaction. Only live sessions contribute. Ties break by
// workspace id for determinism.
export function computeHotWorkspaceIds(
  candidates: readonly ReapCandidate[],
  limit: number
): string[] {
  if (limit <= 0) return []
  const freshestByWorkspace = new Map<string, number>()
  for (const candidate of candidates) {
    if (!candidate.processAlive) continue
    if (candidate.workspaceId === null) continue
    const current = freshestByWorkspace.get(candidate.workspaceId)
    if (current === undefined || candidate.lastInteractionAt > current) {
      freshestByWorkspace.set(candidate.workspaceId, candidate.lastInteractionAt)
    }
  }
  return [...freshestByWorkspace.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([workspaceId]) => workspaceId)
}

// True only when EVERY gate passes. Order is cheap-checks-first, but the result
// is the conjunction either way.
export function isSessionReapable(
  candidate: ReapCandidate,
  hotWorkspaceIds: ReadonlySet<string>,
  options: { now: number; idleThresholdMs: number }
): boolean {
  if (!candidate.processAlive) return false
  if (candidate.kind !== 'agent') return false
  if (candidate.visible) return false
  if (candidate.inActiveRun) return false
  if (candidate.workspaceId === null) return false
  if (hotWorkspaceIds.has(candidate.workspaceId)) return false
  if (options.now - candidate.lastInteractionAt <= options.idleThresholdMs) return false
  return true
}

export function selectReapableSessions(
  candidates: readonly ReapCandidate[],
  options: ReapPolicyOptions = {}
): ReapDecision {
  const now = options.now ?? Date.now()
  const hotWorkspaceLimit = options.hotWorkspaceLimit ?? DEFAULT_HOT_WORKSPACE_LIMIT
  const idleThresholdMs = options.idleThresholdMs ?? DEFAULT_SUSPEND_IDLE_AFTER_MS

  const hotWorkspaceIds = computeHotWorkspaceIds(candidates, hotWorkspaceLimit)
  const hotSet = new Set(hotWorkspaceIds)

  const reapableSessionIds = candidates
    .filter((candidate) => isSessionReapable(candidate, hotSet, { now, idleThresholdMs }))
    .map((candidate) => candidate.sessionId)

  return { hotWorkspaceIds, reapableSessionIds }
}
