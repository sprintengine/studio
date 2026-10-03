import { ipc as ipcRenderer } from '../ipc-router'
import type { ElectronApi } from '../../shared/electron-api'
import type { TranscriptionRequestSettings, VoiceTranscribeResponse } from '../../shared/voiceTranscription'

export const voiceApi = {
  voiceTranscribe: (wav: ArrayBuffer, settings: TranscriptionRequestSettings): Promise<VoiceTranscribeResponse> =>
    ipcRenderer.invoke('voice:transcribe', wav, settings),
} satisfies Pick<ElectronApi, 'voiceTranscribe'>
