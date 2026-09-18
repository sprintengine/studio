import type { IpcMain } from 'electron'

import {
  transcribeAudio,
  TranscriptionError,
  type TranscriptionRequestSettings,
  type VoiceTranscribeResponse,
} from '../../shared/voiceTranscription'

// Voice dictation runs the transcription request from the main process: the
// Multivoice host speaks a native-client contract with no CORS headers, so a
// renderer `fetch` is blocked by Chromium's preflight ("Failed to fetch").
// Main-process `fetch` is exempt. The renderer encodes the WAV and sends it here.
export function registerVoiceIpc(ipcMain: IpcMain): void {
  ipcMain.handle(
    'voice:transcribe',
    async (_event, wav: unknown, settings: TranscriptionRequestSettings): Promise<VoiceTranscribeResponse> => {
      if (!(wav instanceof ArrayBuffer)) {
        return { ok: false, message: 'Voice transcription received an invalid audio payload.' }
      }
      try {
        const result = await transcribeAudio(wav, settings)
        return { ok: true, result }
      } catch (error) {
        const message =
          error instanceof TranscriptionError
            ? error.message
            : error instanceof Error
              ? error.message
              : 'Transcription failed.'
        return { ok: false, message }
      }
    },
  )
}
