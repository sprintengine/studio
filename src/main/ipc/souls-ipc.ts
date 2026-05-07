import type { IpcMain } from 'electron'
import type {
  MultiloopRole,
  SoulPromptResult,
  SpecialistActionId,
} from '../../shared/electron-api'

type SoulsIpcDependencies = {
  readSpecialistSoul(specialistId: SpecialistActionId): Promise<SoulPromptResult>
  readMultiloopPrompt(role: MultiloopRole): Promise<SoulPromptResult>
}

export function registerSoulsIpc(ipcMain: IpcMain, deps: SoulsIpcDependencies): void {
  ipcMain.handle('souls:read-specialist', async (_, specialistId: SpecialistActionId) => {
    return deps.readSpecialistSoul(specialistId)
  })

  ipcMain.handle('multiloop:read-prompt', async (_, role: MultiloopRole) => {
    return deps.readMultiloopPrompt(role)
  })
}
