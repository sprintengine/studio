import { ipc as ipcRenderer } from '../ipc-router'
import type { ElectronApi } from '../../shared/electron-api'
import type { ChatTitleRequest, TextGenerationResult } from '../../shared/text-generation/contract'

export const textGenerationApi = {
  generateChatTitle: (request: ChatTitleRequest): Promise<TextGenerationResult> =>
    ipcRenderer.invoke('text-generation:chat-title', request),
} satisfies Pick<ElectronApi, 'generateChatTitle'>
