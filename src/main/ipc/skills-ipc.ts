import type { IpcMain } from 'electron'
import type {
  SkillAddSourceInput,
  SkillAddSourceResult,
  SkillInstallInput,
  SkillInstallOutcome,
  SkillReadFileInput,
  SkillReadFileResult,
  SkillRemoveSourceInput,
  SkillRemoveSourceResult,
  SkillScanInput,
  SkillScanOutcome,
  SkillSourcesResult,
  SkillSyncSourceInput,
  SkillSyncSourceOutcome,
} from '../../shared/electron-api'
import type { SkillsService } from '../skills'

export function registerSkillsIpc(ipcMain: IpcMain, service: SkillsService): void {
  ipcMain.handle('skills:list-sources', (): Promise<SkillSourcesResult> => service.listSources())
  ipcMain.handle(
    'skills:add-source',
    (_, input: SkillAddSourceInput): Promise<SkillAddSourceResult> => service.addSource(input)
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
    'skills:sync-source',
    (_, input: SkillSyncSourceInput): Promise<SkillSyncSourceOutcome> => service.syncSource(input)
  )
}
