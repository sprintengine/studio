import { BrowserWindow } from 'electron'

import { createLocalAutomationExecutor, defaultRemoveRunWorktree } from '../automations/executor-local'
import { openAutomationRunPullRequest } from '../automations/pull-request'
import {
  createAutomationsEngine,
  projectFoldersFromWorkspaceSyncSnapshot,
  type AutomationsEngine,
  type AutomationsEngineOptions,
} from '../automations/engine'
import {
  allowAutomationProvider,
  createBuiltInAutomationProviderRegistry,
  executableTriggerProviders,
  type AutomationProviderPermissionChecker,
} from '../automations/provider-registry'
import { createModuleAutomationsRegistry } from '../automations/module-service'
import { AutomationsStore } from '../automations/store'
import { registerAutomationsIpc } from '../ipc/automations-ipc'
import {
  SprintCreateServiceToken,
  AutomationsAppFrontDoorToken,
  AutomationsEngineToken,
  AutomationsModuleServiceToken,
  AutomationsProviderRegistryToken,
  SprintEngineAutomationFrontDoorsToken,
  RepoTaskSourceFrontDoorsToken,
  AgentLaunchServiceToken,
  TerminalRuntimeToken,
  WorkspaceSyncServiceToken,
} from '../module-host/service-tokens'
import type { CapabilityModule } from '../module-host/load-modules'
import {
  AUTOMATIONS_DEFINITIONS_CHANGED_CHANNEL,
  AUTOMATIONS_RUN_EVENT_CHANNEL,
  type AutomationsDefinitionsChangedEvent,
  type AutomationsRunEvent,
} from '../../shared/automations/contracts'
import {
  SPRINT_ENGINE_AUTOMATION_INTEGRATION_ID,
  type SprintEngineAutomationFrontDoors,
} from '../automations/actions/sprint-engine'
import {
  REPO_TASK_SOURCE_INTEGRATION_ID,
  type RepoTaskSourceFrontDoors,
} from '../automations/repo-task-source'
import { createAutomationWebhookReceiver } from '../automations/webhook-receiver'

export type AutomationsModuleOptions = {
  createEngine?: (options: AutomationsEngineOptions) => AutomationsEngine
  deliverRunEvent?: (event: AutomationsRunEvent) => void
  checkProviderPermission?: AutomationProviderPermissionChecker
}

type RunEventWindow = {
  isDestroyed(): boolean
  webContents: {
    isDestroyed(): boolean
    send(channel: string, payload: AutomationsRunEvent | AutomationsDefinitionsChangedEvent): void
  }
}

export function broadcastAutomationsRunEvent(
  event: AutomationsRunEvent,
  windows: readonly RunEventWindow[] = BrowserWindow.getAllWindows()
): void {
  for (const window of windows) {
    if (window.isDestroyed() || window.webContents.isDestroyed()) continue
    try {
      window.webContents.send(AUTOMATIONS_RUN_EVENT_CHANNEL, event)
    } catch {
      // Keep run-event delivery best-effort per renderer window.
    }
  }
}

export function broadcastAutomationsDefinitionsChanged(
  event: AutomationsDefinitionsChangedEvent,
  windows: readonly RunEventWindow[] = BrowserWindow.getAllWindows()
): void {
  for (const window of windows) {
    if (window.isDestroyed() || window.webContents.isDestroyed()) continue
    try {
      window.webContents.send(AUTOMATIONS_DEFINITIONS_CHANGED_CHANNEL, event)
    } catch {
      // Keep delivery best-effort per renderer window.
    }
  }
}

export function createAutomationsModule(options: AutomationsModuleOptions = {}): CapabilityModule {
  return {
    manifest: {
      id: 'automations',
      displayName: 'Automations',
      version: 1,
      publisher: 'multicode',
      category: 'orchestration',
      summary: 'Local-first scheduled agent automations with run history and module-gated execution.',
      defaultEnabled: true,
      dependsOn: ['agent-runtime'],
    },
    registerMain(host) {
      const sprintCreateService = host.requireService(SprintCreateServiceToken)
      const agentLaunchService = host.requireService(AgentLaunchServiceToken)
      const workspaceSyncService = host.requireService(WorkspaceSyncServiceToken)
      const terminalRuntime = host.requireService(TerminalRuntimeToken)
      const repoTaskFrontDoors = serviceBackedRepoTaskFrontDoors(() =>
        host.getService(RepoTaskSourceFrontDoorsToken)
      )
      const sprintEngineFrontDoors = serviceBackedSprintEngineFrontDoors(() =>
        host.getService(SprintEngineAutomationFrontDoorsToken)
      )
      const isIntegrationAvailable = createFirstPartyAutomationIntegrationResolver({
        hasRepoTaskSource: () => Boolean(host.getService(RepoTaskSourceFrontDoorsToken)),
        hasSprintEngine: () => Boolean(host.getService(SprintEngineAutomationFrontDoorsToken)),
      })
      const providerRegistry = createBuiltInAutomationProviderRegistry({
        repoTasks: repoTaskFrontDoors,
        sprintEngine: sprintEngineFrontDoors,
        createSprint: (request) => sprintCreateService.createSprint(request),
      })
      const checkProviderPermission = options.checkProviderPermission ?? allowAutomationProvider
      host.provideService(AutomationsProviderRegistryToken, () => providerRegistry)
      const getTriggerProviderRegistrations = () => providerRegistry.listTriggerProviderRegistrations()
      const getActionProviderRegistrations = () => providerRegistry.listActionProviderRegistrations()
      const getTriggerProviders = () =>
        executableTriggerProviders(getTriggerProviderRegistrations(), checkProviderPermission)
      const runAutomation = createLocalAutomationExecutor({
        launchAgent: (request) => agentLaunchService.launch(request),
        createWorkspace: (input, actor) => workspaceSyncService.createWorkspace(input, actor),
        getWorkspaceSyncSnapshot: () => workspaceSyncService.getSnapshot(),
        resolveAgentExecutionId: (input) => terminalRuntime.resolveAgentExecutionId(input),
        isIntegrationAvailable,
        getActionProviderRegistrations,
        checkProviderPermission,
      })
      // Late-bound: the registry needs the webhook receiver's refresh (created
      // below, after the engine), while the engine's run-event callback needs
      // the registry. The renderer broadcast is unchanged; module subscribers
      // are notified alongside it, filtered by automation ownership.
      let moduleAutomations: ReturnType<typeof createModuleAutomationsRegistry> | undefined
      const deliverRunEvent = options.deliverRunEvent ?? broadcastAutomationsRunEvent

      const engine = host.provideService(AutomationsEngineToken, () =>
        (options.createEngine ?? createAutomationsEngine)({
          getWorkspaceSnapshot: () => workspaceSyncService.getSnapshot(),
          getTriggerProviders,
          isIntegrationAvailable,
          runAutomation,
          onRunEvent: (event, definition) => {
            deliverRunEvent(event)
            moduleAutomations?.deliverRunEvent(event, definition)
          },
          openRunPullRequest: (input) =>
            openAutomationRunPullRequest({
              worktreePath: input.worktreePath,
              branch: input.branch,
              title: input.title,
              body: input.body,
            }),
          removeRunWorktree: defaultRemoveRunWorktree,
          // Killing the run's agent is main's own work now (MC-2159): the
          // terminal is main's, and the renderer's part — dropping the tab and
          // the record — follows from the session disappearing, because the tab
          // is a projection of the live session list. Run finalize therefore
          // completes with no window open, which is where a one-shot agent left
          // pointing at a torn-down run worktree used to come from.
          disposeRunAgent: (input) => {
            agentLaunchService.dispose({ workspaceId: input.workspaceId, agentId: input.agentId })
            return Promise.resolve()
          },
          getLiveAgentExecutionIds: () =>
            terminalRuntime.getLiveAgentExecutionIds().map((execution) => execution.executionId),
        })
      )

      // Agent-lifecycle finalize triggers. The engine owns the match-vs-ignore
      // decision for both; the module only routes.
      //
      // Phase transitions are the primary channel: an agent-backed run finalizes
      // when its agent ends its turn (settle window, guards, and correlation all
      // live in the engine). The pty exit is the secondary channel: an agent that
      // dies without a turn end failed. Both unregister on module teardown so a
      // live disable→enable cycle never leaks a listener pointed at a stopped
      // engine.
      const unregisterAgentPhaseListener = terminalRuntime.registerAgentPhaseListener((event) =>
        engine.noteAgentPhase(event)
      )
      const unregisterAgentExitListener = terminalRuntime.registerAgentSessionExitListener((event) =>
        engine.finalizeRunOnAgentExit({
          executionId: event.executionId,
          workspaceId: event.workspaceId,
          agentId: event.agentId,
          exitCode: event.exitCode,
        })
      )
      host.onShutdown(() => {
        unregisterAgentPhaseListener()
        unregisterAgentExitListener()
      })
      const webhookReceiver = createAutomationWebhookReceiver({
        getProjectFolders: () => projectFoldersFromWorkspaceSyncSnapshot(workspaceSyncService.getSnapshot()),
        deliverTriggerEvent: (input) => engine.deliverTriggerEvent(input),
      })

      // The module-scoped Automations service (SDK getAutomationsService).
      // Shares the write-path deps with registerAutomationsIpc below so both
      // front doors run the same definition-write core.
      // Runs after every definition write from either front door: refresh the
      // webhook receiver, then tell every window so an open Automations panel
      // reflects module-driven (and other-window) writes without a remount.
      const onDefinitionsChanged = async (workspaceRoot: string): Promise<void> => {
        try {
          await webhookReceiver.refresh()
        } finally {
          broadcastAutomationsDefinitionsChanged({ workspaceRoot })
        }
      }
      moduleAutomations = host.provideService(AutomationsModuleServiceToken, () =>
        createModuleAutomationsRegistry({
          createStore: (workspaceRoot) => new AutomationsStore(workspaceRoot),
          getTriggerProviderRegistrations,
          getActionProviderRegistrations,
          checkProviderPermission,
          now: Date.now,
          onDefinitionsChanged,
          getWorkspaceSyncSnapshot: () => workspaceSyncService.getSnapshot(),
        })
      )
      const moduleAutomationsRegistry = moduleAutomations
      host.onShutdown(() => moduleAutomationsRegistry.dispose())

      const engineSidecar = host.registerSidecar(
        {
          id: 'automations-engine',
          kind: 'scheduler',
          description: 'App-active Automations scheduler; starts only while the Automations module is enabled.',
          startOn: 'startup',
        },
        {
          start: async () => {
            await webhookReceiver.refresh()
            engine.start()
          },
          stop: async () => {
            await webhookReceiver.stop()
            engine.stop()
          },
          status: () => {
            const receiverStatus = webhookReceiver.status()
            return {
              state: receiverStatus.error ? 'failed' : engine.isRunning() ? 'running' : 'stopped',
              ...(receiverStatus.error ? { error: `Webhook receiver: ${receiverStatus.error}` } : {}),
            }
          },
        }
      )

      const appFrontDoor = registerAutomationsIpc(host, {
        engine,
        getTriggerProviderRegistrations,
        getActionProviderRegistrations,
        checkProviderPermission,
        isIntegrationAvailable,
        getWorkspaceSyncSnapshot: () => workspaceSyncService.getSnapshot(),
        getEngineSidecarStatus: () => engineSidecar.status(),
        onDefinitionsChanged,
      })
      // The automation server's automation.create/automation.run resolve this
      // lazily; module disabled ⇒ token absent ⇒ explicit tool failure.
      host.provideService(AutomationsAppFrontDoorToken, () => appFrontDoor)
    },
  }
}

export const automationsModule = createAutomationsModule()

function createFirstPartyAutomationIntegrationResolver(input: {
  hasRepoTaskSource(): boolean
  hasSprintEngine(): boolean
}): (id: string) => boolean | undefined {
  return (id) => {
    if (id === REPO_TASK_SOURCE_INTEGRATION_ID) return input.hasRepoTaskSource()
    if (id === SPRINT_ENGINE_AUTOMATION_INTEGRATION_ID) return input.hasSprintEngine()
    return undefined
  }
}

function serviceBackedRepoTaskFrontDoors(
  resolve: () => RepoTaskSourceFrontDoors | undefined
): RepoTaskSourceFrontDoors {
  return {
    readAllTasks: async (input) =>
      resolve()?.readAllTasks(input) ?? { ok: false, message: 'No repo task source is available.' },
  }
}

function serviceBackedSprintEngineFrontDoors(
  resolve: () => SprintEngineAutomationFrontDoors | undefined
): SprintEngineAutomationFrontDoors {
  return {
    setRunnerMode: async (input) =>
      resolve()?.setRunnerMode(input) ?? { ok: false, message: 'Sprint Engine is unavailable.' },
    readProjection: async (input) =>
      resolve()?.readProjection(input) ?? { ok: false, message: 'Sprint Engine is unavailable.' },
    refreshPullRequestStatus: async (input) =>
      resolve()?.refreshPullRequestStatus(input) ?? { ok: false, message: 'Sprint Engine is unavailable.' },
    mergePullRequest: async (input) =>
      resolve()?.mergePullRequest(input) ?? { ok: false, message: 'Sprint Engine is unavailable.' },
  }
}
