// Phase 1 orchestration: turn the live terminal sessions into a reap decision.
// Combines the pure policy (terminal-reap-policy) with the two safety signals it
// can't derive itself:
//   * `hasLiveChildProcess` — a live process under the pty (terminal-subtree-
//     probe); async, fails SAFE (undetermined → keep alive).
//   * `inActiveRun` — derived here as "this workspace has a *working* agent".
//     Activity-based (not session-existence), so it is NOT circular: an idle
//     agent does not keep its own workspace "active". A workspace with any agent
//     still working keeps all its (idle) siblings alive until the whole
//     workspace goes quiet.
//
// Kept separate from terminal-runtime.ts (the wiring) so the full decision path
// is unit-testable with the OS reads injected.

import {
  selectReapableSessions,
  type ReapCandidate,
  type ReapDecision,
  type ReapPolicyOptions,
} from './terminal-reap-policy'

// A candidate before the two derived signals are resolved. `rootPid` is the pty
// shell pid (for subtree probing).
export type SweepCandidate = Omit<ReapCandidate, 'inActiveRun' | 'hasLiveChildProcess'> & {
  rootPid: number
}

export type ReapSweepDeps = {
  // Maps each probed root pid to whether its subtree has a live process. A root
  // absent from the map is "undetermined" → treated as live (keep-alive).
  probeSubtrees: (rootPids: number[]) => Promise<Map<number, boolean>>
}

// Workspaces with at least one alive, actively-working agent. Their idle
// siblings are kept alive (the run is active) until the whole workspace quiets.
function busyWorkspaceIds(candidates: readonly SweepCandidate[]): Set<string> {
  const busy = new Set<string>()
  for (const candidate of candidates) {
    if (!candidate.processAlive) continue
    if (candidate.activityKind !== 'working') continue
    if (candidate.workspaceId === null) continue
    busy.add(candidate.workspaceId)
  }
  return busy
}

export async function planReapSweep(
  candidates: readonly SweepCandidate[],
  deps: ReapSweepDeps,
  options: ReapPolicyOptions = {}
): Promise<ReapDecision> {
  // Only probe the roots of plausible candidates (alive agents) to bound cost —
  // no point shelling out for sessions the policy will reject outright.
  const probeRoots = [
    ...new Set(
      candidates
        .filter((candidate) => candidate.processAlive && candidate.kind === 'agent')
        .map((candidate) => candidate.rootPid)
        .filter((pid) => Number.isInteger(pid) && pid > 0)
    ),
  ]
  const liveByRoot = probeRoots.length > 0 ? await deps.probeSubtrees(probeRoots) : new Map<number, boolean>()
  const busy = busyWorkspaceIds(candidates)

  const resolved: ReapCandidate[] = candidates.map((candidate) => ({
    sessionId: candidate.sessionId,
    workspaceId: candidate.workspaceId,
    kind: candidate.kind,
    cli: candidate.cli,
    activityKind: candidate.activityKind,
    visible: candidate.visible,
    processAlive: candidate.processAlive,
    lastSeenAt: candidate.lastSeenAt,
    // Undetermined probe → keep-alive.
    hasLiveChildProcess: liveByRoot.has(candidate.rootPid)
      ? (liveByRoot.get(candidate.rootPid) as boolean)
      : true,
    inActiveRun: candidate.workspaceId !== null && busy.has(candidate.workspaceId),
  }))

  return selectReapableSessions(resolved, options)
}
