import { BrowserWindow } from 'electron'

import { createLocalAutomationExecutor, defaultWorkspaceDirtyCheck } from '../automations/executor-local'
import { createAutomationsEngine, type AutomationsEngine, type AutomationsEngineOptions } from '../automations/engine'
import { createBuiltInAutomationProviderRegistry } from '../automations/provider-registry'
import { registerAutomationsIpc } from '../ipc/automations-ipc'
import {
  AutomationDelegateToken,
  AutomationsEngineToken,
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

export type AutomationsModuleOptions = {
  createEngine?: (options: AutomationsEngineOptions) => AutomationsEngine
  deliverRunEvent?: (event: AutomationsRunEvent) => void
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
      const triggerProviders = providerRegistry.listTriggerProviders()
      const actionProviders = providerRegistry.listActionProviders()
      const runAutomation = createLocalAutomationExecutor({
        delegateToRenderer: (request) => automationDelegate.request(request),
        getWorkspaceSyncSnapshot: () => workspaceSyncService.getSnapshot(),
        isIntegrationAvailable,
        isWorkspaceDirty: defaultWorkspaceDirtyCheck,
        actionProviders,
      })
      const engine = host.provideService(AutomationsEngineToken, () =>
        (options.createEngine ?? createAutomationsEngine)({
          getWorkspaceSnapshot: () => workspaceSyncService.getSnapshot(),
          triggerProviders,
          isIntegrationAvailable,
          runAutomation,
          onRunEvent: options.deliverRunEvent ?? broadcastAutomationsRunEvent,
        })
      )

      host.registerSidecar(
        {
          id: 'automations-engine',
          kind: 'scheduler',
          description: 'App-active Automations scheduler; starts only while the Automations module is enabled.',
          startOn: 'startup',
        },
        {
          start: async () => {
            engine.start()
          },
          stop: async () => {
            engine.stop()
          },
          status: () => ({ state: engine.isRunning() ? 'running' : 'stopped' }),
        }
      )

      registerAutomationsIpc(host, {
        engine,
        triggerProviders,
        actionProviders,
        isIntegrationAvailable,
        getWorkspaceSyncSnapshot: () => workspaceSyncService.getSnapshot(),
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
