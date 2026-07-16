import {
  buildSprintEngineAgentRosterForState,
  getNextSprintEngineAgentId,
  normalizeSprintEngineState,
} from '../../utils/sprintengine'
import { deriveSprintEngineAutomationMode } from '../../utils/sprintengineAutomation'
import {
  deriveSprintEngineAutomationDesiredMode,
  normalizeSprintEngineAutomationRuntimeState,
  normalizeSprintEngineAutomationStopReason,
  transitionSprintEngineAutomation,
} from '../../utils/sprintengineAutomationLifecycle'
import { auditSprintEngineLifecycleTransition } from '../../utils/sprintengineAutomationAudit'
import { pushSprintEngineAutomationModeIntent } from '../../utils/sprintengineAutomationIntentClient'
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
import {
  normalizeCliPermissionPreset,
  normalizeSprintEngineRunSettings,
  sprintEngineRunSettingsKey,
} from './settingsSlice'
import type {
  AgentCli,
  AgentState,
  AgentId,
  AppSettings,
  MultiloopAutoPendingSpawn,
  MultiloopAutoState,
  MultiloopRole,
  MultiloopState,
  MultiloopWorkspaceContext,
  SprintEngineAutoState,
  SprintEngineAutomationEvent,
  SprintEngineAutomationMode,
  SprintEngineCliPermissionPreset,
  SprintEngineRoleId,
  SprintEngineRoleCliDefaults,
  SprintEngineRosterSession,
  SprintEngineRunSettings,
  SprintEngineState,
  SprintEngineWorkspaceContext,
  Workspace,
  WorkspaceId,
} from '../../types/workspace'

export const defaultSprintEngineAutoState = (): SprintEngineAutoState => ({
  desiredMode: 'manual',
  runtimeState: 'idle',
  reason: undefined,
  reasonMessage: undefined,
  reasonTaskId: undefined,
  reasonAgentId: undefined,
  changedAt: undefined,
  cliPermissionPreset: 'default',
  maxConcurrentAgents: 3,
  deliveredAgentNotificationEventKeys: [],
  completionTeardownAt: undefined,
})

export const defaultMultiloopAutoState = (): MultiloopAutoState => ({
  enabled: false,
  cliPermissionPreset: 'default',
  maxConcurrentAgents: 1,
  coordinatorAutoSpawnKey: null,
  pendingSpawns: [],
})

const defaultSprintEngineRoleCliDefaults = (): Required<SprintEngineRoleCliDefaults> => ({
  architect: 'claude-code',
  product: 'claude-code',
  frontend: 'claude-code',
  ui_ux_reviewer: 'claude-code',
  developer: 'claude-code',
  performance: 'claude-code',
  production_readiness_reviewer: 'claude-code',
  cross_platform: 'claude-code',
  tester: 'claude-code',
  security: 'claude-code',
})

export function normalizeSprintEngineRoleCliDefaults(
  input: SprintEngineRoleCliDefaults | null | undefined
): Required<SprintEngineRoleCliDefaults> {
  const defaults = defaultSprintEngineRoleCliDefaults()
  const next = { ...defaults }

  const entries = input && typeof input === 'object'
    ? Object.entries(input)
    : Object.entries(defaults)
  for (const [role, value] of entries) {
    if (typeof value === 'string' && value.trim()) {
      next[role] = value.trim()
    }
  }

  return next
}

function resolveSprintEngineRoleCli(
  roleCliDefaults: Required<SprintEngineRoleCliDefaults>,
  role: SprintEngineRoleId
): AgentCli {
  const cli = roleCliDefaults[role]
  if (typeof cli === 'string' && cli.trim()) return cli.trim()
  // SprintEngineRoleId is open-ended (custom/user-defined roles), so a role
  // missing from the defaults map must never throw — that would abort workspace
  // creation or roster-member addition for an otherwise valid run. Fall back to
  // the team's architect CLI (always present after normalization), else the
  // universal default.
  return roleCliDefaults.architect?.trim() || 'claude-code'
}

// `resolveSprintEngineRoleRuntime` / `resolveSprintEngineAgentRuntime` moved
// to the shared Sprint Engine state module (sprint-runtime-ownership Phase 2:
// the main-process auto-run planner resolves runtimes too); these re-exports
// keep every existing import site working unchanged.
import {
  resolveSprintEngineAgentRuntime,
  resolveSprintEngineRoleRuntime,
} from '../../../../shared/sprintengine/state'

export { resolveSprintEngineAgentRuntime, resolveSprintEngineRoleRuntime }

function isMultiloopAutoRole(input: unknown): input is MultiloopRole | SprintEngineRoleId {
  return typeof input === 'string' && input.trim().length > 0
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
      deliveredAgentNotificationEventIds?: string[]
    }
  ) | null | undefined
): SprintEngineAutoState {
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

  const desiredMode = deriveSprintEngineAutomationDesiredMode(input)
  const runtimeState = normalizeSprintEngineAutomationRuntimeState(input?.runtimeState, desiredMode)

  return {
    desiredMode,
    runtimeState,
    reason: normalizeSprintEngineAutomationStopReason(input?.reason),
    reasonMessage: typeof input?.reasonMessage === 'string' ? input.reasonMessage : undefined,
    reasonTaskId: typeof input?.reasonTaskId === 'string' ? input.reasonTaskId : undefined,
    reasonAgentId: typeof input?.reasonAgentId === 'string' ? input.reasonAgentId : undefined,
    changedAt: typeof input?.changedAt === 'number' && Number.isFinite(input.changedAt)
      ? input.changedAt
      : undefined,
    cliPermissionPreset,
    maxConcurrentAgents,
    deliveredAgentNotificationEventKeys,
    // Preserve the one-shot completion-teardown marker: this normalizer runs on
    // every projection write (`setSprintEngineState`), so dropping the field
    // here would re-arm teardown each poll and resurrect the kill-resumed-panel
    // loop it exists to prevent.
    completionTeardownAt:
      typeof input?.completionTeardownAt === 'number' && Number.isFinite(input.completionTeardownAt)
        ? input.completionTeardownAt
        : undefined,
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

function agentExecutionsEqual(
  left: AgentState['execution'] | undefined,
  right: AgentState['execution'] | undefined
): boolean {
  return left?.mode === right?.mode
    && left?.worktreeId === right?.worktreeId
    && left?.cwd === right?.cwd
}

function agentConversationsEqual(
  left: AgentState['conversation'] | undefined,
  right: AgentState['conversation'] | undefined
): boolean {
  return left?.providerId === right?.providerId
    && left?.modelId === right?.modelId
}

function agentStatesEqual(left: AgentState, right: AgentState): boolean {
  return left.id === right.id
    && left.name === right.name
    && left.status === right.status
    && agentExecutionsEqual(left.execution, right.execution)
    && left.messages === right.messages
    && left.streamBuffer === right.streamBuffer
    && left.runtimeKind === right.runtimeKind
    && agentConversationsEqual(left.conversation, right.conversation)
    && left.cliSessionId === right.cliSessionId
    && left.cliStartRequested === right.cliStartRequested
    && left.cliRestartNonce === right.cliRestartNonce
    && left.cliHasLaunched === right.cliHasLaunched
    && left.cliOnboardingPromptSent === right.cliOnboardingPromptSent
    && left.cliResumeAvailable === right.cliResumeAvailable
    && left.cliLastExitCode === right.cliLastExitCode
    && left.cliLastExitedAt === right.cliLastExitedAt
    && left.cli === right.cli
    && left.cliModel === right.cliModel
    && left.cliRuntimeOverride?.cli === right.cliRuntimeOverride?.cli
    && left.cliRuntimeOverride?.model === right.cliRuntimeOverride?.model
    && left.cliPermissionPreset === right.cliPermissionPreset
    && left.cliStartupPrompt === right.cliStartupPrompt
    && left.kind === right.kind
    && left.specialistId === right.specialistId
    && left.multiloopRole === right.multiloopRole
}

function reuseAgentIfUnchanged(current: AgentState | undefined, next: AgentState): AgentState {
  return current && agentStatesEqual(current, next) ? current : next
}

function reuseAgentsMapIfUnchanged(
  currentAgents: Workspace['agents'],
  nextAgents: Workspace['agents']
): Workspace['agents'] {
  const currentIds = Object.keys(currentAgents)
  const nextIds = Object.keys(nextAgents)
  if (currentIds.length !== nextIds.length) return nextAgents
  for (let index = 0; index < nextIds.length; index += 1) {
    const id = nextIds[index]
    if (currentIds[index] !== id || currentAgents[id] !== nextAgents[id]) return nextAgents
  }
  return currentAgents
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
      // Per-role CLI + model resolve from the run's `roleRuntimes` config on
      // EVERY rebuild — seeded, minted, and recycled records alike (MC-1450:
      // the minted branch used to hardcode `claude-code` with no model, so
      // replenishment-minted agents launched on the CLI's default model). An
      // explicit per-agent `cliRuntimeOverride` outranks the role config; a
      // role absent from the map preserves the existing record's values.
      const resolved = resolveSprintEngineAgentRuntime(sprintEngineState.roleRuntimes, agent.role, current)
      const normalizedAgent = current
        ? normalizeAgentState({
          ...current,
          name: nextName,
          kind: 'sprintengine' as const,
          cli: resolved.cli ?? current.cli,
          cliModel: resolved.cliModel,
        }, 'claude-code')
        : {
          ...defaultAgent(agent.id, nextName, 'sprintengine'),
          cli: resolved.cli ?? ('claude-code' as const),
          ...(resolved.cliModel ? { cliModel: resolved.cliModel } : {}),
        }
      const nextAgent = reuseAgentIfUnchanged(current, normalizedAgent)
      nextAgents[agent.id] = nextAgent
      return [agent.id, nextAgent]
    })
  )

  const specialistAgents = Object.fromEntries(
    Object.entries(currentAgents).filter(([id, agent]) =>
      (agent.kind === 'specialist' || agent.kind === 'watchtower') && !rosterAgents[id]
    ).map(([id, agent]) => [id, reuseAgentIfUnchanged(agent, normalizeAgentState(agent))])
  )
  const transientSprintEngineAgents = Object.fromEntries(
    Object.entries(currentAgents).filter(([id, agent]) =>
      agent.kind === 'sprintengine'
      && !rosterAgents[id]
      && Boolean(agent.cliStartRequested || agent.cliHasLaunched || agent.cliSessionId)
    ).map(([id, agent]) => [id, reuseAgentIfUnchanged(agent, normalizeAgentState(agent, 'claude-code'))])
  )

  return reuseAgentsMapIfUnchanged(currentAgents, {
    ...specialistAgents,
    ...transientSprintEngineAgents,
    ...rosterAgents,
  })
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
  setSprintEngineAutomationMode: (
    workspaceId: WorkspaceId,
    mode: SprintEngineAutomationMode,
    options?: {
      suppressManualAudit?: boolean
      reason?: string
      details?: string
      // Set by the automation-mode sync subscriber when adopting an
      // authoritative main broadcast: applies the local transition without
      // pushing the value back to main (the no-echo rule).
      suppressMainSync?: boolean
    }
  ) => void
  applySprintEngineAutomationEvent: (
    workspaceId: WorkspaceId,
    event: SprintEngineAutomationEvent
  ) => void
  setSprintEngineCliPermissionPreset: (
    workspaceId: WorkspaceId,
    cliPermissionPreset: SprintEngineCliPermissionPreset
  ) => void
  setSprintEngineMaxConcurrentAgents: (workspaceId: WorkspaceId, maxConcurrentAgents: number) => void
  upsertSprintEngineRosterSession: (
    workspaceId: WorkspaceId,
    agentId: AgentId,
    session: SprintEngineRosterSession
  ) => void
  setSprintEngineCompletionTeardownAt: (workspaceId: WorkspaceId, at: number | undefined) => void
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
    role: SprintEngineRoleId
  ) => { id: AgentId; label: string } | null
  // Atomically takes the session-only creation launch intent so exactly one
  // consumer (the Sprint Engine board) starts the requested agents once.
  consumeSprintEngineInitialSpawns: (workspaceId: WorkspaceId, agentIds?: AgentId[]) => AgentId[]
}

export type RunStateSlice = RunStateSliceState & RunStateSliceActions

// `appSettings` is optional so unit fixtures can pass a minimal carrier; the
// real store mutator always provides it.
type RunStateSliceCarrier = { workspaces: Workspace[]; appSettings?: AppSettings }
type RunStateSliceSet = (mutator: (state: RunStateSliceCarrier) => void) => void

// Structural equality used to detect no-op Sprint Engine projection writes so
// `setSprintEngineState` can leave the Immer draft untouched and preserve the
// `workspaces` array (and per-workspace) reference identity. Every value
// compared here is a normalized, JSON-serializable projection structure, so a
// recursive key/element walk is sufficient and avoids JSON.stringify key-order
// fragility. Safe on Immer drafts (array drafts pass `Array.isArray`).
function isDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return false
  }
  const aArray = Array.isArray(a)
  const bArray = Array.isArray(b)
  if (aArray !== bArray) return false
  if (aArray && bArray) {
    const arrA = a as unknown[]
    const arrB = b as unknown[]
    if (arrA.length !== arrB.length) return false
    for (let i = 0; i < arrA.length; i += 1) {
      if (!isDeepEqual(arrA[i], arrB[i])) return false
    }
    return true
  }
  const objA = a as Record<string, unknown>
  const objB = b as Record<string, unknown>
  const keysA = Object.keys(objA)
  const keysB = Object.keys(objB)
  if (keysA.length !== keysB.length) return false
  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(objB, key)) return false
    if (!isDeepEqual(objA[key], objB[key])) return false
  }
  return true
}

function sprintEngineRunSettingsForWorkspace(
  state: RunStateSliceCarrier,
  workspace: Workspace,
): SprintEngineRunSettings | undefined {
  const key = sprintEngineRunSettingsKey(workspace.sprintEngineContext?.statePath)
  if (!key || !state.appSettings) return undefined
  return normalizeSprintEngineRunSettings(state.appSettings.sprintEngineRunSettings)[key]
}

function applySprintEngineRunSettings(
  autoState: SprintEngineAutoState,
  runSettings: SprintEngineRunSettings | undefined,
): SprintEngineAutoState {
  return runSettings ? normalizeSprintEngineAutoState({ ...autoState, ...runSettings }) : autoState
}

function rememberSprintEngineRunSettings(
  state: RunStateSliceCarrier,
  workspace: Workspace,
  patch: SprintEngineRunSettings,
): void {
  const key = sprintEngineRunSettingsKey(workspace.sprintEngineContext?.statePath)
  if (!key || !state.appSettings) return
  const current = normalizeSprintEngineRunSettings(state.appSettings.sprintEngineRunSettings)
  state.appSettings.sprintEngineRunSettings = {
    ...current,
    [key]: {
      ...(current[key] ?? {}),
      ...patch,
    },
  }
}

function sprintEngineAutomationEventReason(event: SprintEngineAutomationEvent): string | null {
  switch (event.type) {
    case 'runner_paused':
    case 'runner_failed':
    case 'runner_complete':
      return event.message ?? null
    case 'runner_blocked':
      return event.message
    default:
      return null
  }
}

function shouldAuditSprintEngineLifecycleState(
  runtimeState: SprintEngineAutoState['runtimeState']
): runtimeState is 'paused' | 'blocked' | 'failed' | 'complete' {
  return runtimeState === 'paused'
    || runtimeState === 'blocked'
    || runtimeState === 'failed'
    || runtimeState === 'complete'
}

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
        const nextMode = normalized ? 'sprintengine' : 'standard'
        const nextContext = normalizeSprintEngineWorkspaceContext(
          ws.sprintEngineContext,
          ws.folderPath,
          normalized
        )
        // `reconcileSprintEngineAgents` reuses the current map reference when the
        // roster is unchanged, but returns a fresh `{}` whenever `normalized` is
        // null. Funnel both through `reuseAgentsMapIfUnchanged` so an unchanged
        // (including already-empty) map keeps its identity and the referential
        // check below is exact and cheap — no deep walk over agent buffers.
        const nextAgents = reuseAgentsMapIfUnchanged(
          ws.agents,
          reconcileSprintEngineAgents(ws.agents, normalized)
        )
        const nextAutoState = normalized
          ? applySprintEngineRunSettings(
              normalizeSprintEngineAutoState(ws.sprintEngineAutoState),
              sprintEngineRunSettingsForWorkspace(state, ws)
            )
          : defaultSprintEngineAutoState()

        // Skip no-op projection writes. The Sprint Engine projection supervisor
        // polls every ~4s and re-applies a logically identical state on most
        // ticks; mutating the Immer draft there produces a fresh `workspaces`
        // array reference and fans a re-render out to every component subscribed
        // to the array. Assign each field only when it actually changed so the
        // draft (and therefore the array) stays untouched on no-op ticks, and so
        // per-field `useShallow` selectors also stay stable when only some
        // fields move.
        if (!isDeepEqual(ws.sprintEngineState, normalized)) ws.sprintEngineState = normalized
        if (ws.mode !== nextMode) ws.mode = nextMode
        if (!isDeepEqual(ws.sprintEngineContext, nextContext)) ws.sprintEngineContext = nextContext
        if (ws.agents !== nextAgents) ws.agents = nextAgents
        if (!isDeepEqual(ws.sprintEngineAutoState, nextAutoState)) ws.sprintEngineAutoState = nextAutoState
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

    // The local transition stays synchronous (optimistic UI); the authoritative
    // write — persistence, the manual-transition audit, the cliWatchPolling
    // bridge, and the cross-window/phone broadcast — happens in main (MC-1567).
    // The audit that used to be emitted here now has exactly one writer: main.
    setSprintEngineAutomationMode: (workspaceId, mode, options) => {
      const push: { current: { statePath: string; workspaceName?: string } | null } = { current: null }
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === workspaceId)
        if (!ws) return
        const current = normalizeSprintEngineAutoState(ws.sprintEngineAutoState)
        ws.sprintEngineAutoState = transitionSprintEngineAutomation(current, { type: 'user_set_mode', mode })
        const statePath = ws.sprintEngineContext?.statePath
        if (statePath && !options?.suppressMainSync) {
          push.current = { statePath, workspaceName: ws.name }
        }
      })
      if (push.current) {
        pushSprintEngineAutomationModeIntent({
          statePath: push.current.statePath,
          mode,
          workspaceId,
          ...(push.current.workspaceName ? { workspaceName: push.current.workspaceName } : {}),
          ...(options?.reason ? { reason: options.reason } : {}),
          ...(options?.details ? { details: options.details } : {}),
          ...(options?.suppressManualAudit ? { suppressManualAudit: true } : {}),
        })
      }
    },

    applySprintEngineAutomationEvent: (workspaceId, event) =>
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === workspaceId)
        if (!ws) return
        const current = normalizeSprintEngineAutoState(ws.sprintEngineAutoState)
        const previousMode = deriveSprintEngineAutomationMode(current)
        const previousRuntimeState = current.runtimeState
        const next = transitionSprintEngineAutomation(current, event)
        ws.sprintEngineAutoState = next
        if (previousMode === 'manual') return
        if (!shouldAuditSprintEngineLifecycleState(next.runtimeState)) return
        // `complete` is terminal in `transitionSprintEngineAutomation`: runner
        // events on an already-complete run are no-ops. Don't emit a diagnostic
        // for that — otherwise every agent terminal closed during end-of-run
        // teardown would log a misleading `complete → complete` "terminal was
        // closed" entry.
        if (previousRuntimeState === 'complete' && next.runtimeState === 'complete') return
        auditSprintEngineLifecycleTransition({
          level: next.runtimeState === 'failed' ? 'error' : 'info',
          workspaceId,
          workspaceName: ws.name,
          desiredMode: previousMode,
          previousRuntimeState,
          nextRuntimeState: next.runtimeState,
          reason: sprintEngineAutomationEventReason(event) ?? next.reasonMessage ?? 'Sprint automation state changed.',
          ...(next.reasonTaskId ? { taskId: next.reasonTaskId } : {}),
          ...(next.reasonAgentId ? { agentId: next.reasonAgentId } : {}),
        })
      }),

    setSprintEngineCliPermissionPreset: (workspaceId, cliPermissionPreset) =>
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === workspaceId)
        if (!ws) return
        const nextPreset = normalizeCliPermissionPreset(cliPermissionPreset)
        const current = normalizeSprintEngineAutoState(ws.sprintEngineAutoState)
        ws.sprintEngineAutoState = {
          ...current,
          cliPermissionPreset: nextPreset,
          changedAt: Date.now(),
        }
        rememberSprintEngineRunSettings(state, ws, { cliPermissionPreset: nextPreset })
      }),

    setSprintEngineMaxConcurrentAgents: (workspaceId, maxConcurrentAgents) =>
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === workspaceId)
        if (!ws) return
        const nextMaxConcurrentAgents = Math.max(1, Math.min(10, Math.floor(maxConcurrentAgents)))
        const current = normalizeSprintEngineAutoState(ws.sprintEngineAutoState)
        ws.sprintEngineAutoState = {
          ...current,
          maxConcurrentAgents: nextMaxConcurrentAgents,
          changedAt: Date.now(),
        }
        rememberSprintEngineRunSettings(state, ws, { maxConcurrentAgents: nextMaxConcurrentAgents })
      }),

    upsertSprintEngineRosterSession: (workspaceId, agentId, session) =>
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === workspaceId)
        if (!ws) return
        if (!session.cliSessionId?.trim() || !session.cli?.trim()) return
        if (!ws.sprintEngineRosterSessions) ws.sprintEngineRosterSessions = {}
        ws.sprintEngineRosterSessions[agentId] = session
      }),

    setSprintEngineCompletionTeardownAt: (workspaceId, at) =>
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === workspaceId)
        if (!ws) return
        const current = normalizeSprintEngineAutoState(ws.sprintEngineAutoState)
        if (current.completionTeardownAt === at) return
        ws.sprintEngineAutoState = { ...current, completionTeardownAt: at }
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

        // Mint the display id against the canonical workers view when present
        // (MC-1593a) so it never collides with a live worker; the bridge is the
        // pre-projection fallback. Seed a local record so the agent's tab and
        // row resolve their role from the worker record before it first claims.
        const agentId = getNextSprintEngineAgentId(
          role,
          ws.sprintEngineState.workers ?? ws.sprintEngineState.sprintEngineAgents,
        )
        ws.sprintEngineState.sprintEngineAgents[agentId] = {
          role,
          status: 'idle',
          currentTaskId: null,
        }
        // No roleCounts bump (MC-1450): counts are an enabled-set encoding,
        // not a headcount — mark the role enabled and let the runtime roster
        // carry the actual membership.
        ws.sprintEngineState.roleCounts[role] = 1

        const rosterAgent = buildSprintEngineAgentRosterForState(ws.sprintEngineState).find(
          (agent) => agent.id === agentId
        )
        const agentRoleLabel = rosterAgent?.label ?? agentId
        const agentLabel = pickWorkspaceAgentName(ws.agents)
        const roleCliDefaults = normalizeSprintEngineRoleCliDefaults(ws.sprintEngineRoleCliDefaults)
        // Role config from run.yaml (via the projection) wins for both CLI and
        // model; the workspace-level CLI defaults are the pre-projection
        // fallback. No model in either place ⇒ no `--model` flag. A brand-new
        // member has no per-agent override yet.
        const runtime = resolveSprintEngineAgentRuntime(ws.sprintEngineState.roleRuntimes, role, undefined)
        const memberCli = runtime.cli ?? resolveSprintEngineRoleCli(roleCliDefaults, role)
        ws.agents[agentId] = {
          ...defaultAgent(agentId, agentLabel, 'sprintengine'),
          cli: memberCli,
          ...(runtime.cliModel ? { cliModel: runtime.cliModel } : {}),
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

    consumeSprintEngineInitialSpawns: (workspaceId, agentIds) => {
      let consumed: AgentId[] = []
      set((state) => {
        const ws = state.workspaces.find((w) => w.id === workspaceId)
        if (!ws?.sprintEngineInitialSpawnAgentIds?.length) return
        if (!agentIds) {
          consumed = [...ws.sprintEngineInitialSpawnAgentIds]
          ws.sprintEngineInitialSpawnAgentIds = undefined
          return
        }
        const requested = new Set(agentIds)
        consumed = ws.sprintEngineInitialSpawnAgentIds.filter((agentId) => requested.has(agentId))
        if (consumed.length === 0) return
        const remaining = ws.sprintEngineInitialSpawnAgentIds.filter((agentId) => !requested.has(agentId))
        ws.sprintEngineInitialSpawnAgentIds = remaining.length > 0 ? remaining : undefined
      })
      return consumed
    },
  }
}
