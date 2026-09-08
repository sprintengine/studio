import type { IpcMain } from 'electron'
import type {
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
  SkillSourcesResult,
  SkillSyncSourceInput,
  SkillSyncSourceOutcome,
  SkillUninstallInput,
  SkillUninstallOutcome,
} from '../../shared/electron-api'
import type { SkillsService } from '../skills'

export function registerSkillsIpc(ipcMain: IpcMain, service: SkillsService): void {
  ipcMain.handle('skills:list-sources', (): Promise<SkillSourcesResult> => service.listSources())
  ipcMain.handle(
    'skills:add-source',
    (_, input: SkillAddSourceInput): Promise<SkillAddSourceResult> => service.addSource(input)
  )
  ipcMain.handle(
    'skills:add-local-source',
    (_, input: SkillAddLocalSourceInput): Promise<SkillAddSourceResult> => service.addLocalSource(input)
  )
  ipcMain.handle(
    'skills:remove-source',
    (_, input: SkillRemoveSourceInput): Promise<SkillRemoveSourceResult> => service.removeSource(input)
  )
  ipcMain.handle(
    'skills:scan',
    (_, input: SkillScanInput): Promise<SkillScanOutcome> => service.getScan(input)
  )
  ipcMain.handle(
    'skills:read-file',
    (_, input: SkillReadFileInput): Promise<SkillReadFileResult> => service.readFile(input)
  )
  ipcMain.handle(
    'skills:install',
    (_, input: SkillInstallInput): Promise<SkillInstallOutcome> => service.install(input)
  )
  ipcMain.handle(
    'skills:uninstall',
    (_, input: SkillUninstallInput): Promise<SkillUninstallOutcome> => service.uninstall(input)
  )
  ipcMain.handle(
    'skills:sync-source',
    (_, input: SkillSyncSourceInput): Promise<SkillSyncSourceOutcome> => service.syncSource(input)
  )
  ipcMain.handle(
    'skills:search',
    (_, input: SkillSearchInput): Promise<SkillSearchOutcome> => service.search(input)
  )
  ipcMain.handle(
    'skills:list-popular-repos',
    (): Promise<SkillPopularReposOutcome> => service.listPopularRepos()
  )
  ipcMain.handle(
    'skills:scan-linked-plugin',
    (_, input: SkillPluginScanLinkedInput): Promise<SkillPluginScanLinkedOutcome> => service.scanLinkedPlugin(input)
  )
  ipcMain.handle(
    'skills:install-plugin',
    (_, input: SkillPluginInstallInput): Promise<SkillPluginInstallOutcome> => service.installPlugin(input)
  )
  ipcMain.handle(
    'skills:uninstall-plugin',
    (_, input: SkillPluginUninstallInput): Promise<SkillPluginUninstallOutcome> => service.uninstallPlugin(input)
  )
  ipcMain.handle(
    'skills:list-installed-plugins',
    (_, input: SkillInstalledPluginsInput): Promise<SkillInstalledPluginsOutcome> => service.listInstalledPlugins(input)
  )
}
