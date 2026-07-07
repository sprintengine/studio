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
  AutomationDelegateToken,
  AutomationsEngineToken,
  AutomationsModuleServiceToken,
  AutomationsProviderRegistryToken,
  SprintEngineAutomationFrontDoorsToken,
  SwitchboardAutomationFrontDoorsToken,
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
  SWITCHBOARD_AUTOMATION_INTEGRATION_ID,
  WATCHTOWER_AUTOMATION_INTEGRATION_ID,
  type SwitchboardAutomationFrontDoors,
} from '../automations/actions/switchboard'
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
      const automationDelegate = host.requireService(AutomationDelegateToken)
      const workspaceSyncService = host.requireService(WorkspaceSyncServiceToken)
      const terminalRuntime = host.requireService(TerminalRuntimeToken)
      const switchboardFrontDoors = serviceBackedSwitchboardFrontDoors(() =>
        host.getService(SwitchboardAutomationFrontDoorsToken)
      )
      const sprintEngineFrontDoors = serviceBackedSprintEngineFrontDoors(() =>
        host.getService(SprintEngineAutomationFrontDoorsToken)
      )
      const isIntegrationAvailable = createFirstPartyAutomationIntegrationResolver({
        hasSwitchboard: () => Boolean(host.getService(SwitchboardAutomationFrontDoorsToken)),
        hasSprintEngine: () => Boolean(host.getService(SprintEngineAutomationFrontDoorsToken)),
      })
      const providerRegistry = createBuiltInAutomationProviderRegistry({
        switchboard: switchboardFrontDoors,
        sprintEngine: sprintEngineFrontDoors,
      })
      const checkProviderPermission = options.checkProviderPermission ?? allowAutomationProvider
      host.provideService(AutomationsProviderRegistryToken, () => providerRegistry)
      const getTriggerProviderRegistrations = () => providerRegistry.listTriggerProviderRegistrations()
      const getActionProviderRegistrations = () => providerRegistry.listActionProviderRegistrations()
      const getTriggerProviders = () =>
        executableTriggerProviders(getTriggerProviderRegistrations(), checkProviderPermission)
      const runAutomation = createLocalAutomationExecutor({
        delegateToRenderer: (request) => automationDelegate.request(request),
        getWorkspaceSyncSnapshot: () => workspaceSyncService.getSnapshot(),
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
              autonomy: input.autonomy,
            }),
          removeRunWorktree: defaultRemoveRunWorktree,
          disposeRunAgent: (input) =>
            automationDelegate
              .request({ kind: 'agent.dispose', workspaceId: input.workspaceId, agentId: input.agentId })
              .then(() => undefined),
          getLiveAgentExecutionIds: () =>
            terminalRuntime.getLiveAgentExecutionIds().map((execution) => execution.executionId),
        })
      )

      // Agent-lifecycle finalize trigger: route every real agent-session pty exit
      // to the engine, which finalizes only the pending automation run (if any)
      // whose executionId matches and ignores all other exits. The signal-file
      // poll-scan remains the backstop for runs whose executionId never resolved.
      // Unregister on module teardown so a live disable→enable cycle never leaks
      // a listener pointed at a stopped engine.
      const unregisterAgentExitListener = terminalRuntime.registerAgentSessionExitListener((event) =>
        engine.finalizeRunOnAgentExit({ executionId: event.executionId, exitCode: event.exitCode })
      )
      host.onShutdown(() => unregisterAgentExitListener())
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

      registerAutomationsIpc(host, {
        engine,
        getTriggerProviderRegistrations,
        getActionProviderRegistrations,
        checkProviderPermission,
        isIntegrationAvailable,
        getWorkspaceSyncSnapshot: () => workspaceSyncService.getSnapshot(),
        getEngineSidecarStatus: () => engineSidecar.status(),
        onDefinitionsChanged,
      })
    },
  }
}

export const automationsModule = createAutomationsModule()

function createFirstPartyAutomationIntegrationResolver(input: {
  hasSwitchboard(): boolean
  hasSprintEngine(): boolean
}): (id: string) => boolean | undefined {
  return (id) => {
    if (id === SWITCHBOARD_AUTOMATION_INTEGRATION_ID) return input.hasSwitchboard()
    if (id === WATCHTOWER_AUTOMATION_INTEGRATION_ID) return input.hasSwitchboard()
    if (id === SPRINT_ENGINE_AUTOMATION_INTEGRATION_ID) return input.hasSprintEngine()
    return undefined
  }
}

function serviceBackedSwitchboardFrontDoors(
  resolve: () => SwitchboardAutomationFrontDoors | undefined
): SwitchboardAutomationFrontDoors {
  return {
    readAllTasks: async (input) =>
      resolve()?.readAllTasks(input) ?? { ok: false, message: 'Switchboard is unavailable.' },
    tickRunner: async (input) =>
      resolve()?.tickRunner(input) ?? { ok: false, message: 'Switchboard is unavailable.' },
    startWatchtowerReview: async (input) =>
      resolve()?.startWatchtowerReview(input) ?? { ok: false, message: 'Watchtower is unavailable.' },
  }
}

function serviceBackedSprintEngineFrontDoors(
  resolve: () => SprintEngineAutomationFrontDoors | undefined
): SprintEngineAutomationFrontDoors {
  return {
    setRunnerMode: async (input) =>
      resolve()?.setRunnerMode(input) ?? { ok: false, message: 'Sprint Engine is unavailable.' },
    replenishRoster: async (input) =>
      resolve()?.replenishRoster(input) ?? { ok: false, message: 'Sprint Engine is unavailable.' },
  }
}
