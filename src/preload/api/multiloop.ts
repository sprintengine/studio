import { ipcRenderer } from 'electron'
import type { ElectronApi, MultiloopInitInput, MultiloopInitResult } from '../../shared/electron-api'

export const multiloopApi = {
  initializeMultiloopState: (input: MultiloopInitInput): Promise<MultiloopInitResult> =>
    ipcRenderer.invoke('multiloop:init', input),
} satisfies Pick<ElectronApi, 'initializeMultiloopState'>
