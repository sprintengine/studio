import {
  buildSprintEngineAgentRosterForState,
  getNextSprintEngineAgentId,
  normalizeSprintEngineState,
} from '../../utils/sprintengine'
import { deriveSprintEngineAutomationMode } from '../../utils/sprintengineAutomation'
// Relocated to shared with MC-2160 so a main-composed sprint run carries the
// identical automation block; re-exported below for existing import sites.
import { normalizeSprintEngineAutoState } from '../../../../shared/sprintengine/automation-lifecycle'
import { transitionSprintEngineAutomation } from '../../utils/sprintengineAutomationLifecycle'
import { auditSprintEngineLifecycleTransition } from '../../utils/sprintengineAutomationAudit'
import {
  pushSprintEngineAutomationModeIntent,
  pushSprintEngineCliPermissionPresetIntent,
} from '../../utils/sprintengineAutomationIntentClient'
import {
  getSprintEngineDirectoryPath,
  getSprintEngineStateFilePath,
  slugifySprintEngineName,
} from '../../utils/sprintengineStateFile'
import {
  defaultAgent,
  normalizeAgentState,
  pickWorkspaceAgentName,
} from './agentsSlice'
import { sprintEngineTabsLayoutModel } from './layoutSlice'
import { patchSprintEngineModuleState } from './workspaceModuleState'
import {
  normalizeCliPermissionPreset,
  normalizeSprintEngineRunSettings,
  sprintEngineRunSettingsKey,
} from './settingsSlice'
import type {
  AgentState,
  AgentId,
  AppSettings,
  SprintEngineAutoState,
  SprintEngineAutomationEvent,
  SprintEngineAutomationMode,
  SprintEngineCliPermissionPreset,
  SprintEngineRoleId,
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
  cliPermissionPreset: 'manual',
  maxConcurrentAgents: 3,
  deliveredAgentNotificationEventKeys: [],
  completionTeardownAt: undefined,
})

// The role -> CLI map moved to shared with MC-2160 (main composes sprint
// workspaces headlessly and normalizes the same map); re-exported so every
// existing renderer import site is unchanged.
import { normalizeSprintEngineRoleCliDefaults } from '../../../../shared/sprintengine/role-cli-defaults'
// One role -> CLI resolver for the whole app (MC-2160): creation and
// roster-member addition used to hold near-identical copies that differed on
// how a roleless seat keys.
import { resolveSprintEngineRoleCli } from '../../../../shared/sprintengine/workspace-record'

export { normalizeSprintEngineRoleCliDefaults }


// `resolveSprintEngineRoleRuntime` / `resolveSprintEngineAgentRuntime` moved
// to the shared Sprint Engine state module (sprint-runtime-ownership Phase 2:
// the main-process auto-run planner resolves runtimes too); these re-exports
// keep every existing import site working unchanged.
import { resolveSprintEngineAgentRuntime } from '../../../../shared/sprintengine/state'
export { normalizeSprintEngineAutoState }

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
    && left.cliReasoning === right.cliReasoning
    && left.cliRuntimeOverride?.cli === right.cliRuntimeOverride?.cli
    && left.cliRuntimeOverride?.model === right.cliRuntimeOverride?.model
    && left.cliRuntimeOverride?.reasoning === right.cliRuntimeOverride?.reasoning
    && left.cliPermissionPreset === right.cliPermissionPreset
    && left.cliStartupPrompt === right.cliStartupPrompt
    && left.kind === right.kind
    && left.specialistId === right.specialistId
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
      // Per-role CLI + model + reasoning effort resolve from the run's
      // `roleRuntimes` config on EVERY rebuild — seeded, minted, and recycled
      // records alike (MC-1450: the minted branch used to hardcode `claude-code`
      // with no model, so replenishment-minted agents launched on the CLI's
      // default model). An explicit per-agent `cliRuntimeOverride` outranks the
      // role config; a role absent from the map preserves the record's values.
      const resolved = resolveSprintEngineAgentRuntime(sprintEngineState.roleRuntimes, agent.role, current)
      const normalizedAgent = current
        ? normalizeAgentState({
          ...current,
          name: nextName,
          kind: 'sprintengine' as const,
          cli: resolved.cli ?? current.cli,
          cliModel: resolved.cliModel,
          cliReasoning: resolved.cliReasoning,
        }, 'claude-code')
        : {
          ...defaultAgent(agent.id, nextName, 'sprintengine'),
          cli: resolved.cli ?? ('claude-code' as const),
          ...(resolved.cliModel ? { cliModel: resolved.cliModel } : {}),
          ...(resolved.cliReasoning ? { cliReasoning: resolved.cliReasoning } : {}),
        }
      const nextAgent = reuseAgentIfUnchanged(current, normalizedAgent)
      nextAgents[agent.id] = nextAgent
      return [agent.id, nextAgent]
    })
  )

  const specialistAgents = Object.fromEntries(
    Object.entries(currentAgents).filter(([id, agent]) =>
      agent.kind === 'specialist' && !rosterAgents[id]
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
  // The freshly normalized state is canonical here; write it to the bag AND
  // the mirror so the MC-1573 lockstep invariant survives this migration.
  return patchSprintEngineModuleState(
    {
      ...ws,
      sprintEngineState,
      agents,
      layoutModel: sprintEngineTabsLayoutModel(sprintEngineState, agents),
    },
    { state: sprintEngineState },
  )
}

interface RunStateSliceState {}

interface RunStateSliceActions {
  setSprintEngineContext: (id: WorkspaceId, sprintEngineContext: SprintEngineWorkspaceContext | null) => void
  setSprintEngineState: (workspaceId: WorkspaceId, sprintEngineState: SprintEngineState | null) => void
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
        if (!ws) return
        ws.sprintEngineContext = sprintEngineContext
        const next = patchSprintEngineModuleState(ws, { context: sprintEngineContext })
        if (!isDeepEqual(ws.moduleState, next.moduleState)) {
          if (next.moduleState) ws.moduleState = next.moduleState
          else delete ws.moduleState
        }
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
        const patched = patchSprintEngineModuleState(ws, {
          state: normalized,
          context: nextContext,
        })
        if (!isDeepEqual(ws.moduleState, patched.moduleState)) {
          if (patched.moduleState) ws.moduleState = patched.moduleState
          else delete ws.moduleState
        }
        if (ws.mode !== nextMode) ws.mode = nextMode
        if (!isDeepEqual(ws.sprintEngineContext, nextContext)) ws.sprintEngineContext = nextContext
        if (ws.agents !== nextAgents) ws.agents = nextAgents
        if (!isDeepEqual(ws.sprintEngineAutoState, nextAutoState)) ws.sprintEngineAutoState = nextAutoState
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

    // Workspace-keyed entry point for a resident mount: the local transition is
    // optimistic, and the authoritative write goes to the run's statePath-keyed
    // intent record (MC-1799) so a run's preset reads the same whether the board
    // is mounted on the workspace or on the Sprints door. A door mount has no
    // workspace record to reach this action and writes that record directly.
    setSprintEngineCliPermissionPreset: (workspaceId, cliPermissionPreset) => {
      const push: {
        current: { statePath: string; preset: SprintEngineCliPermissionPreset; workspaceName?: string } | null
      } = { current: null }
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
        const statePath = ws.sprintEngineContext?.statePath
        if (statePath) push.current = { statePath, preset: nextPreset, workspaceName: ws.name }
      })
      if (push.current) {
        void pushSprintEngineCliPermissionPresetIntent({
          statePath: push.current.statePath,
          preset: push.current.preset,
          workspaceId,
          ...(push.current.workspaceName ? { workspaceName: push.current.workspaceName } : {}),
        })
      }
    },

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
        // Role config from run.yaml (via the projection) wins for CLI, model and
        // reasoning effort; the workspace-level CLI defaults are the
        // pre-projection fallback. No model in either place ⇒ no `--model` flag,
        // and no level ⇒ no effort flag. A brand-new member has no per-agent
        // override yet.
        const runtime = resolveSprintEngineAgentRuntime(ws.sprintEngineState.roleRuntimes, role, undefined)
        const memberCli = runtime.cli ?? resolveSprintEngineRoleCli(roleCliDefaults, role)
        ws.agents[agentId] = {
          ...defaultAgent(agentId, agentLabel, 'sprintengine'),
          cli: memberCli,
          ...(runtime.cliModel ? { cliModel: runtime.cliModel } : {}),
          ...(runtime.cliReasoning ? { cliReasoning: runtime.cliReasoning } : {}),
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
