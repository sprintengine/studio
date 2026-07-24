import type { IpcMain } from 'electron'
import type { SoulPromptResult, SpecialistActionId } from '../../shared/electron-api'

type SoulsIpcDependencies = {
  readSpecialistSoul(specialistId: SpecialistActionId): Promise<SoulPromptResult>
}

export function registerSoulsIpc(ipcMain: IpcMain, deps: SoulsIpcDependencies): void {
  ipcMain.handle('souls:read-specialist', async (_, specialistId: SpecialistActionId) => {
    return deps.readSpecialistSoul(specialistId)
  })
}
