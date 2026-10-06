import { ipc as ipcRenderer } from '../ipc-router'
import type {
  ConversationImportInput,
  ConversationImportResult,
  ConversationImportScanResult,
  ElectronApi,
} from '../../shared/electron-api'

export const conversationImportApi = {
  scanImportableConversations: (): Promise<ConversationImportScanResult> =>
    ipcRenderer.invoke('conversation-import:scan'),
  importConversations: (input: ConversationImportInput): Promise<ConversationImportResult> =>
    ipcRenderer.invoke('conversation-import:import', input),
} satisfies Pick<ElectronApi, 'scanImportableConversations' | 'importConversations'>
