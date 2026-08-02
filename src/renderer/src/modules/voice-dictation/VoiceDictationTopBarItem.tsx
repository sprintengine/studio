import React from 'react'

import { StatusDot, Tooltip } from '../../components/ui'
import { useWorkspaceStore } from '../../store/workspaceStore'
import {
  getEffectiveKeybindingLabel,
  platformKeybindingsFromApiPlatform,
} from '../../commands/effectiveKeybindings'
import { voiceDictationController } from './voiceDictationController'

// The mic button, moved out of WorkspaceActions' hardcoded markup and into the
// module (MC-1861): it renders through the registerTopBarItem contribution
// point, so disabling the module removes it because nothing registered it —
// not because a call site checks a flag. Styling matches the sibling shell
// controls in the communication cluster (Notifications).

function MicIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="9" y="3.25" width="6" height="11" rx="3" stroke="currentColor" strokeWidth="1.7" />
      <path d="M5.75 11.5a6.25 6.25 0 0 0 12.5 0" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <path d="M12 17.75V20.5M8.75 20.5h6.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  )
}

export function VoiceDictationTopBarItem() {
  const { recording, transcribing } = React.useSyncExternalStore(
    voiceDictationController.subscribe,
    voiceDictationController.getSnapshot,
  )
  const keybindingSettings = useWorkspaceStore((state) => state.appSettings.keybindings)
  const shortcut = getEffectiveKeybindingLabel(
    'voice-dictation.toggle',
    keybindingSettings,
    platformKeybindingsFromApiPlatform(window.api.platform),
  )
  const withShortcut = (label: string): string => (shortcut ? `${label} (${shortcut})` : label)

  // Unmount = the module was disabled (or the bar tore down): release the mic
  // rather than keep recording with no visible indicator.
  React.useEffect(() => () => voiceDictationController.abort(), [])

  return (
    <Tooltip
      content={
        recording
          ? withShortcut('Stop voice transcription')
          : transcribing
            ? 'Transcribing…'
            : withShortcut('Start voice transcription')
      }
      placement="bottom"
    >
      <button
        type="button"
        onClick={voiceDictationController.toggle}
        disabled={transcribing}
        aria-label={recording ? 'Stop voice transcription' : 'Start voice transcription'}
        aria-pressed={recording}
        className={`relative inline-flex h-8 w-8 items-center justify-center rounded-md border transition-colors disabled:opacity-60 ${
          recording
            ? 'border-[color:var(--tone-error)] bg-[color:var(--bg-hover)] text-[color:var(--tone-error)]'
            : 'border-[color:var(--bg-selected)] bg-[color:var(--bg-surface-raised)] text-[color:var(--text-muted)] hover:border-[color:var(--color-5)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-default)]'
        }`}
      >
        <MicIcon className="size-icon-md" />
        {recording ? (
          <span className="absolute -right-1 -top-1">
            <StatusDot tone="error" pulse label="Recording" />
          </span>
        ) : null}
      </button>
    </Tooltip>
  )
}

export default VoiceDictationTopBarItem
