// Pure helpers extracted from WorkspaceManager.tsx. Workspace activity,
// session shaping, sidebar ordering, and multiloop-spawn prompt construction
// live here so the orchestrator stays focused on layout, IPC, and state
// coordination. Nothing in this module reaches into the store directly;
// every function takes its data via arguments.

import {
  buildMultiloopLaunchContextLines,
  getActiveMultiloopMilestone,
  getMultiloopTasksForMilestone,
} from '../../utils/multiloop'
import { isStarred } from '../../utils/highlight'
import { sortWorkspacesByActivity } from '../../utils/workspaceRecency'
import {
  deriveWorkspaceDisplayActivity,
  isLiveTerminal,
} from '../../hooks/useTerminalSessions'
import type { Workspace } from '../../types/workspace'
import type { MultiloopRoleDescriptor } from '../../specialists/specialistActions'
import type { SessionItem } from './WorkspaceTopBar'

export type WorkspaceActivity = 'needs-input' | 'working' | 'failed' | 'idle'
export type SessionStatus = 'needs-input' | 'working'

export function workspaceNeedsInput(workspace: Workspace): boolean {
  return Object.values(workspace.sprintEngineState?.sprintEngineAgents ?? {}).some(
    (agent) => agent.status === 'needs_input',
  )
}

export function getWorkspaceActivity(
  workspace: Workspace,
  terminalSessions: TerminalSessionSnapshot[],
): WorkspaceActivity {
  return deriveWorkspaceDisplayActivity(
    workspace.id,
    terminalSessions,
    workspaceNeedsInput(workspace),
  )
}

export function hasActiveProPlan(authState: MulticodeAuthState): boolean {
  return (
    authState.entitlements?.plan.status === 'active' &&
    authState.entitlements.plan.code.toLowerCase() === 'pro'
  )
}

export function uniqueAgentName(baseName: string, agents: Workspace['agents']): string {
  const existingNames = new Set(Object.values(agents).map((agent) => agent.name))
  if (!existingNames.has(baseName)) return baseName

  let suffix = 2
  while (existingNames.has(`${baseName} ${suffix}`)) suffix += 1
  return `${baseName} ${suffix}`
}

export function terminalSessionLabel(terminalId: string): string {
  if (terminalId.startsWith('git-')) return 'Git terminal'
  if (terminalId.startsWith('worktree-')) return 'Worktree terminal'
  return 'Terminal'
}

export function getSessionItems(
  workspaces: Workspace[],
  terminalSessions: TerminalSessionSnapshot[],
): SessionItem[] {
  return terminalSessions
    .filter((session) => isLiveTerminal(session) && typeof session.workspaceId === 'string')
    .flatMap((session): SessionItem[] => {
      const workspace = workspaces.find((candidate) => candidate.id === session.workspaceId)
      if (!workspace) return []

      if (session.kind === 'agent') {
        if (!session.agentId) return []
        const agent = workspace.agents[session.agentId]
        const runtime = workspace.sprintEngineState?.sprintEngineAgents[session.agentId]
        const status: SessionStatus = runtime?.status === 'needs_input' ? 'needs-input' : 'working'
        const specialistId =
          agent?.kind === 'specialist' || agent?.kind === 'watchtower'
            ? agent.specialistId ?? null
            : null
        const multiloopRole = agent?.kind === 'multiloop' ? agent.multiloopRole ?? null : null

        return [
          {
            workspace,
            kind: session.kind,
            agentId: session.agentId,
            terminalId: null,
            label: agent?.name || session.agentId,
            cli: session.cli ?? agent?.cli ?? '',
            status,
            role: runtime?.role ?? null,
            specialistId,
            multiloopRole,
            taskId: runtime?.currentTaskId ?? null,
            sessionId: session.sessionId,
          },
        ]
      }

      const terminalId = session.terminalId ?? session.sessionId.replace(/^terminal-/, '')
      return [
        {
          workspace,
          kind: session.kind,
          agentId: null,
          terminalId,
          label: terminalSessionLabel(terminalId),
          cli: session.cli ?? '',
          status: 'working' as const,
          role: null,
          specialistId: null,
          multiloopRole: null,
          taskId: null,
          sessionId: session.sessionId,
        },
      ]
    })
}

/**
 * Reproduces the workspace order users see in the left sidebar so the
 * session manager dropdown matches: starred workspaces first, then folder
 * groups in first-occurrence order, with each workspace appearing exactly
 * once. When `isWorkspaceLive` is supplied, both the starred section and each
 * folder's rows are ordered by most-recent activity (live ones first, then by
 * last-worked time) to match the sidebar; otherwise stored order is preserved.
 */
export function buildSidebarWorkspaceOrder(
  workspaces: Workspace[],
  isWorkspaceLive?: (workspace: Workspace) => boolean,
): Map<string, number> {
  const order = new Map<string, number>()
  let index = 0

  const starred = workspaces.filter((workspace) => isStarred(workspace.highlight))
  const orderedStarred = isWorkspaceLive
    ? sortWorkspacesByActivity(starred, isWorkspaceLive)
    : starred
  for (const workspace of orderedStarred) order.set(workspace.id, index++)

  const seenFolders: string[] = []
  const folderBuckets = new Map<string, Workspace[]>()
  for (const workspace of workspaces) {
    if (isStarred(workspace.highlight)) continue
    const folderPath = workspace.folderPath ?? null
    const key = folderPath
      ? folderPath.replace(/\\/g, '/').replace(/\/+$/u, '').toLowerCase()
      : '__no_folder__'
    if (!folderBuckets.has(key)) {
      seenFolders.push(key)
      folderBuckets.set(key, [])
    }
    folderBuckets.get(key)!.push(workspace)
  }
  for (const key of seenFolders) {
    const bucket = folderBuckets.get(key)!
    const orderedBucket = isWorkspaceLive
      ? sortWorkspacesByActivity(bucket, isWorkspaceLive)
      : bucket
    for (const workspace of orderedBucket) {
      order.set(workspace.id, index++)
    }
  }
  return order
}

// getTerminalSessionsSignature moved to ../../hooks/useTerminalSessions to avoid
// an import cycle (the hook now uses it internally to dedupe no-op broadcasts).

export function toProjectRelativeStatePath(
  path: string | null | undefined,
  workspaceRoot: string | null | undefined,
): string {
  if (!path) return 'multiloop/<loop>/state.json'

  const normalizedPath = path.replace(/\\/g, '/')
  const normalizedRoot = workspaceRoot?.replace(/\\/g, '/').replace(/\/+$/u, '')
  if (
    normalizedRoot &&
    (normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`))
  ) {
    return normalizedPath.slice(normalizedRoot.length).replace(/^\/+/u, '') || '.'
  }

  const multiloopIndex = normalizedPath.lastIndexOf('/multiloop/')
  return multiloopIndex >= 0 ? normalizedPath.slice(multiloopIndex + 1) : 'multiloop/<loop>/state.json'
}

export function buildMultiloopSpawnPrompt({
  soul,
  multiloopPrompt,
  workspace,
  agentId,
}: {
  soul: MultiloopRoleDescriptor
  multiloopPrompt: string
  workspace: Workspace
  agentId: string
}): string {
  const state = workspace.multiloopState
  const currentMilestone = state ? getActiveMultiloopMilestone(state) : null
  const readyTaskIdsForRole =
    state && currentMilestone
      ? getMultiloopTasksForMilestone(state, currentMilestone.id)
          .filter((task) => task.role === soul.role && task.status === 'ready')
          .map((task) => task.id)
      : []
  const context = buildMultiloopLaunchContextLines({
    roleLabel: soul.label,
    role: soul.role,
    agentId,
    readyTaskIdsForRole,
    loopName: state?.loop.displayName ?? workspace.multiloopContext?.loopName ?? workspace.name,
    finalGoal: state?.loop.finalGoal ?? null,
    currentMilestone,
    statePath: toProjectRelativeStatePath(
      workspace.multiloopContext?.statePath,
      workspace.folderPath,
    ),
  })

  return [multiloopPrompt.trim(), ...context].join('\n')
}
