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
import { registerAutomationsIpc } from '../ipc/automations-ipc'
import {
  AutomationDelegateToken,
  AutomationsEngineToken,
  AutomationsProviderRegistryToken,
  SprintEngineAutomationFrontDoorsToken,
  SwitchboardAutomationFrontDoorsToken,
  WorkspaceSyncServiceToken,
} from '../module-host/service-tokens'
import type { CapabilityModule } from '../module-host/load-modules'
import {
  AUTOMATIONS_RUN_EVENT_CHANNEL,
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
    send(channel: string, payload: AutomationsRunEvent): void
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
      const engine = host.provideService(AutomationsEngineToken, () =>
        (options.createEngine ?? createAutomationsEngine)({
          getWorkspaceSnapshot: () => workspaceSyncService.getSnapshot(),
          getTriggerProviders,
          isIntegrationAvailable,
          runAutomation,
          onRunEvent: options.deliverRunEvent ?? broadcastAutomationsRunEvent,
          openRunPullRequest: (input) =>
            openAutomationRunPullRequest({
              worktreePath: input.worktreePath,
              branch: input.branch,
              title: input.title,
              body: input.body,
            }),
          removeRunWorktree: defaultRemoveRunWorktree,
        })
      )
      const webhookReceiver = createAutomationWebhookReceiver({
        getProjectFolders: () => projectFoldersFromWorkspaceSyncSnapshot(workspaceSyncService.getSnapshot()),
        deliverTriggerEvent: (input) => engine.deliverTriggerEvent(input),
      })

      host.registerSidecar(
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
        onDefinitionsChanged: async () => {
          await webhookReceiver.refresh()
        },
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
