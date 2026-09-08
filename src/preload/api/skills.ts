import { ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  ElectronApi,
  SkillAddLocalSourceInput,
  SkillAddSourceInput,
  SkillAddSourceResult,
  SkillInstallInput,
  SkillInstallOutcome,
  SkillInstalledPluginsInput,
  SkillInstalledPluginsOutcome,
  SkillPluginInstallInput,
  SkillPluginInstallOutcome,
  SkillPluginScanLinkedInput,
  SkillPluginScanLinkedOutcome,
  SkillPluginUninstallInput,
  SkillPluginUninstallOutcome,
  SkillPopularReposOutcome,
  SkillReadFileInput,
  SkillReadFileResult,
  SkillRemoveSourceInput,
  SkillRemoveSourceResult,
  SkillScanInput,
  SkillScanOutcome,
  SkillSearchInput,
  SkillSearchOutcome,
  SkillSourceUpdateCheck,
  SkillSourcesResult,
  SkillSyncSourceInput,
  SkillSyncSourceOutcome,
  SkillUninstallInput,
  SkillUninstallOutcome,
} from '../../shared/electron-api'

export const skillsApi = {
  skillsListSources: (): Promise<SkillSourcesResult> => ipcRenderer.invoke('skills:list-sources'),
  skillsAddSource: (input: SkillAddSourceInput): Promise<SkillAddSourceResult> =>
    ipcRenderer.invoke('skills:add-source', input),
  skillsAddLocalSource: (input: SkillAddLocalSourceInput): Promise<SkillAddSourceResult> =>
    ipcRenderer.invoke('skills:add-local-source', input),
  skillsRemoveSource: (input: SkillRemoveSourceInput): Promise<SkillRemoveSourceResult> =>
    ipcRenderer.invoke('skills:remove-source', input),
  skillsGetScan: (input: SkillScanInput): Promise<SkillScanOutcome> =>
    ipcRenderer.invoke('skills:scan', input),
  skillsReadFile: (input: SkillReadFileInput): Promise<SkillReadFileResult> =>
    ipcRenderer.invoke('skills:read-file', input),
  skillsInstall: (input: SkillInstallInput): Promise<SkillInstallOutcome> =>
    ipcRenderer.invoke('skills:install', input),
  skillsUninstall: (input: SkillUninstallInput): Promise<SkillUninstallOutcome> =>
    ipcRenderer.invoke('skills:uninstall', input),
  skillsSyncSource: (input: SkillSyncSourceInput): Promise<SkillSyncSourceOutcome> =>
    ipcRenderer.invoke('skills:sync-source', input),
  skillsSearch: (input: SkillSearchInput): Promise<SkillSearchOutcome> =>
    ipcRenderer.invoke('skills:search', input),
  skillsListPopularRepos: (): Promise<SkillPopularReposOutcome> =>
    ipcRenderer.invoke('skills:list-popular-repos'),
  skillsScanLinkedPlugin: (input: SkillPluginScanLinkedInput): Promise<SkillPluginScanLinkedOutcome> =>
    ipcRenderer.invoke('skills:scan-linked-plugin', input),
  skillsInstallPlugin: (input: SkillPluginInstallInput): Promise<SkillPluginInstallOutcome> =>
    ipcRenderer.invoke('skills:install-plugin', input),
  skillsUninstallPlugin: (input: SkillPluginUninstallInput): Promise<SkillPluginUninstallOutcome> =>
    ipcRenderer.invoke('skills:uninstall-plugin', input),
  skillsListInstalledPlugins: (input: SkillInstalledPluginsInput): Promise<SkillInstalledPluginsOutcome> =>
    ipcRenderer.invoke('skills:list-installed-plugins', input),
  onSkillSourcesUpdated: (cb: (check: SkillSourceUpdateCheck) => void): (() => void) => {
    const channel = 'skills:sources-updated'
    const handler = (_: IpcRendererEvent, check: SkillSourceUpdateCheck): void => cb(check)
    ipcRenderer.on(channel, handler)
    return () => ipcRenderer.removeListener(channel, handler)
  },
} satisfies Pick<
  ElectronApi,
  | 'skillsListSources'
  | 'skillsAddSource'
  | 'skillsAddLocalSource'
  | 'skillsRemoveSource'
  | 'skillsGetScan'
  | 'skillsReadFile'
  | 'skillsInstall'
  | 'skillsUninstall'
  | 'skillsSyncSource'
  | 'skillsSearch'
  | 'skillsListPopularRepos'
  | 'skillsScanLinkedPlugin'
  | 'skillsInstallPlugin'
  | 'skillsUninstallPlugin'
  | 'skillsListInstalledPlugins'
  | 'onSkillSourcesUpdated'
>
