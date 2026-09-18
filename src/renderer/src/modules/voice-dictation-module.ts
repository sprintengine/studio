import React from 'react'

import type { RendererModule } from './renderer-host'

// Voice dictation as a real module (MC-1861 phase 1): the mic button in the
// top bar, the Ctrl/Cmd+Shift+1 shortcut, and the Voice dictation settings tab
// are all *contributed* here. Disabling the module removes them because
// nothing registered them — no `selectModuleEnabled('voice-dictation')` checks
// remain in core. The transcription backend stays the core `voice:transcribe`
// IPC service behind `window.api.voiceTranscribe` (see the MC-1861 item file
// for the seam verdict); the out-of-tree extraction is MC-1888.

// Lazy — and deliberately NOT top-level imports — because both components (and
// the controller behind them) reach the workspace store; keeping them behind
// dynamic imports leaves the eager module-registry graph store-free, the
// discipline the other modules follow.
const VoiceDictationTopBarItem = React.lazy(() => import('./voice-dictation/VoiceDictationTopBarItem'))
const VoiceDictationSettingsSection = React.lazy(() => import('./voice-dictation/VoiceDictationSettingsSection'))

// The module owns its rail glyph (house pattern: 24×24 viewBox, currentColor
// strokes). Defined here rather than imported from AppIcons, which reaches
// back into the module registry and would cycle the eager graph.
function VoiceDictationSettingsIcon({ className }: { className?: string }) {
  return React.createElement(
    'svg',
    { className, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
    React.createElement('rect', {
      x: 9.5,
      y: 3,
      width: 5,
      height: 10,
      rx: 2.5,
      stroke: 'currentColor',
      strokeWidth: 1.7,
    }),
    React.createElement('path', {
      d: 'M6.5 11a5.5 5.5 0 0 0 11 0',
      stroke: 'currentColor',
      strokeWidth: 1.7,
      strokeLinecap: 'round',
    }),
    React.createElement('path', {
      d: 'M12 16.5V20M9 20h6',
      stroke: 'currentColor',
      strokeWidth: 1.7,
      strokeLinecap: 'round',
    }),
  )
}

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
  registerRenderer(host) {
    host.registerTopBarItem({
      id: 'voice-dictation',
      order: 10,
      Component: VoiceDictationTopBarItem,
    })
    // Registered id: `voice-dictation.toggle`. The shell command it replaces
    // (`voice.toggle`) rides LEGACY_COMMAND_ID_ALIASES, so a user-reassigned
    // or user-disabled binding always wins over this module default.
    host.registerCommand({
      id: 'toggle',
      title: 'Toggle Voice Transcription',
      category: 'voice',
      scopes: ['global'],
      defaultKeybindings: ['Primary+Shift+1'],
      // Allowed in editable targets so dictation can start while composing.
      allowInEditableTarget: true,
      run: () =>
        import('./voice-dictation/voiceDictationController').then(({ voiceDictationController }) =>
          voiceDictationController.toggle(),
        ),
    })
    host.registerSettingsSection({
      id: 'voice-dictation',
      label: 'Voice dictation',
      icon: VoiceDictationSettingsIcon,
      Component: VoiceDictationSettingsSection,
    })
  },
}
