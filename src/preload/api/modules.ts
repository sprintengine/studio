import { ipcRenderer } from 'electron'
import type {
  ElectronApi,
  ModuleEnablementOverrides,
  ModuleEnablementWriteResult,
} from '../../shared/electron-api'

export const modulesApi = {
  getModuleEnablement: (): Promise<ModuleEnablementOverrides> =>
    ipcRenderer.invoke('modules:get-enablement'),
  setModuleEnablement: (
    overrides: ModuleEnablementOverrides
  ): Promise<ModuleEnablementWriteResult> => ipcRenderer.invoke('modules:set-enablement', overrides),
} satisfies Pick<ElectronApi, 'getModuleEnablement' | 'setModuleEnablement'>
