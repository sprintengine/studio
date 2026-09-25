// Projecting main-launched agents into the renderer.
//
// When the main-process AgentLaunchService composes and spawns an agent, the
// renderer has no record of it: nothing in this process decided its name, CLI,
// permission preset, or prompt. The session snapshot carries the decisions main
// made (`TerminalSessionSnapshot.agentRecord`), and this module turns them back
// into the `AgentState` a FlexLayout tab is built from.
//
// The direction of travel is the whole point. The renderer's agent record used
// to be the SOURCE of an agent — created first, spawned second, by whichever
// terminal happened to mount. It is now a PROJECTION of a session that already
// exists, which is why:
//
//   - a launch with no window open still shows up, complete, in a window opened
//     an hour later (the session is still live, so the projection still has a
//     source);
//   - a projected tab attaches instead of launching. The record it produces
//     carries `cliSessionId` (main's session id) and `cliHasLaunched: true`, so
//     `TerminalView` reattaches to the running pty and replays its scrollback
//     rather than spawning a second one;
//   - disposal has no renderer request behind it. Main kills the session at run
//     finalize; the tab and record it minted retire on the next tick because
//     their source is gone (`retiredLaunchedAgents`).
//
// Main registers the agent in the workspace registry itself at launch, so the
// record usually arrives here on the workspace-sync bus before the session tick
// does. The projection then has nothing to create, but the tab still has to
// appear and still has to retire with its session: `unrevealedLaunchedAgents`
// is that half, for a record that arrived on the bus while this window was
// running and has no tab here yet.
//
// It never overwrites an agent the renderer already holds, and never retires one
// it did not create: a record the store owns may carry user edits (a renamed
// agent, a changed runtime override) the launch-time snapshot knows nothing
// about, and a user-created agent whose terminal exited keeps its tab.
import type { TerminalSessionSnapshot } from '../../../shared/electron-api'
import { agentStateFromLaunchRecord } from '../../../shared/launched-agent-state'
import type { AgentState, Workspace, WorkspaceId } from '../types/workspace'

export { agentStateFromLaunchRecord }

export type LaunchedAgentProjection = {
  workspaceId: WorkspaceId
  agentId: string
  agent: AgentState
}

/**
 * The agents that should exist in the renderer because main launched them, from
 * a session-snapshot tick.
 *
 * `knownWorkspaceIds` gates on workspaces this store actually holds: a session
 * belonging to a workspace this window has never seen has nowhere to be
 * projected, and inventing one would be worse than showing nothing. `existing`
 * is the set of `workspaceId::agentId` keys already in the store — an agent that
 * is already there is left exactly as it is.
 */
export function projectedLaunchedAgents(input: {
  sessions: ReadonlyArray<TerminalSessionSnapshot>
  knownWorkspaceIds: ReadonlySet<WorkspaceId>
  existing: ReadonlySet<string>
}): LaunchedAgentProjection[] {
  const projections: LaunchedAgentProjection[] = []
  const seen = new Set<string>()
  for (const session of input.sessions) {
    if (session.kind !== 'agent') continue
    // Only live sessions. A retained failed/exited session still appears in the
    // list, and projecting it would mint a tab for an agent that is already over.
    if (!session.processAlive) continue
    const record = session.agentRecord
    if (!record) continue
    const workspaceId = session.workspaceId
    if (!workspaceId || !input.knownWorkspaceIds.has(workspaceId)) continue
    const key = projectionKey(workspaceId, record.agentId)
    if (input.existing.has(key) || seen.has(key)) continue
    seen.add(key)
    projections.push({
      workspaceId,
      agentId: record.agentId,
      agent: agentStateFromLaunchRecord(record, session),
    })
  }
  return projections
}

export function projectionKey(workspaceId: string, agentId: string): string {
  return `${workspaceId}::${agentId}`
}

/**
 * Agents THIS renderer session projected. Renderer-session scoped on purpose,
 * exactly like the minted-session registry in `terminalColdLoad.ts`: a reload is
 * a cold load, and an empty set is the correct answer rather than lost state —
 * a record that survived the reload is then an ordinary persisted agent, and the
 * persist normalizers already strip its launch flags so it cold-loads inert.
 *
 * Its only job is retirement. The projection is additive, so without a record of
 * what it created, a disposed agent's tab and record would linger: main kills
 * the session, and nothing on this side would know the tab it minted no longer
 * has anything behind it. Removing only what the projection itself created is
 * what makes that safe — a user-created agent is never a candidate.
 */
const projectedAgents = new Set<string>()

export function markLaunchedAgentProjected(workspaceId: string, agentId: string): void {
  projectedAgents.add(projectionKey(workspaceId, agentId))
}

/**
 * Agents that arrived on the workspace-sync bus during THIS renderer session —
 * created by an event, not by a snapshot. Renderer-session scoped for the same
 * reason `projectedAgents` is: what a window loads with is the state it was
 * left in, including a tab the person hid on purpose, and only an agent that
 * turns up while the window watches is news to reveal.
 */
const arrivedAgents = new Set<string>()

export function noteLaunchedAgentArrived(workspaceId: string, agentId: string): void {
  arrivedAgents.add(projectionKey(workspaceId, agentId))
}

/**
 * Live main-launched agents that arrived on the bus while this window ran and
 * have no tab in their workspace yet — the agents main registered before this
 * window saw their session. Revealing one is the same act as revealing a
 * projection, and marking it projected is what lets it retire with its session.
 *
 * An agent the window loaded with is never a candidate, tab or no tab: its
 * layout is what the person left it as, and a hidden tab stays hidden. A
 * reload therefore reveals nothing and moves nobody into a workspace.
 */
export function unrevealedLaunchedAgents(input: {
  sessions: ReadonlyArray<TerminalSessionSnapshot>
  workspaces: ReadonlyArray<Pick<Workspace, 'id' | 'agents' | 'layoutModel'>>
}): Array<{ workspaceId: WorkspaceId; agentId: string; name: string }> {
  if (arrivedAgents.size === 0) return []
  const revealed: Array<{ workspaceId: WorkspaceId; agentId: string; name: string }> = []
  for (const session of input.sessions) {
    if (session.kind !== 'agent' || !session.processAlive) continue
    const record = session.agentRecord
    if (!record || !session.workspaceId) continue
    const key = projectionKey(session.workspaceId, record.agentId)
    if (!arrivedAgents.has(key) || projectedAgents.has(key)) continue
    const workspace = input.workspaces.find((candidate) => candidate.id === session.workspaceId)
    const agent = workspace?.agents[record.agentId]
    if (!workspace || !agent) continue
    // Considered once: whether or not it needs a tab, it is no longer news.
    arrivedAgents.delete(key)
    if (layoutHasAgentTab(workspace.layoutModel, record.agentId)) continue
    revealed.push({ workspaceId: workspace.id, agentId: record.agentId, name: agent.name || record.name })
  }
  return revealed
}

/** Whether a serialized FlexLayout model holds an agent tab for `agentId`, borders included. */
export function layoutHasAgentTab(layoutModel: unknown, agentId: string): boolean {
  const pending: unknown[] = [layoutModel]
  while (pending.length > 0) {
    const node = pending.pop()
    if (!node || typeof node !== 'object') continue
    if (Array.isArray(node)) {
      pending.push(...node)
      continue
    }
    const record = node as { type?: unknown; component?: unknown; config?: { agentId?: unknown } | null }
    if (record.type === 'tab' && record.component === 'agent' && record.config?.agentId === agentId) return true
    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') pending.push(value)
    }
  }
  return false
}

/**
 * Projected agents whose session is gone: the renderer half of `agent.dispose`.
 * Run-finalize kills the terminal in main, and this is what drops the tab and
 * the record that were standing in for it. Forgets each key as it reports it, so
 * a retirement is reported exactly once.
 */
export function retiredLaunchedAgents(
  sessions: ReadonlyArray<TerminalSessionSnapshot>,
): Array<{ workspaceId: string; agentId: string }> {
  if (projectedAgents.size === 0) return []
  const held = new Set<string>()
  for (const session of sessions) {
    if (session.kind !== 'agent') continue
    // A suspended session is not `processAlive`, but the reaper froze it to
    // reclaim memory and its painted scrollback is still readable and
    // resumable — retiring it would delete an agent the operator can still
    // open. Only a session that has genuinely exited, or left the list
    // entirely, retires.
    if (!session.processAlive && !session.suspended) continue
    if (!session.workspaceId || !session.agentId) continue
    held.add(projectionKey(session.workspaceId, session.agentId))
  }

  const retired: Array<{ workspaceId: string; agentId: string }> = []
  for (const key of projectedAgents) {
    if (held.has(key)) continue
    projectedAgents.delete(key)
    const separator = key.indexOf('::')
    retired.push({ workspaceId: key.slice(0, separator), agentId: key.slice(separator + 2) })
  }
  return retired
}

export function resetLaunchedAgentProjectionForTest(): void {
  projectedAgents.clear()
  arrivedAgents.clear()
}
