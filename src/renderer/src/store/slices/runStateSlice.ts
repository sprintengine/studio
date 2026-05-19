import {
  buildSprintEngineAgentRosterForState,
  getNextSprintEngineAgentId,
  normalizeSprintEngineState,
} from '../../utils/sprintengine'
import {
  getSprintEngineDirectoryPath,
  getSprintEngineStateFilePath,
  slugifySprintEngineName,
} from '../../utils/sprintengineStateFile'
import {
  getMultiloopDirectoryPath,
  getMultiloopStateFilePath,
  slugifyMultiloopName,
} from '../../utils/multiloopStateFile'
import {
  defaultAgent,
  normalizeAgentState,
  pickWorkspaceAgentName,
} from './agentsSlice'
import {
  ensureMultiloopLayoutModel,
  sprintEngineTabsLayoutModel,
} from './layoutSlice'
import { normalizeCliPermissionPreset } from './settingsSlice'
import type {
  AgentId,
  MultiloopAutoPendingSpawn,
  MultiloopAutoState,
  MultiloopRole,
  MultiloopState,
  MultiloopWorkspaceContext,
  SprintEngineAutoPendingSpawn,
  SprintEngineAutoState,
  SprintEngineCliPermissionPreset,
  SprintEngineRole,
  SprintEngineRoleCliDefaults,
  SprintEngineState,
  SprintEngineWorkspaceContext,
  Workspace,
  WorkspaceId,
} from '../../types/workspace'

export const defaultSprintEngineAutoState = (): SprintEngineAutoState => ({
  enabled: false,
  autoApproveArtifacts: false,
  keepDoneAgentTerminals: false,
  cliPermissionPreset: 'default',
  maxConcurrentAgents: 3,
  pendingSpawns: [],
  deliveredAgentNotificationEventKeys: [],
})

export const defaultMultiloopAutoState = (): MultiloopAutoState => ({
  enabled: false,
  cliPermissionPreset: 'default',
  maxConcurrentAgents: 1,
  coordinatorAutoSpawnKey: null,
  pendingSpawns: [],
})

const defaultSprintEngineRoleCliDefaults = (): Required<SprintEngineRoleCliDefaults> => ({
  architect: 'codex',
  product: 'codex',
  frontend: 'codex',
  developer: 'codex',
  code_reviewer: 'codex',
  spec_reviewer: 'codex',
  performance: 'codex',
  tester: 'codex',
  security: 'codex',
})

export function normalizeSprintEngineRoleCliDefaults(
  input: SprintEngineRoleCliDefaults | null | undefined
): Required<SprintEngineRoleCliDefaults> {
  const defaults = defaultSprintEngineRoleCliDefaults()
  const next = { ...defaults }

  Object.keys(defaults).forEach((role) => {
    const value = input?.[role as SprintEngineRole]
    if (value === 'codex' || value === 'claude') {
      next[role as SprintEngineRole] = value
    }
  })

  return next
}

function normalizeSprintEngineAutoPendingSpawn(
  input: Partial<SprintEngineAutoPendingSpawn> | null | undefined
): SprintEngineAutoPendingSpawn | null {
  return typeof input?.taskId === 'string' && typeof input.agentId === 'string'
    ? {
      taskId: input.taskId,
      ...(typeof input.gateId === 'string' && input.gateId ? { gateId: input.gateId } : {}),
      agentId: input.agentId,
      ...(typeof input.startedAt === 'number' ? { startedAt: input.startedAt } : {}),
    }
    : null
}

function isMultiloopAutoRole(input: unknown): input is MultiloopRole | SprintEngineRole {
  return input === 'coordinator'
    || input === 'architect'
    || input === 'product'
    || input === 'developer'
    || input === 'frontend'
    || input === 'tester'
    || input === 'security'
    || input === 'code_reviewer'
    || input === 'spec_reviewer'
    || input === 'performance'
}

function normalizeMultiloopAutoPendingSpawn(
  input: Partial<MultiloopAutoPendingSpawn> | null | undefined
): MultiloopAutoPendingSpawn | null {
  if (!input || !isMultiloopAutoRole(input.role) || typeof input.agentId !== 'string') return null

  return {
    role: input.role,
    agentId: input.agentId,
    taskId: typeof input.taskId === 'string' ? input.taskId : null,
    ...(typeof input.startedAt === 'number' ? { startedAt: input.startedAt } : {}),
  }
}

export function normalizeSprintEngineAutoState(
  input: (
    Partial<SprintEngineAutoState> & {
      pending?: SprintEngineAutoPendingSpawn | null
      deliveredAgentNotificationEventIds?: string[]
    }
  ) | null | undefined
): SprintEngineAutoState {
  const legacyPending = normalizeSprintEngineAutoPendingSpawn(input?.pending)
  const pendingSpawns = Array.isArray(input?.pendingSpawns)
    ? input.pendingSpawns
      .map((pending) => normalizeSprintEngineAutoPendingSpawn(pending))
      .filter((pending): pending is SprintEngineAutoPendingSpawn => Boolean(pending))
    : legacyPending
      ? [legacyPending]
      : []
  const deliveredAgentNotificationEventKeysInput =
    Array.isArray(input?.deliveredAgentNotificationEventKeys)
      ? input.deliveredAgentNotificationEventKeys
      : Array.isArray(input?.deliveredAgentNotificationEventIds)
        ? input.deliveredAgentNotificationEventIds
        : []
  const deliveredAgentNotificationEventKeys = deliveredAgentNotificationEventKeysInput.length > 0
    ? deliveredAgentNotificationEventKeysInput
      .filter((eventKey): eventKey is string => typeof eventKey === 'string' && eventKey.trim().length > 0)
    : []
  const cliPermissionPreset = normalizeCliPermissionPreset(input?.cliPermissionPreset)
  const maxConcurrentAgents =
    typeof input?.maxConcurrentAgents === 'number' && Number.isFinite(input.maxConcurrentAgents)
      ? Math.max(1, Math.min(10, Math.floor(input.maxConcurrentAgents)))
      : 3

  return {
    enabled: Boolean(input?.enabled),
    autoApproveArtifacts: Boolean(input?.autoApproveArtifacts),
    keepDoneAgentTerminals: Boolean(input?.keepDoneAgentTerminals),
    cliPermissionPreset,
    maxConcurrentAgents,
    pendingSpawns,
    deliveredAgentNotificationEventKeys,
  }
}

export function normalizeMultiloopAutoState(
  input: Partial<MultiloopAutoState> | null | undefined
): MultiloopAutoState {
  const pendingSpawns = Array.isArray(input?.pendingSpawns)
    ? input.pendingSpawns
      .map((pending) => normalizeMultiloopAutoPendingSpawn(pending))
      .filter((pending): pending is MultiloopAutoPendingSpawn => Boolean(pending))
    : []

  const maxConcurrentAgents =
    typeof input?.maxConcurrentAgents === 'number' && Number.isFinite(input.maxConcurrentAgents)
      ? Math.max(1, Math.min(4, Math.floor(input.maxConcurrentAgents)))
      : 1

  return {
    enabled: Boolean(input?.enabled),
    cliPermissionPreset: normalizeCliPermissionPreset(input?.cliPermissionPreset),
    maxConcurrentAgents,
    coordinatorAutoSpawnKey:
      typeof input?.coordinatorAutoSpawnKey === 'string'
        ? input.coordinatorAutoSpawnKey
        : null,
    pendingSpawns,
  }
}

function createSprintEngineWorkspaceContext(
  folderPath: string | null | undefined,
  teamName: string | null | undefined,
  teamSlug?: string | null
): SprintEngineWorkspaceContext | null {
  if (!folderPath || !teamName?.trim()) return null

  const slug = teamSlug?.trim() || slugifySprintEngineName(teamName)
  return {
    teamName: teamName.trim(),
    teamSlug: slug,
    teamDirectoryPath: getSprintEngineDirectoryPath(folderPath, slug),
    statePath: getSprintEngineStateFilePath(folderPath, slug),
  }
}

export function normalizeSprintEngineWorkspaceContext(
  input: Partial<SprintEngineWorkspaceContext> | null | undefined,
  folderPath: string | null | undefined,
  sprintEngineState: SprintEngineState | null
): SprintEngineWorkspaceContext | null {
  if (!sprintEngineState) return null

  if (input?.teamSlug && input.teamName) {
    return createSprintEngineWorkspaceContext(folderPath, input.teamName, input.teamSlug)
  }

  return createSprintEngineWorkspaceContext(folderPath, sprintEngineState?.name)
}

function createMultiloopWorkspaceContext(
  folderPath: string | null | undefined,
  loopName: string | null | undefined,
  loopSlug?: string | null
): MultiloopWorkspaceContext | null {
  if (!folderPath || !loopName?.trim()) return null

  const slug = loopSlug?.trim() || slugifyMultiloopName(loopName)
  return {
    loopName: loopName.trim(),
    loopSlug: slug,
    loopDirectoryPath: getMultiloopDirectoryPath(folderPath, slug),
    statePath: getMultiloopStateFilePath(folderPath, slug),
  }
}

function isCompleteMultiloopWorkspaceContext(
  input: Partial<MultiloopWorkspaceContext> | null | undefined
): input is MultiloopWorkspaceContext {
  return Boolean(
    input?.loopName?.trim()
    && input.loopSlug?.trim()
    && input.loopDirectoryPath?.trim()
    && input.statePath?.trim()
  )
}

export function normalizeMultiloopWorkspaceContext(
  input: Partial<MultiloopWorkspaceContext> | null | undefined,
  folderPath: string | null | undefined,
  multiloopState: MultiloopState | null
): MultiloopWorkspaceContext | null {
  const loopName = input?.loopName ?? multiloopState?.loop.displayName ?? multiloopState?.loop.name

  if (folderPath && loopName) {
    return createMultiloopWorkspaceContext(folderPath, loopName, input?.loopSlug)
  }

  if (isCompleteMultiloopWorkspaceContext(input)) {
    return {
      loopName: input.loopName.trim(),
      loopSlug: input.loopSlug.trim(),
      loopDirectoryPath: input.loopDirectoryPath,
      statePath: input.statePath,
    }
  }

  return null
}

function isDefaultSprintEngineAgentName(name: string | undefined, fallbackLabel: string): boolean {
  return !name || name === fallbackLabel
}

export function reconcileSprintEngineAgents(
  currentAgents: Workspace['agents'],
  sprintEngineState: SprintEngineState | null
): Workspace['agents'] {
  if (!sprintEngineState) return {}

  const nextAgents: Workspace['agents'] = {}
  const rosterAgents = Object.fromEntries(
    buildSprintEngineAgentRosterForState(sprintEngineState).map((agent) => {
      const current = currentAgents[agent.id]
      const nextName = isDefaultSprintEngineAgentName(current?.name, agent.label)
        ? pickWorkspaceAgentName({ ...currentAgents, ...nextAgents })
        : current?.name ?? agent.label
      const nextAgent = current
        ? normalizeAgentState({ ...current, name: nextName, kind: 'sprintengine' as const })
        : defaultAgent(agent.id, nextName, 'sprintengine')
      nextAgents[agent.id] = nextAgent
      return [agent.id, nextAgent]
    })
  )

  const specialistAgents = Object.fromEntries(
    Object.entries(currentAgents).filter(([id, agent]) =>
      (agent.kind === 'specialist' || agent.kind === 'watchtower') && !rosterAgents[id]
    ).map(([id, agent]) => [id, normalizeAgentState(agent)])
  )
  const transientSprintEngineAgents = Object.fromEntries(
    Object.entries(currentAgents).filter(([id, agent]) =>
      agent.kind === 'sprintengine'
      && !rosterAgents[id]
      && Boolean(agent.cliStartRequested || agent.cliHasLaunched || agent.cliSessionId)
    ).map(([id, agent]) => [id, normalizeAgentState(agent)])
  )

  return {
    ...specialistAgents,
    ...transientSprintEngineAgents,
    ...rosterAgents,
  }
}

export function migrateSprintEngineAgentNames(ws: Workspace): Workspace {
  const sprintEngineState = normalizeSprintEngineState(ws.sprintEngineState)
  if (ws.mode !== 'sprintengine' && !sprintEngineState) return ws

  const agents = reconcileSprintEngineAgents(ws.agents ?? {}, sprintEngineState)
  return {
    ...ws,
    sprintEngineState,
    agents,
    layoutModel: sprintEngineTabsLayoutModel(sprintEngineState, agents),
  }
}

export interface RunStateSliceState {}

export interface RunStateSliceActions {
  setSprintEngineContext: (id: WorkspaceId, sprintEngineContext: SprintEngineWorkspaceContext | null) => void
  setMultiloopContext: (id: WorkspaceId, multiloopContext: MultiloopWorkspaceContext | null) => void
  setSprintEngineState: (workspaceId: WorkspaceId, sprintEngineState: SprintEngineState | null) => void
  setMultiloopState: (workspaceId: WorkspaceId, multiloopState: MultiloopState | null) => void
  setSprintEngineAutoEnabled: (workspaceId: WorkspaceId, enabled: boolean) => void
  setSprintEngineAutoApproveArtifacts: (workspaceId: WorkspaceId, autoApproveArtifacts: boolean) => void
  setSprintEngineKeepDoneAgentTerminals: (workspaceId: WorkspaceId, keepDoneAgentTerminals: boolean) => void
  setSprintEngineCliPermissionPreset: (
    workspaceId: WorkspaceId,
    cliPermissionPreset: SprintEngineCliPermissionPreset
  ) => void
  setSprintEngineMaxConcurrentAgents: (workspaceId: WorkspaceId, maxConcurrentAgents: number) => void
  setSprintEngineAutoPendingSpawns: (
    workspaceId: WorkspaceId,
    pendingSpawns: SprintEngineAutoPendingSpawn[]
  ) => void
  markSprintEngineAgentNotificationDelivered: (workspaceId: WorkspaceId, eventKey: string) => void
  setMultiloopAutoEnabled: (workspaceId: WorkspaceId, enabled: boolean) => void
  setMultiloopCliPermissionPreset: (
    workspaceId: WorkspaceId,
    cliPermissionPreset: SprintEngineCliPermissionPreset
  ) => void
  setMultiloopAutoPendingSpawns: (
    workspaceId: WorkspaceId,
    pendingSpawns: MultiloopAutoPendingSpawn[]
  ) => void
  setMultiloopCoordinatorAutoSpawnKey: (workspaceId: WorkspaceId, key: string | null) => void
  addSprintEngineMember: (
    workspaceId: WorkspaceId,
    role: SprintEngineRole
  ) => { id: AgentId; label: string } | null
}

export type RunStateSlice = RunStateSliceState & RunStateSliceActions

type RunStateSliceCarrier = { workspaces: Workspace[] }
type RunStateSliceSet = (mutator: (state: RunStateSliceCarrier) => void) => void

export function createRunStateSlice(set: RunStateSliceSet): RunStateSlice {
  return {
    setSprintEngineContext: (id, sprintEngineContext) =>
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === id)
        if (ws) ws.sprintEngineContext = sprintEngineContext
      }),

    setMultiloopContext: (id, multiloopContext) =>
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === id)
        if (ws) ws.multiloopContext = multiloopContext
      }),

    setSprintEngineState: (workspaceId, sprintEngineState) =>
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === workspaceId)
        if (!ws) return
        const normalized = normalizeSprintEngineState(sprintEngineState)
        ws.sprintEngineState = normalized
        ws.mode = normalized ? 'sprintengine' : 'standard'
        ws.sprintEngineContext = normalizeSprintEngineWorkspaceContext(
          ws.sprintEngineContext,
          ws.folderPath,
          normalized
        )
        ws.agents = reconcileSprintEngineAgents(ws.agents, normalized)
        ws.sprintEngineAutoState = normalized
          ? normalizeSprintEngineAutoState(ws.sprintEngineAutoState)
          : defaultSprintEngineAutoState()
      }),

    setMultiloopState: (workspaceId, multiloopState) =>
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === workspaceId)
        if (!ws) return
        ws.multiloopState = multiloopState
        ws.mode = multiloopState
          ? 'multiloop'
          : ws.sprintEngineState
            ? 'sprintengine'
            : 'standard'
        ws.multiloopContext = normalizeMultiloopWorkspaceContext(
          ws.multiloopContext,
          ws.folderPath,
          multiloopState
        )
        if (multiloopState) ws.layoutModel = ensureMultiloopLayoutModel(ws.layoutModel)
        ws.multiloopAutoState = multiloopState
          ? normalizeMultiloopAutoState(ws.multiloopAutoState)
          : defaultMultiloopAutoState()
      }),

    setSprintEngineAutoEnabled: (workspaceId, enabled) =>
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === workspaceId)
        if (!ws) return
        const current = normalizeSprintEngineAutoState(ws.sprintEngineAutoState)
        ws.sprintEngineAutoState = {
          ...current,
          enabled,
          pendingSpawns: enabled ? current.pendingSpawns : [],
        }
      }),

    setSprintEngineAutoApproveArtifacts: (workspaceId, autoApproveArtifacts) =>
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === workspaceId)
        if (!ws) return
        const current = normalizeSprintEngineAutoState(ws.sprintEngineAutoState)
        ws.sprintEngineAutoState = {
          ...current,
          autoApproveArtifacts,
        }
      }),

    setSprintEngineKeepDoneAgentTerminals: (workspaceId, keepDoneAgentTerminals) =>
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === workspaceId)
        if (!ws) return
        const current = normalizeSprintEngineAutoState(ws.sprintEngineAutoState)
        ws.sprintEngineAutoState = {
          ...current,
          keepDoneAgentTerminals,
        }
      }),

    setSprintEngineCliPermissionPreset: (workspaceId, cliPermissionPreset) =>
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === workspaceId)
        if (!ws) return
        const current = normalizeSprintEngineAutoState(ws.sprintEngineAutoState)
        ws.sprintEngineAutoState = {
          ...current,
          cliPermissionPreset,
        }
      }),

    setSprintEngineMaxConcurrentAgents: (workspaceId, maxConcurrentAgents) =>
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === workspaceId)
        if (!ws) return
        const current = normalizeSprintEngineAutoState(ws.sprintEngineAutoState)
        ws.sprintEngineAutoState = {
          ...current,
          maxConcurrentAgents: Math.max(1, Math.min(10, Math.floor(maxConcurrentAgents))),
        }
      }),

    setSprintEngineAutoPendingSpawns: (workspaceId, pendingSpawns) =>
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === workspaceId)
        if (!ws) return
        const current = normalizeSprintEngineAutoState(ws.sprintEngineAutoState)
        ws.sprintEngineAutoState = {
          ...current,
          pendingSpawns,
        }
      }),

    markSprintEngineAgentNotificationDelivered: (workspaceId, eventKey) =>
      set((state) => {
        const trimmedEventKey = eventKey.trim()
        if (!trimmedEventKey) return
        const ws = state.workspaces.find((w) => w.id === workspaceId)
        if (!ws) return
        const current = normalizeSprintEngineAutoState(ws.sprintEngineAutoState)
        if (current.deliveredAgentNotificationEventKeys.includes(trimmedEventKey)) return
        ws.sprintEngineAutoState = {
          ...current,
          deliveredAgentNotificationEventKeys: [
            ...current.deliveredAgentNotificationEventKeys,
            trimmedEventKey,
          ],
        }
      }),

    setMultiloopAutoEnabled: (workspaceId, enabled) =>
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === workspaceId)
        if (!ws) return
        const current = normalizeMultiloopAutoState(ws.multiloopAutoState)
        ws.multiloopAutoState = {
          ...current,
          enabled,
          pendingSpawns: enabled ? current.pendingSpawns : [],
        }
      }),

    setMultiloopCliPermissionPreset: (workspaceId, cliPermissionPreset) =>
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === workspaceId)
        if (!ws) return
        const current = normalizeMultiloopAutoState(ws.multiloopAutoState)
        ws.multiloopAutoState = {
          ...current,
          cliPermissionPreset,
        }
      }),

    setMultiloopAutoPendingSpawns: (workspaceId, pendingSpawns) =>
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === workspaceId)
        if (!ws) return
        const current = normalizeMultiloopAutoState(ws.multiloopAutoState)
        ws.multiloopAutoState = {
          ...current,
          pendingSpawns: pendingSpawns
            .map((pending) => normalizeMultiloopAutoPendingSpawn(pending))
            .filter((pending): pending is MultiloopAutoPendingSpawn => Boolean(pending)),
        }
      }),

    setMultiloopCoordinatorAutoSpawnKey: (workspaceId, key) =>
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === workspaceId)
        if (!ws) return
        const current = normalizeMultiloopAutoState(ws.multiloopAutoState)
        ws.multiloopAutoState = {
          ...current,
          coordinatorAutoSpawnKey: key,
        }
      }),

    addSprintEngineMember: (workspaceId, role) => {
      let addedAgent: { id: AgentId; label: string } | null = null

      set((state) => {
        const ws = state.workspaces.find((w) => w.id === workspaceId)
        if (!ws?.sprintEngineState) return

        const agentId = getNextSprintEngineAgentId(role, ws.sprintEngineState.sprintEngineAgents)
        ws.sprintEngineState.sprintEngineAgents[agentId] = {
          role,
          status: 'idle',
          currentTaskId: null,
        }
        ws.sprintEngineState.roleCounts[role] += 1

        const rosterAgent = buildSprintEngineAgentRosterForState(ws.sprintEngineState).find(
          (agent) => agent.id === agentId
        )
        const agentRoleLabel = rosterAgent?.label ?? agentId
        const agentLabel = pickWorkspaceAgentName(ws.agents)
        const roleCliDefaults = normalizeSprintEngineRoleCliDefaults(ws.sprintEngineRoleCliDefaults)
        ws.agents[agentId] = {
          ...defaultAgent(agentId, agentLabel, 'sprintengine'),
          cli: roleCliDefaults[role],
        }
        ws.agents = reconcileSprintEngineAgents(ws.agents, ws.sprintEngineState)
        ws.sprintEngineState.events.push({
          id: `EVT-${String(ws.sprintEngineState.events.length + 1).padStart(3, '0')}`,
          timestamp: new Date().toISOString(),
          type: 'member_added',
          actor: 'user',
          message: `${agentLabel} joined the sprintengine as ${agentRoleLabel}.`,
        })

        addedAgent = { id: agentId, label: agentLabel }
      })

      return addedAgent
    },
  }
}
