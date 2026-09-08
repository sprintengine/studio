// Projecting main-launched agents into the renderer (MC-2159).
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
// It never overwrites an agent the renderer already holds, and never retires one
// it did not create: a record the store owns may carry user edits (a renamed
// agent, a changed runtime override) the launch-time snapshot knows nothing
// about, and a user-created agent whose terminal exited keeps its tab.
import type { TerminalSessionSnapshot } from '../../../shared/electron-api'
import type { AgentLaunchRecord } from '../../../shared/agent-launch'
import type { AgentState, WorkspaceId } from '../types/workspace'

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
}

/**
 * The `AgentState` a launched session projects to.
 *
 * `cliHasLaunched`/`cliOnboardingPromptSent` are true because they are true:
 * main already launched the CLI and already delivered the startup prompt. Saying
 * otherwise would make the mounting terminal re-send a prompt the agent has
 * had — and, with `cliStartupPrompt` still set, treat this as live launch intent
 * and spawn a second process alongside the one it is looking at.
 */
export function agentStateFromLaunchRecord(
  record: AgentLaunchRecord,
  session: TerminalSessionSnapshot,
): AgentState {
  return {
    id: record.agentId,
    name: record.name,
    status: 'idle',
    execution: record.worktreePath
      ? { mode: 'worktree', worktreeId: session.worktreeId ?? null, cwd: record.worktreePath }
      : { mode: 'current_workspace', worktreeId: null, cwd: null },
    messages: [],
    streamBuffer: '',
    runtimeKind: 'terminal',
    cliSessionId: session.sessionId,
    // The harness's own id, when its lifecycle hook has reported one yet. Absent
    // right after launch and learned later; the launch-flag reconcile fills it in.
    ...(session.cliSessionId ? { harnessSessionId: session.cliSessionId } : {}),
    cliStartRequested: false,
    cliRestartNonce: 0,
    cliHasLaunched: true,
    cliOnboardingPromptSent: true,
    cliResumeAvailable: false,
    cli: record.cli,
    ...(record.cliModel ? { cliModel: record.cliModel } : {}),
    cliPermissionPreset: record.cliPermissionPreset,
    kind: record.kind,
    ...(record.specialistId ? { specialistId: record.specialistId } : {}),
    ...(record.connectorMcpSettings ? { connectorMcpSettings: record.connectorMcpSettings } : {}),
    ...(record.spawnSkillId ? { spawnSkillId: record.spawnSkillId } : {}),
  }
}
