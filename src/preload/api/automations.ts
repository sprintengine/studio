import { ipcRenderer, type IpcRendererEvent } from 'electron'
import type { ElectronApi } from '../../shared/electron-api'
import type {
  AutomationsCreateInput,
  AutomationsDefinitionInput,
  AutomationsDefinitionResult,
  AutomationsDeleteResult,
  AutomationsEngineStatusResult,
  AutomationsListResult,
  AutomationsProvidersResult,
  AutomationsDefinitionsChangedEvent,
  AutomationsRunEvent,
  AutomationsRunFinalizeInput,
  AutomationsRunFinalizeResult,
  AutomationsRunNowResult,
  AutomationsRunsListInput,
  AutomationsRunsListResult,
  AutomationsUpdateInput,
  AutomationsWorkspaceInput,
} from '../../shared/automations/contracts'
import {
  AUTOMATIONS_CREATE_CHANNEL,
  AUTOMATIONS_DEFINITIONS_CHANGED_CHANNEL,
  AUTOMATIONS_DELETE_CHANNEL,
  AUTOMATIONS_ENGINE_STATUS_CHANNEL,
  AUTOMATIONS_GET_CHANNEL,
  AUTOMATIONS_LIST_CHANNEL,
  AUTOMATIONS_PROVIDERS_LIST_CHANNEL,
  AUTOMATIONS_RUN_EVENT_CHANNEL,
  AUTOMATIONS_RUN_NOW_CHANNEL,
  AUTOMATIONS_RUN_FINALIZE_CHANNEL,
  AUTOMATIONS_RUNS_LIST_CHANNEL,
  AUTOMATIONS_UPDATE_CHANNEL,
} from '../../shared/automations/contracts'

type AutomationsIpcRenderer = {
  invoke(channel: string, input?: unknown): Promise<unknown>
  on(channel: string, listener: (event: IpcRendererEvent, payload: unknown) => void): void
  removeListener(channel: string, listener: (event: IpcRendererEvent, payload: unknown) => void): void
}

// Renderer → main bridge for the Automations engine IPC registered by the main
// automations module (src/main/ipc/automations-ipc.ts). The renderer never
// touches the on-disk store; every read and write goes through these channels.
export function createAutomationsApi(renderer: AutomationsIpcRenderer): Pick<
  ElectronApi,
  | 'listAutomations'
  | 'getAutomation'
  | 'createAutomation'
  | 'updateAutomation'
  | 'deleteAutomation'
  | 'runAutomationNow'
  | 'listAutomationRuns'
  | 'finalizeAutomationRun'
  | 'listAutomationProviders'
  | 'getAutomationsEngineStatus'
  | 'onAutomationRunEvent'
  | 'onAutomationsDefinitionsChanged'
> {
  return {
    listAutomations: (input: AutomationsWorkspaceInput): Promise<AutomationsListResult> =>
      renderer.invoke(AUTOMATIONS_LIST_CHANNEL, input) as Promise<AutomationsListResult>,
    getAutomation: (input: AutomationsDefinitionInput): Promise<AutomationsDefinitionResult> =>
      renderer.invoke(AUTOMATIONS_GET_CHANNEL, input) as Promise<AutomationsDefinitionResult>,
    createAutomation: (input: AutomationsCreateInput): Promise<AutomationsDefinitionResult> =>
      renderer.invoke(AUTOMATIONS_CREATE_CHANNEL, input) as Promise<AutomationsDefinitionResult>,
    updateAutomation: (input: AutomationsUpdateInput): Promise<AutomationsDefinitionResult> =>
      renderer.invoke(AUTOMATIONS_UPDATE_CHANNEL, input) as Promise<AutomationsDefinitionResult>,
    deleteAutomation: (input: AutomationsDefinitionInput): Promise<AutomationsDeleteResult> =>
      renderer.invoke(AUTOMATIONS_DELETE_CHANNEL, input) as Promise<AutomationsDeleteResult>,
    runAutomationNow: (input: AutomationsDefinitionInput): Promise<AutomationsRunNowResult> =>
      renderer.invoke(AUTOMATIONS_RUN_NOW_CHANNEL, input) as Promise<AutomationsRunNowResult>,
    listAutomationRuns: (input: AutomationsRunsListInput): Promise<AutomationsRunsListResult> =>
      renderer.invoke(AUTOMATIONS_RUNS_LIST_CHANNEL, input) as Promise<AutomationsRunsListResult>,
    finalizeAutomationRun: (input: AutomationsRunFinalizeInput): Promise<AutomationsRunFinalizeResult> =>
      renderer.invoke(AUTOMATIONS_RUN_FINALIZE_CHANNEL, input) as Promise<AutomationsRunFinalizeResult>,
    listAutomationProviders: (): Promise<AutomationsProvidersResult> =>
      renderer.invoke(AUTOMATIONS_PROVIDERS_LIST_CHANNEL) as Promise<AutomationsProvidersResult>,
    getAutomationsEngineStatus: (): Promise<AutomationsEngineStatusResult> =>
      renderer.invoke(AUTOMATIONS_ENGINE_STATUS_CHANNEL) as Promise<AutomationsEngineStatusResult>,
    onAutomationRunEvent: (cb: (event: AutomationsRunEvent) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, payload: unknown) => cb(payload as AutomationsRunEvent)
      renderer.on(AUTOMATIONS_RUN_EVENT_CHANNEL, handler)
      return () => renderer.removeListener(AUTOMATIONS_RUN_EVENT_CHANNEL, handler)
    },
    onAutomationsDefinitionsChanged: (cb: (event: AutomationsDefinitionsChangedEvent) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, payload: unknown): void => cb(payload as AutomationsDefinitionsChangedEvent)
      renderer.on(AUTOMATIONS_DEFINITIONS_CHANGED_CHANNEL, handler)
      return () => renderer.removeListener(AUTOMATIONS_DEFINITIONS_CHANGED_CHANNEL, handler)
    },
  }
}

export const automationsApi = createAutomationsApi(ipcRenderer)
