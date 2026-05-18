import { ipcRenderer } from 'electron'
import type {
  ElectronApi,
  SkillPackCatalogResult,
  SkillPackInstallInput,
  SkillPackInstallResult,
  SkillPackListInstalledInput,
  SkillPackListInstalledResult,
  SkillPackRemoveInput,
  SkillPackRemoveResult,
} from '../../shared/electron-api'

export const skillPackApi = {
  skillPackListCatalog: (): Promise<SkillPackCatalogResult> =>
    ipcRenderer.invoke('skill-pack:catalog'),
  skillPackListInstalled: (
    input: SkillPackListInstalledInput,
  ): Promise<SkillPackListInstalledResult> => ipcRenderer.invoke('skill-pack:list-installed', input),
  skillPackInstall: (input: SkillPackInstallInput): Promise<SkillPackInstallResult> =>
    ipcRenderer.invoke('skill-pack:install', input),
  skillPackRemove: (input: SkillPackRemoveInput): Promise<SkillPackRemoveResult> =>
    ipcRenderer.invoke('skill-pack:remove', input),
} satisfies Pick<
  ElectronApi,
  'skillPackListCatalog' | 'skillPackListInstalled' | 'skillPackInstall' | 'skillPackRemove'
>
