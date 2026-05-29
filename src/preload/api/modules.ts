import { ipcRenderer } from 'electron'
import type {
  ElectronApi,
  ModuleEnablementOverrides,
  ModuleEnablementWriteResult,
} from '../../shared/electron-api'
import type {
  ThirdPartyModuleInstallResult,
  ThirdPartyModuleListResult,
  ThirdPartyModuleTrustResult,
} from '../../shared/modules/manifest'

export const modulesApi = {
  setModuleEnablement: (
    overrides: ModuleEnablementOverrides
  ): Promise<ModuleEnablementWriteResult> => ipcRenderer.invoke('modules:set-enablement', overrides),
  listThirdPartyModules: (): Promise<ThirdPartyModuleListResult> =>
    ipcRenderer.invoke('modules:third-party:list'),
  installThirdPartyModuleFolder: (srcDir: string): Promise<ThirdPartyModuleInstallResult> =>
    ipcRenderer.invoke('modules:third-party:install-folder', srcDir),
  setThirdPartyModuleTrust: (id: string, trusted: boolean): Promise<ThirdPartyModuleTrustResult> =>
    ipcRenderer.invoke('modules:third-party:set-trust', { id, trusted }),
} satisfies Pick<
  ElectronApi,
  | 'setModuleEnablement'
  | 'listThirdPartyModules'
  | 'installThirdPartyModuleFolder'
  | 'setThirdPartyModuleTrust'
>
