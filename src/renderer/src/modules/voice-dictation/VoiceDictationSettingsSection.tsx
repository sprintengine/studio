import React from 'react'

import { Field, Input, Select, type SelectItem } from '../../components/ui'
import { useWorkspaceStore } from '../../store/workspaceStore'
import type { VoiceDictationModel } from '../../types/workspace'

// The Voice dictation settings tab, moved off SettingsPanel's hardcoded tab
// list and onto the registerSettingsSection contribution point (MC-1861).
// Settings stay in `appSettings.voiceDictation` — the store slice the
// transcription IPC contract (`window.api.voiceTranscribe`) already reads —
// rather than the host's per-module namespace, so the persisted shape and
// behavior are unchanged; only the mount moved.

const VOICE_MODEL_ITEMS: SelectItem<VoiceDictationModel>[] = [
  { value: 'tiny', label: 'Whisper tiny — fastest, least accurate' },
  { value: 'base', label: 'Whisper base' },
  { value: 'small', label: 'Whisper small — recommended' },
  { value: 'medium', label: 'Whisper medium' },
  { value: 'large-v2', label: 'Whisper large-v2' },
  { value: 'large-v3', label: 'Whisper large-v3' },
  { value: 'large-v3-turbo', label: 'Whisper large-v3-turbo' },
]

const VOICE_LANGUAGE_ITEMS: SelectItem<string>[] = [
  { value: 'auto', label: 'Auto-detect' },
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Spanish' },
  { value: 'fr', label: 'French' },
  { value: 'de', label: 'German' },
  { value: 'it', label: 'Italian' },
  { value: 'pt', label: 'Portuguese' },
  { value: 'nl', label: 'Dutch' },
  { value: 'ja', label: 'Japanese' },
  { value: 'zh', label: 'Chinese' },
]

export function VoiceDictationSettingsSection() {
  const voiceDictation = useWorkspaceStore((s) => s.appSettings.voiceDictation)
  const setVoiceDictationSettings = useWorkspaceStore((s) => s.setVoiceDictationSettings)

  return (
    <div className="space-y-4">
      <Field label="Server URL" htmlFor="voice-server-url" help="The Multivoice transcription host.">
        <Input
          id="voice-server-url"
          value={voiceDictation.serverUrl}
          onChange={(event) => setVoiceDictationSettings({ serverUrl: event.target.value })}
          placeholder="http://127.0.0.1:48173"
          size="md"
          className="font-mono"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
        />
      </Field>

      <Field
        label="Auth token"
        htmlFor="voice-auth-token"
        help="Optional."
      >
        <Input
          id="voice-auth-token"
          type="password"
          value={voiceDictation.authToken}
          onChange={(event) => setVoiceDictationSettings({ authToken: event.target.value })}
          placeholder="(none)"
          size="md"
          className="font-mono"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
        />
      </Field>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Whisper model" htmlFor="voice-model">
          <Select
            ariaLabel="Whisper model"
            items={VOICE_MODEL_ITEMS}
            value={voiceDictation.model}
            onChange={(model: VoiceDictationModel) => setVoiceDictationSettings({ model })}
            className="h-control-md w-full"
          />
        </Field>
        <Field label="Language" htmlFor="voice-language">
          <Select
            ariaLabel="Language"
            items={VOICE_LANGUAGE_ITEMS}
            value={voiceDictation.language}
            onChange={(language: string) => setVoiceDictationSettings({ language })}
            className="h-control-md w-full"
          />
        </Field>
      </div>
    </div>
  )
}

export default VoiceDictationSettingsSection
