import { createBuiltInAutomationActionProviders, createLocalAutomationExecutor } from '../automations/executor-local'
import { createAutomationsEngine, type AutomationsEngine, type AutomationsEngineOptions } from '../automations/engine'
import { scheduleTriggerProvider } from '../automations/schedule'
import { registerAutomationsIpc } from '../ipc/automations-ipc'
import {
  AutomationDelegateToken,
  AutomationsEngineToken,
  WorkspaceSyncServiceToken,
} from '../module-host/service-tokens'
import type { CapabilityModule } from '../module-host/load-modules'

export type AutomationsModuleOptions = {
  createEngine?: (options: AutomationsEngineOptions) => AutomationsEngine
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
      const actionProviders = createBuiltInAutomationActionProviders()
      const runAutomation = createLocalAutomationExecutor({
        delegateToRenderer: (request) => automationDelegate.request(request),
        getWorkspaceSyncSnapshot: () => workspaceSyncService.getSnapshot(),
      })
      const engine = host.provideService(AutomationsEngineToken, () =>
        (options.createEngine ?? createAutomationsEngine)({
          getWorkspaceSnapshot: () => workspaceSyncService.getSnapshot(),
          runAutomation,
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
        triggerProviders: [scheduleTriggerProvider],
        actionProviders,
      })
    },
  }
}

export const automationsModule = createAutomationsModule()
