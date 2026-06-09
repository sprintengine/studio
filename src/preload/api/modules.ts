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

type ModulesIpcRenderer = {
  invoke(channel: 'modules:set-enablement', overrides: ModuleEnablementOverrides): Promise<ModuleEnablementWriteResult>
  invoke(channel: 'modules:third-party:list'): Promise<ThirdPartyModuleListResult>
  invoke(channel: 'modules:third-party:install-folder', srcDir: string): Promise<ThirdPartyModuleInstallResult>
  invoke(
    channel: 'modules:third-party:set-trust',
    payload: { id: string; trusted: boolean }
  ): Promise<ThirdPartyModuleTrustResult>
}

export function createModulesApi(renderer: ModulesIpcRenderer) {
  return {
    setModuleEnablement: (
      overrides: ModuleEnablementOverrides
    ): Promise<ModuleEnablementWriteResult> => renderer.invoke('modules:set-enablement', overrides),
    listThirdPartyModules: (): Promise<ThirdPartyModuleListResult> =>
      renderer.invoke('modules:third-party:list'),
    installThirdPartyModuleFolder: (srcDir: string): Promise<ThirdPartyModuleInstallResult> =>
      renderer.invoke('modules:third-party:install-folder', srcDir),
    setThirdPartyModuleTrust: (id: string, trusted: boolean): Promise<ThirdPartyModuleTrustResult> =>
      renderer.invoke('modules:third-party:set-trust', { id, trusted }),
  } satisfies Pick<
    ElectronApi,
    | 'setModuleEnablement'
    | 'listThirdPartyModules'
    | 'installThirdPartyModuleFolder'
    | 'setThirdPartyModuleTrust'
  >
}

export const modulesApi = createModulesApi(ipcRenderer)
