/**
 * Main registers every agent its launch service starts in the workspace
 * registry, at launch, whoever asked for it.
 *
 * The launch service spawns the session and nothing else. The agent record
 * used to be added by a window: the renderer projected each live session it
 * held no record for and asked main to store it. So the registry only learned
 * about a launch if a window on this machine was running, watching the session
 * list, and got its write through. An agent started from another machine over
 * the tailnet, from the MCP `agent.launch` tool or by an automation could run
 * here for hours while `workspace.list` — and every window that reads the
 * registry — said the workspace held only the agents it had before. The host
 * is the source of truth for what runs on it, so the write belongs here.
 *
 * Three entry points share one rule:
 *
 * - `registerSession` runs the moment a launch returns, so the broadcast goes
 *   out before the session list's own coalesced push does.
 * - `reconcile` runs on every session-list change. It adopts a live launched
 *   session whose agent is missing from its workspace — one whose launch-time
 *   write did not land — so no live launched agent stays unlisted.
 * - `release` runs on the launch service's dispose, so an automation's one-shot
 *   agent leaves the registry with its session even when no window is open to
 *   retire it.
 *
 * Only live sessions the launch service started are candidates: they carry the
 * `agentRecord` it composed. A terminal a window spawned for its own agent is
 * already in the registry, and a helper session (a review guide, a module's
 * private process) is not an agent the workspace should list.
 *
 * An agent whose session exits on its own stays listed, as any agent whose
 * terminal exited does: its painted screen is kept for it to be reopened. A
 * window that revealed it still retires it with the session, as it always has.
 *
 * Each agent is adopted at most once per session. Once the registry has held an
 * agent while its session lived, a later absence is somebody's decision — it
 * was moved to another workspace, or removed from another window or device —
 * and adding it back would undo that.
 */
import type { TerminalSessionSnapshot } from '../shared/electron-api'
import { agentStateFromLaunchRecord } from '../shared/launched-agent-state'
import type { AgentLaunchService } from './agent-launch-service'
import type { WorkspaceRegistryService } from './workspace-registry-service'
import type { WorkspaceSyncService } from './workspace-sync-service'

/**
 * The fields registration reads from a session. Deliberately narrow: the
 * reconcile runs on every session-list beat, and building full snapshots of
 * every session there would be the expensive `listTerminals()` call the runtime
 * warns about.
 */
export type LaunchedSessionView = Pick<
  TerminalSessionSnapshot,
  'sessionId' | 'kind' | 'processAlive' | 'workspaceId' | 'agentRecord' | 'worktreeId' | 'cliSessionId'
>

export type LaunchedAgentRegistrationDeps = {
  /** Read side: whether the workspace exists and which agents it holds. */
  registry: Pick<WorkspaceRegistryService, 'getRecord'>
  /** Write side: the sequenced bus, whose broadcast reaches every window and paired device. */
  workspaceSync: Pick<WorkspaceSyncService, 'updateWorkspaceAgent'>
  /** The runtime's sessions that carry a launch record; the rest are never candidates. */
  listLaunchedSessions: () => Iterable<LaunchedSessionView>
  /** Whether a session is still in the runtime at all (exited counts; disposed does not). */
  hasSession: (sessionId: string) => boolean
}

export type LaunchedAgentRegistration = {
  registerSession: (sessionId: string) => boolean
  reconcile: () => number
  release: (workspaceId: string, agentId: string) => void
}

/**
 * The launch service with registration on both ends: a launch that started a
 * session registers its agent before it returns, and a dispose takes back out
 * what registration put in.
 */
export function withLaunchedAgentRegistration(
  service: AgentLaunchService,
  registration: LaunchedAgentRegistration,
): AgentLaunchService {
  return {
    async launch(request) {
      const result = await service.launch(request)
      if (result.ok) registration.registerSession(result.sessionId)
      return result
    },
    dispose(request) {
      const result = service.dispose(request)
      registration.release(request.workspaceId, request.agentId)
      return result
    },
  }
}

export function createLaunchedAgentRegistration(deps: LaunchedAgentRegistrationDeps): LaunchedAgentRegistration {
  // Agents the registry has held while their session was live, keyed to that
  // session so the entry is dropped once the session leaves the runtime.
  const settled = new Map<string, string>()
  // The subset main wrote itself, which is what `release` may take back out.
  const registered = new Map<string, string>()

  function consider(session: LaunchedSessionView): boolean {
    // Running, not suspended or exited: the same rule a window uses to reveal
    // one, so main never lists an agent no window would open.
    if (session.kind !== 'agent' || !session.processAlive) return false
    const record = session.agentRecord
    const workspaceId = session.workspaceId
    if (!record || !workspaceId) return false
    const key = keyOf(workspaceId, record.agentId)
    if (settled.has(key)) return false
    // A workspace the registry does not hold (removed while the agent ran) has
    // nowhere to list it, and writing into it would resurrect nothing useful.
    const workspace = deps.registry.getRecord(workspaceId)
    if (!workspace) return false
    if (workspace.agents[record.agentId]) {
      settled.set(key, session.sessionId)
      return false
    }
    // Stamped 0: nobody chose these values, so any window's edit to the agent —
    // even one stamped before this write reached main — wins over them.
    const written = deps.workspaceSync.updateWorkspaceAgent(
      workspaceId,
      record.agentId,
      agentStateFromLaunchRecord(record, session),
      'system',
      0,
    )
    if (!written.ok) return false
    settled.set(key, session.sessionId)
    registered.set(key, session.sessionId)
    return true
  }

  function registerSession(sessionId: string): boolean {
    for (const session of deps.listLaunchedSessions()) {
      if (session.sessionId === sessionId) return consider(session)
    }
    return false
  }

  function reconcile(): number {
    let adopted = 0
    for (const session of deps.listLaunchedSessions()) {
      if (consider(session)) adopted += 1
    }
    // A session that has left the runtime can never be considered again, so
    // forgetting its entries only keeps both maps as small as the session list.
    // An exited session is still there, and `release` still finds what it
    // registered when a run finalizes after its agent ended on its own.
    for (const map of [settled, registered]) {
      for (const [key, sessionId] of map) {
        if (!deps.hasSession(sessionId)) map.delete(key)
      }
    }
    return adopted
  }

  function release(workspaceId: string, agentId: string): void {
    const key = keyOf(workspaceId, agentId)
    if (!registered.delete(key)) return
    // Still settled: the kill may not have landed, and a reconcile that saw the
    // session alive in the meantime must not add back what was just taken out.
    if (deps.registry.getRecord(workspaceId)?.agents[agentId]) {
      deps.workspaceSync.updateWorkspaceAgent(workspaceId, agentId, null, 'system')
    }
  }

  return { registerSession, reconcile, release }
}

function keyOf(workspaceId: string, agentId: string): string {
  return `${workspaceId}::${agentId}`
}
