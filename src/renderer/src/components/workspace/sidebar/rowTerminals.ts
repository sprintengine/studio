// Which terminals and fleet panes a sidebar row stands for, and which of
// their completions the user has not seen yet.

import { type Workspace } from '../../../types/workspace'
import { fleetPanesOf, fleetMachineNamesOf } from './folderGroups'

/**
 * The panes this workspace's layout mounts FROM other machines: one entry per
 * fleet-terminal tab, with the machine it names and the CLI mark if the tab
 * carries one. The layout JSON is the one durable record of a remote
 * attachment, so a walk of it — not a live socket — is what says a workspace
 * is remote-flavoured even while the peer sleeps. Each pane is an open
 * terminal for the row's head stack, exactly as a local live session is.
 */
/**
 * The open terminals a row shows as heads, and the one liveness test the row
 * has (the-diff-an-agent-made, decision 9): the local sessions whose process is
 * alive, plus the fleet panes the layout mounts from other machines. A
 * suspended or exited local session is not open — `isLiveTerminal` is the
 * filter the caller applies before building the map — so a chat whose agent
 * has been parked has no heads, no line 2, and no git facts.
 */
export function rowOpenTerminals(
  workspace: Workspace,
  liveSessionsByWorkspaceId: ReadonlyMap<string, ReadonlyArray<{ sessionId: string; cli?: string }>>,
): Array<{ sessionId: string; cli?: string; remote?: boolean }> {
  return [
    ...(liveSessionsByWorkspaceId.get(workspace.id) ?? []).map((session) => ({
      sessionId: session.sessionId,
      ...(session.cli ? { cli: session.cli } : {}),
    })),
    ...fleetPanesOf(workspace).map((pane) => ({
      sessionId: pane.tabId,
      ...(pane.cli ? { cli: pane.cli } : {}),
      remote: true,
    })),
  ]
}

/** Whether a row has any open terminal at all — the gate on its second line and its git poll. */
export function rowHasOpenTerminals(
  workspace: Workspace,
  liveSessionsByWorkspaceId: ReadonlyMap<string, ReadonlyArray<unknown>>,
): boolean {
  return (liveSessionsByWorkspaceId.get(workspace.id)?.length ?? 0) > 0 || fleetPanesOf(workspace).length > 0
}

/**
 * The machines a row says it lives on. `remoteOrigin` is the primary source —
 * set once at creation and kept when the pane closes — and the layout walk is
 * the fallback for rows that predate it, plus any machine a local workspace
 * has since mounted a pane from. Local is the unmarked default (decision 7).
 */
export function provenanceMachinesOf(workspace: Workspace): string[] {
  const names = new Set<string>()
  if (workspace.remoteOrigin) names.add(workspace.remoteOrigin.machineName)
  for (const name of fleetMachineNamesOf(workspace)) names.add(name)
  return [...names]
}

/**
 * The unseen-completion mark — a "Done" pill on the row, drawn by
 * `doneRowClass`: which workspaces finished a turn while the person was
 * looking elsewhere, and have not been opened since.
 *
 * Sourced ONLY from hook-authoritative activity ([[agent-state-hooks-only]]):
 * `workingSince` is `deriveWorkspaceWorkingSince` — the clock the row's
 * working counter already trusts, non-null only while hooks say a turn is in
 * flight. A turn is DONE when that clock stops on a workspace that still has a
 * hook-settled session (`settledWorkspaceIds`): a process that was killed
 * mid-turn also stops the clock, and it did not finish anything. Opening the
 * workspace clears its mark, and so does going back to work — a parked model
 * that its background agent re-invoked is not finished, and earns the mark
 * again when that turn ends. The active workspace never earns one — the
 * person is watching. Pure, so the sidebar's effect stays a one-liner.
 */
export function deriveUnseenCompletions(input: {
  previous: ReadonlySet<string>
  workingSinceBefore: Readonly<Record<string, number | null | undefined>>
  workingSinceNow: Readonly<Record<string, number | null | undefined>>
  settledWorkspaceIds: ReadonlySet<string>
  activeWorkspaceId: string | null
}): Set<string> {
  const next = new Set<string>()
  for (const id of input.previous) {
    if (id === input.activeWorkspaceId) continue
    if (!(id in input.workingSinceNow)) continue
    if (typeof input.workingSinceNow[id] === 'number') continue
    next.add(id)
  }
  for (const id of Object.keys(input.workingSinceNow)) {
    const before = input.workingSinceBefore[id]
    const now = input.workingSinceNow[id]
    const stopped = typeof before === 'number' && typeof now !== 'number'
    if (!stopped) continue
    if (id === input.activeWorkspaceId) continue
    if (!input.settledWorkspaceIds.has(id)) continue
    next.add(id)
  }
  return next
}

/** A live session whose hooks report a settled phase: the turn ended, the agent is still there. */
export function isHookSettledSession(session: {
  processAlive: boolean
  agentState?: { phase: string; source: string }
}): boolean {
  if (!session.processAlive) return false
  const state = session.agentState
  if (!state || state.source !== 'hook') return false
  return state.phase === 'idle' || state.phase === 'awaiting_input'
}
