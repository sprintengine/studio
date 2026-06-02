import { ipcRenderer } from 'electron'
import type { ElectronApi } from '../../shared/electron-api'

export const clipboardApi = {
  clipboardReadText: (): Promise<string> => ipcRenderer.invoke('clipboard:read-text'),
  clipboardWriteText: (text: string): Promise<void> => ipcRenderer.invoke('clipboard:write-text', text),
} satisfies Pick<ElectronApi, 'clipboardReadText' | 'clipboardWriteText'>
