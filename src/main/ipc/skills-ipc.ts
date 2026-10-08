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
import { assertAppSender } from './ipc-sender'

export function registerSkillsIpc(ipcMain: IpcMain, service: SkillsService): void {
  // What adds, removes, installs or syncs a skill or plugin changes what the
  // agent CLIs on this machine load, so only the app's own window is answered
  // (ipc-sender.ts); the reads answer anyone holding the preload.
  ipcMain.handle('skills:list-sources', (): Promise<SkillSourcesResult> => service.listSources())
  // The manual Check now. It runs the same check the poller runs, under the
  // same per-source cadence window, so a person pressing it cannot
  // spend the anonymous GitHub budget the window exists to protect — the
  // result names the sources it left alone and says when they were last asked.
  ipcMain.handle('skills:check-source-updates', (): Promise<SkillSourceUpdateCheck> => service.checkSourceUpdates())
  ipcMain.handle('skills:add-source', (event, input: SkillAddSourceInput): Promise<SkillAddSourceResult> => {
    assertAppSender(event)
    return service.addSource(input)
  })
  ipcMain.handle('skills:add-local-source', (event, input: SkillAddLocalSourceInput): Promise<SkillAddSourceResult> => {
    assertAppSender(event)
    return service.addLocalSource(input)
  })
  ipcMain.handle('skills:remove-source', (event, input: SkillRemoveSourceInput): Promise<SkillRemoveSourceResult> => {
    assertAppSender(event)
    return service.removeSource(input)
  })
  ipcMain.handle('skills:scan', (_, input: SkillScanInput): Promise<SkillScanOutcome> => service.getScan(input))
  ipcMain.handle('skills:read-file', (_, input: SkillReadFileInput): Promise<SkillReadFileResult> =>
    service.readFile(input),
  )
  ipcMain.handle('skills:install', (event, input: SkillInstallInput): Promise<SkillInstallOutcome> => {
    assertAppSender(event)
    return service.install(input)
  })
  ipcMain.handle('skills:uninstall', (event, input: SkillUninstallInput): Promise<SkillUninstallOutcome> => {
    assertAppSender(event)
    return service.uninstall(input)
  })
  ipcMain.handle('skills:sync-source', (event, input: SkillSyncSourceInput): Promise<SkillSyncSourceOutcome> => {
    assertAppSender(event)
    return service.syncSource(input)
  })
  ipcMain.handle('skills:search', (_, input: SkillSearchInput): Promise<SkillSearchOutcome> => service.search(input))
  ipcMain.handle('skills:list-popular-repos', (): Promise<SkillPopularReposOutcome> => service.listPopularRepos())
  ipcMain.handle(
    'skills:scan-linked-plugin',
    (_, input: SkillPluginScanLinkedInput): Promise<SkillPluginScanLinkedOutcome> => service.scanLinkedPlugin(input),
  )
  ipcMain.handle(
    'skills:install-plugin',
    (event, input: SkillPluginInstallInput): Promise<SkillPluginInstallOutcome> => {
      assertAppSender(event)
      return service.installPlugin(input)
    },
  )
  ipcMain.handle(
    'skills:uninstall-plugin',
    (event, input: SkillPluginUninstallInput): Promise<SkillPluginUninstallOutcome> => {
      assertAppSender(event)
      return service.uninstallPlugin(input)
    },
  )
  ipcMain.handle(
    'skills:list-installed-plugins',
    (_, input: SkillInstalledPluginsInput): Promise<SkillInstalledPluginsOutcome> =>
      service.listInstalledPlugins(input),
  )
}
