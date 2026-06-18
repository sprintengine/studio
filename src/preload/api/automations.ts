import { ipcRenderer } from 'electron'
import type { ElectronApi } from '../../shared/electron-api'
import type {
  AutomationsCreateInput,
  AutomationsDefinitionInput,
  AutomationsDefinitionResult,
  AutomationsDeleteResult,
  AutomationsListResult,
  AutomationsProvidersResult,
  AutomationsRunNowResult,
  AutomationsRunsListInput,
  AutomationsRunsListResult,
  AutomationsUpdateInput,
  AutomationsWorkspaceInput,
} from '../../shared/automations/contracts'
import {
  AUTOMATIONS_CREATE_CHANNEL,
  AUTOMATIONS_DELETE_CHANNEL,
  AUTOMATIONS_GET_CHANNEL,
  AUTOMATIONS_LIST_CHANNEL,
  AUTOMATIONS_PROVIDERS_LIST_CHANNEL,
  AUTOMATIONS_RUN_NOW_CHANNEL,
  AUTOMATIONS_RUNS_LIST_CHANNEL,
  AUTOMATIONS_UPDATE_CHANNEL,
} from '../../shared/automations/contracts'

// Renderer → main bridge for the Automations engine IPC registered by the main
// automations module (src/main/ipc/automations-ipc.ts). The renderer never
// touches the on-disk store; every read and write goes through these channels.
export const automationsApi = {
  listAutomations: (input: AutomationsWorkspaceInput): Promise<AutomationsListResult> =>
    ipcRenderer.invoke(AUTOMATIONS_LIST_CHANNEL, input),
  getAutomation: (input: AutomationsDefinitionInput): Promise<AutomationsDefinitionResult> =>
    ipcRenderer.invoke(AUTOMATIONS_GET_CHANNEL, input),
  createAutomation: (input: AutomationsCreateInput): Promise<AutomationsDefinitionResult> =>
    ipcRenderer.invoke(AUTOMATIONS_CREATE_CHANNEL, input),
  updateAutomation: (input: AutomationsUpdateInput): Promise<AutomationsDefinitionResult> =>
    ipcRenderer.invoke(AUTOMATIONS_UPDATE_CHANNEL, input),
  deleteAutomation: (input: AutomationsDefinitionInput): Promise<AutomationsDeleteResult> =>
    ipcRenderer.invoke(AUTOMATIONS_DELETE_CHANNEL, input),
  runAutomationNow: (input: AutomationsDefinitionInput): Promise<AutomationsRunNowResult> =>
    ipcRenderer.invoke(AUTOMATIONS_RUN_NOW_CHANNEL, input),
  listAutomationRuns: (input: AutomationsRunsListInput): Promise<AutomationsRunsListResult> =>
    ipcRenderer.invoke(AUTOMATIONS_RUNS_LIST_CHANNEL, input),
  listAutomationProviders: (): Promise<AutomationsProvidersResult> =>
    ipcRenderer.invoke(AUTOMATIONS_PROVIDERS_LIST_CHANNEL),
} satisfies Pick<
  ElectronApi,
  | 'listAutomations'
  | 'getAutomation'
  | 'createAutomation'
  | 'updateAutomation'
  | 'deleteAutomation'
  | 'runAutomationNow'
  | 'listAutomationRuns'
  | 'listAutomationProviders'
>
