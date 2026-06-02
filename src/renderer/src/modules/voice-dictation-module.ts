import type { RendererModule } from './renderer-host'

// Renderer-only capability module: gates the voice-dictation feature (the mic
// button in the top bar, the Cmd/Ctrl+Shift+1 shortcut, and the Voice dictation
// settings tab). It registers no panel — the UI lives in the existing top bar
// and settings surfaces, which read `selectModuleEnabled(..., 'voice-dictation')`
// to show/hide themselves. The capability is enablement-only, so the toggle in
// Settings → Modules turns the whole feature on or off.
export const voiceDictationRendererModule: RendererModule = {
  manifest: {
    id: 'voice-dictation',
    displayName: 'Voice dictation',
    version: 1,
    publisher: 'multicode',
    category: 'connectivity',
    summary:
      'Record speech from the top bar (or Ctrl/Cmd+Shift+1) and transcribe it with a Whisper server, copying the text to the clipboard. Configure the server in Settings → Voice dictation.',
    defaultEnabled: true,
  },
}
