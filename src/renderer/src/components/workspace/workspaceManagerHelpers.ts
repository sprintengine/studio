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
import { findWorkspaceForAgentPreferring } from '../../utils/agentLocation'
import { sortWorkspacesByActivity } from '../../utils/workspaceRecency'
import {
  deriveWorkspaceDisplayActivity,
  isLiveTerminal,
} from '../../hooks/useTerminalSessions'
import type { Workspace } from '../../types/workspace'
import type { MultiloopRoleDescriptor } from '../../specialists/specialistActions'
import type { SessionItem } from './WorkspaceTopBar'

export type WorkspaceActivity = 'needs-input' | 'working' | 'failed' | 'idle'
export type SessionStatus = 'needs-input' | 'working' | 'idle' | 'failed'

// Honest per-session status for the session manager, merged from the
// authoritative lifecycle-hook phase (`session.agentState`, when present) with
// the legacy output-timing heuristic as the floor. See
// backlog/2026-06-10-truthful-agent-activity.md.
export type SessionStatusInfo = {
  status: SessionStatus
  // Provenance of the signal: 'hook' when an authoritative lifecycle-hook frame
  // drove it, 'inferred' when it fell back to output-timing recency.
  source: AgentStateSource
  // When the current status began (ms epoch) — drives "active 2m" / "waiting 4m".
  activitySince: number
  // Most recent real activity (max of last output/input), for "idle · 12m" recency.
  lastActivityAt: number | null
  // Exit code when `status === 'failed'`, else null.
  exitCode: number | null
}

// Hook phases that mean the agent is actively doing work (not waiting, not done).
const WORKING_AGENT_PHASES: ReadonlySet<AgentPhase> = new Set([
  'starting',
  'thinking',
  'tool_use',
])

// Attention-first ordering for session rows: things that need the user come
// first, idle last.
const SESSION_STATUS_ORDER: Record<SessionStatus, number> = {
  'needs-input': 0,
  failed: 1,
  working: 2,
  idle: 3,
}

function maxTimestamp(a: number | null, b: number | null): number | null {
  const values = [a, b].filter((value): value is number => typeof value === 'number')
  return values.length > 0 ? Math.max(...values) : null
}

function activityStartedAt(activity: SessionActivity): number {
  return activity.kind === 'working' || activity.kind === 'idle' ? activity.since : activity.at
}

// Single source of truth for "what is this session doing", prioritizing the
// authoritative hook phase and degrading gracefully to output recency.
export function deriveSessionStatus(
  session: TerminalSessionSnapshot,
  runtimeNeedsInput: boolean,
): SessionStatusInfo {
  const hook = session.agentState
  const source: AgentStateSource = hook?.source ?? 'inferred'
  const lastActivityAt = maxTimestamp(session.lastOutputAt, session.lastInputAt)
  const fallbackSince = activityStartedAt(session.activity)

  // A retained crash is terminal — surface it so it stops silently vanishing.
  if (session.activity.kind === 'failed') {
    return {
      status: 'failed',
      source,
      activitySince: session.activity.at,
      lastActivityAt,
      exitCode: session.activity.exitCode,
    }
  }

  // Needs-input: authoritative hook phase, or a Sprint Engine MCP self-report.
  // This is the most expensive state to miss, so it outranks working/idle.
  if (hook?.phase === 'awaiting_input' || runtimeNeedsInput) {
    return {
      status: 'needs-input',
      source,
      activitySince: hook?.phase === 'awaiting_input' ? hook.since : fallbackSince,
      lastActivityAt,
      exitCode: null,
    }
  }

  // Working: trust the hook's working phases when present; otherwise fall back to
  // "produced output recently". `stalled`/`idle`/`exited` hook phases fall through
  // to idle below.
  const working = hook
    ? WORKING_AGENT_PHASES.has(hook.phase)
    : session.activity.kind === 'working'
  if (working) {
    return {
      status: 'working',
      source,
      activitySince: hook ? hook.since : fallbackSince,
      lastActivityAt,
      exitCode: null,
    }
  }

  return {
    status: 'idle',
    source,
    activitySince: hook ? hook.since : fallbackSince,
    lastActivityAt,
    exitCode: null,
  }
}

// Attention-first comparator for rows within a workspace group: needs-input →
// failed → working → idle, then most-recently-active first within a tier.
export function compareSessionItemsByAttention(a: SessionItem, b: SessionItem): number {
  const byStatus = SESSION_STATUS_ORDER[a.status] - SESSION_STATUS_ORDER[b.status]
  if (byStatus !== 0) return byStatus
  const aRecency = a.lastActivityAt ?? a.activitySince
  const bRecency = b.lastActivityAt ?? b.activitySince
  return bRecency - aRecency
}

// Trigger-badge tone: the badge must not repeat the "everything is fine" lie.
// Warn when anything needs the user, error when anything crashed, else good.
export function sessionsAttentionTone(items: SessionItem[]): 'good' | 'warn' | 'error' {
  if (items.some((item) => item.status === 'needs-input')) return 'warn'
  if (items.some((item) => item.status === 'failed')) return 'error'
  return 'good'
}

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
    .filter(
      (session) =>
        typeof session.workspaceId === 'string'
        // Live sessions, plus retained *failed* agent sessions so a crashed agent
        // demands attention instead of silently disappearing from the list.
        && (isLiveTerminal(session)
          || (session.kind === 'agent' && session.activity.kind === 'failed')),
    )
    .flatMap((session): SessionItem[] => {
      // Agent terminals can be moved between workspaces after spawn, but the PTY
      // session keeps its spawn-time workspaceId. Resolve an agent's *current*
      // workspace preferring that recorded workspace (it disambiguates shared ids
      // like `agent-1`, which recur in every template-built workspace), falling
      // back to a global scan only for a genuinely-moved agent; otherwise a moved
      // agent would open and mutate state in the workspace it left.
      const workspace =
        (session.kind === 'agent' && session.agentId
          ? findWorkspaceForAgentPreferring(workspaces, session.agentId, session.workspaceId)
          : null)
        ?? workspaces.find((candidate) => candidate.id === session.workspaceId)
      if (!workspace) return []

      if (session.kind === 'agent') {
        if (!session.agentId) return []
        const agent = workspace.agents[session.agentId]
        const runtime = workspace.sprintEngineState?.sprintEngineAgents[session.agentId]
        const statusInfo = deriveSessionStatus(session, runtime?.status === 'needs_input')
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
            status: statusInfo.status,
            source: statusInfo.source,
            activitySince: statusInfo.activitySince,
            lastActivityAt: statusInfo.lastActivityAt,
            exitCode: statusInfo.exitCode,
            role: runtime?.role ?? null,
            specialistId,
            multiloopRole,
            taskId: runtime?.currentTaskId ?? null,
            sessionId: session.sessionId,
          },
        ]
      }

      const terminalId = session.terminalId ?? session.sessionId.replace(/^terminal-/, '')
      // Plain terminals have no lifecycle hooks; their status is honest
      // output-recency (working while producing output, otherwise idle).
      const statusInfo = deriveSessionStatus(session, false)
      return [
        {
          workspace,
          kind: session.kind,
          agentId: null,
          terminalId,
          label: terminalSessionLabel(terminalId),
          cli: session.cli ?? '',
          status: statusInfo.status,
          source: statusInfo.source,
          activitySince: statusInfo.activitySince,
          lastActivityAt: statusInfo.lastActivityAt,
          exitCode: statusInfo.exitCode,
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
 * once. Both the starred section and each folder's rows are ordered by
 * most-recently-worked time (never by live status), matching the sidebar.
 */
export function buildSidebarWorkspaceOrder(
  workspaces: Workspace[],
): Map<string, number> {
  const order = new Map<string, number>()
  let index = 0

  const starred = workspaces.filter((workspace) => isStarred(workspace.highlight))
  for (const workspace of sortWorkspacesByActivity(starred)) order.set(workspace.id, index++)

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
    for (const workspace of sortWorkspacesByActivity(bucket)) {
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
