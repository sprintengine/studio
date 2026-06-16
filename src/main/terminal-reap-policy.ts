// Phase 1 of the memory-bounded agent lifecycle: decide which idle agent
// terminals are safe to SUSPEND (kill the process, preserve resume) so a
// long-running session doesn't accumulate dozens of idle agents holding GBs.
//
// This module is intentionally PURE and side-effect free: it takes a snapshot of
// candidate sessions plus the few caller-supplied safety signals it cannot
// derive itself, and returns the session ids that are safe to reap. The actual
// kill goes through the existing `disposeTerminal` path (which already preserves
// agent launch flags so reopening relaunches the CLI with --resume).
//
// The bar for reaping is deliberately high — suspending something we cannot
// bring back, or that is doing work, is a correctness bug, not an optimization.
// Every gate must pass; anything ambiguous keeps the terminal ALIVE.

export const DEFAULT_HOT_WORKSPACE_LIMIT = 5
// How long a cold (outside-the-hot-set) agent must sit fully idle before it's
// suspended. The old 24h `STALE_TERMINAL_MAX_UNSEEN_MS` never fired in a real
// session; this is the in-session reclaim. Conservative on purpose — only the
// cold overflow is ever on this clock (hot workspaces + working/server/active
// agents are exempt), and Phase 2's pressure-aware evictor reclaims sooner when
// RAM is actually tight. Tunable.
export const DEFAULT_SUSPEND_IDLE_AFTER_MS = 2 * 60 * 60 * 1000

// CLIs whose session resume is deterministic enough to suspend-and-restore.
// Claude pre-seeds its own session id at launch (`--session-id`), so
// `--resume <id>` is exact. Codex generates its own id we can't yet capture
// (see Phase 3), so it is intentionally absent — never suspend a Codex agent.
export const RESUMABLE_CLIS: readonly string[] = ['claude']

export type ReapCandidate = {
  sessionId: string
  workspaceId: string | null
  // 'agent' terminals are the only suspend targets. Plain shells are cheap and
  // may hold a foreground command, so they are never suspended here.
  kind: string
  cli: string | null
  // Session activity: only 'idle' is reapable. 'working' / 'needs-input' /
  // 'failed' all keep the terminal alive.
  activityKind: string
  visible: boolean
  processAlive: boolean
  // Max of started/lastInput/lastOutput/lastVisible — "when anyone last touched
  // or heard from this terminal".
  lastSeenAt: number
  // Caller-supplied safety signals the policy cannot derive on its own. Both
  // default to the SAFE value (treat as present) when the caller is unsure.
  inActiveRun: boolean // workspace has an active SprintEngine/automation run
  hasLiveChildProcess: boolean // a server / foreground command / live child under the pty
}

export type ReapPolicyOptions = {
  now?: number
  hotWorkspaceLimit?: number
  idleThresholdMs?: number
  resumableClis?: readonly string[]
}

export type ReapDecision = {
  // The most-recently-active workspaces kept fully resident (agents never
  // suspended), ranked by their freshest session.
  hotWorkspaceIds: string[]
  // Sessions safe to suspend now.
  reapableSessionIds: string[]
}

// The N most-recently-seen workspaces, ranked by their freshest ALIVE session.
// Only live sessions contribute, so a workspace whose agents already exited
// doesn't hold a hot slot. Ties break by workspace id for determinism.
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
    if (current === undefined || candidate.lastSeenAt > current) {
      freshestByWorkspace.set(candidate.workspaceId, candidate.lastSeenAt)
    }
  }
  return [...freshestByWorkspace.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([workspaceId]) => workspaceId)
}

function isResumable(cli: string | null, resumableClis: readonly string[]): boolean {
  return cli !== null && resumableClis.includes(cli)
}

// True only when EVERY gate passes. Order is cheap-checks-first, but the result
// is the conjunction either way.
export function isSessionReapable(
  candidate: ReapCandidate,
  hotWorkspaceIds: ReadonlySet<string>,
  options: { now: number; idleThresholdMs: number; resumableClis: readonly string[] }
): boolean {
  if (!candidate.processAlive) return false
  if (candidate.kind !== 'agent') return false
  if (!isResumable(candidate.cli, options.resumableClis)) return false
  if (candidate.activityKind !== 'idle') return false
  if (candidate.visible) return false
  if (candidate.inActiveRun) return false
  if (candidate.hasLiveChildProcess) return false
  if (candidate.workspaceId === null) return false
  if (hotWorkspaceIds.has(candidate.workspaceId)) return false
  if (options.now - candidate.lastSeenAt <= options.idleThresholdMs) return false
  return true
}

export function selectReapableSessions(
  candidates: readonly ReapCandidate[],
  options: ReapPolicyOptions = {}
): ReapDecision {
  const now = options.now ?? Date.now()
  const hotWorkspaceLimit = options.hotWorkspaceLimit ?? DEFAULT_HOT_WORKSPACE_LIMIT
  const idleThresholdMs = options.idleThresholdMs ?? DEFAULT_SUSPEND_IDLE_AFTER_MS
  const resumableClis = options.resumableClis ?? RESUMABLE_CLIS

  const hotWorkspaceIds = computeHotWorkspaceIds(candidates, hotWorkspaceLimit)
  const hotSet = new Set(hotWorkspaceIds)

  const reapableSessionIds = candidates
    .filter((candidate) => isSessionReapable(candidate, hotSet, { now, idleThresholdMs, resumableClis }))
    .map((candidate) => candidate.sessionId)

  return { hotWorkspaceIds, reapableSessionIds }
}
