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
  SkillSourceUpdateCheck,
  SkillSyncSourceInput,
  SkillSyncSourceOutcome,
  SkillUninstallInput,
  SkillUninstallOutcome,
} from '../../shared/electron-api'
import type { SkillsService } from '../skills'

export function registerSkillsIpc(ipcMain: IpcMain, service: SkillsService): void {
  ipcMain.handle('skills:list-sources', (): Promise<SkillSourcesResult> => service.listSources())
  // The manual Check now. It runs the same check the poller runs, under the
  // same per-source cadence window (MC-2519), so a person pressing it cannot
  // spend the anonymous GitHub budget the window exists to protect — the
  // result names the sources it left alone and says when they were last asked.
  ipcMain.handle(
    'skills:check-source-updates',
    (): Promise<SkillSourceUpdateCheck> => service.checkSourceUpdates()
  )
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
