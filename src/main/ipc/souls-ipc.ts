import type { IpcMain } from 'electron'
import type {
  MultiloopAgentSoulRole,
  SoulPromptResult,
  SpecialistActionId,
} from '../../shared/electron-api'

type SoulsIpcDependencies = {
  readSpecialistSoul(specialistId: SpecialistActionId): Promise<SoulPromptResult>
  readMultiloopAgentSoul(role: MultiloopAgentSoulRole): Promise<SoulPromptResult>
}

export function registerSoulsIpc(ipcMain: IpcMain, deps: SoulsIpcDependencies): void {
  ipcMain.handle('souls:read-specialist', async (_, specialistId: SpecialistActionId) => {
    return deps.readSpecialistSoul(specialistId)
  })

  ipcMain.handle('multiloop:read-agent-soul', async (_, role: MultiloopAgentSoulRole) => {
    return deps.readMultiloopAgentSoul(role)
  })
}
