import { ipcRenderer } from 'electron'
import type { ElectronApi, SoulPromptResult, SpecialistActionId } from '../../shared/electron-api'

async function readSpecialistSoul(specialistId: SpecialistActionId): Promise<SoulPromptResult> {
  try {
    return await ipcRenderer.invoke('souls:read-specialist', specialistId)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes("No handler registered for 'souls:read-specialist'")) {
      return {
        ok: false,
        message: 'Souls IPC handler is not registered. Restart the app to reconnect to the Souls registry.',
        path: null,
      }
    }
    throw error
  }
}

export const soulsApi = {
  readSpecialistSoul,
} satisfies Pick<ElectronApi, 'readSpecialistSoul'>
