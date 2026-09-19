import type { IpcMain } from 'electron'
import type {
  AgentConfigAdoptInput,
  AgentConfigAdoptResult,
  AgentConfigDetectInput,
  AgentConfigDetectResult,
} from '../../shared/electron-api'
import type { AgentConfigImportService } from '../agent-config-import'

export function registerAgentConfigImportIpc(ipcMain: IpcMain, service: AgentConfigImportService): void {
  ipcMain.handle('agent-config:detect', (_, input?: AgentConfigDetectInput): Promise<AgentConfigDetectResult> =>
    service.detect(input),
  )
  ipcMain.handle('agent-config:adopt', (_, input: AgentConfigAdoptInput): Promise<AgentConfigAdoptResult> =>
    service.adopt(input),
  )
}
