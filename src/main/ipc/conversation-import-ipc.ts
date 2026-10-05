import type { IpcMain } from 'electron'

import type {
  ConversationImportInput,
  ConversationImportResult,
  ConversationImportScanResult,
} from '../../shared/ipc/conversation-import'
import type { ConversationImportService } from '../conversation-import/conversation-import-service'

export function registerConversationImportIpc(ipcMain: IpcMain, service: ConversationImportService): void {
  ipcMain.handle('conversation-import:scan', (): Promise<ConversationImportScanResult> => service.scan())
  ipcMain.handle('conversation-import:import', (_, input: ConversationImportInput): Promise<ConversationImportResult> =>
    service.importSessions(input),
  )
}
