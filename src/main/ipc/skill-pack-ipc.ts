import type { IpcMain } from 'electron'
import type {
  SkillPackCatalogResult,
  SkillPackInstallInput,
  SkillPackInstallResult,
  SkillPackListInstalledInput,
  SkillPackListInstalledResult,
  SkillPackRemoveInput,
  SkillPackRemoveResult,
} from '../../shared/electron-api'
import type { SkillPackService } from '../skill-pack-service'

export function registerSkillPackIpc(ipcMain: IpcMain, service: SkillPackService): void {
  ipcMain.handle('skill-pack:catalog', (): SkillPackCatalogResult => service.listCatalog())
  ipcMain.handle(
    'skill-pack:list-installed',
    (_, input: SkillPackListInstalledInput): Promise<SkillPackListInstalledResult> =>
      service.listInstalled(input),
  )
  ipcMain.handle(
    'skill-pack:install',
    (_, input: SkillPackInstallInput): Promise<SkillPackInstallResult> => service.install(input),
  )
  ipcMain.handle(
    'skill-pack:remove',
    (_, input: SkillPackRemoveInput): Promise<SkillPackRemoveResult> => service.remove(input),
  )
}
