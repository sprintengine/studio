// Imported from the concrete module rather than the `../../ui` barrel to keep
// this hookless module free of the barrel's whole component graph.
import { Tooltip } from '../../ui/Tooltip'
import type { SprintEngineCliPermissionPreset } from '../../../types/workspace'

// Shared, presentation-only pieces of the agent spawn surfaces (the compact
// SpawnPicker and the AgentComposer panel). Kept in one hookless module so every
// surface can import them without pulling in the composer's store hook.

// Permission preset chips shown in the picker footer. Exported because the top
// bar's split-button trigger tooltip names the active preset.
export const AGENT_SPAWN_PERMISSION_OPTIONS: Array<{
  value: SprintEngineCliPermissionPreset
  label: string
  title: string
}> = [
  {
    value: 'none',
    label: 'CLI default',
    title: 'Pass no permission flag and let the CLI choose. Claude Code now starts in auto mode on Pro, Max and Team plans, so this is no longer the same as asking every time.',
  },
  {
    value: 'manual',
    label: 'Manual',
    title: 'Ask before every action.',
  },
  {
    value: 'auto',
    label: 'Auto',
    title: 'Run without stopping to ask, with the CLI’s own safety checks — a classifier on Claude Code, a workspace sandbox on Codex.',
  },
  {
    value: 'bypass',
    label: 'Bypass permissions',
    title: 'Skip CLI permission prompts. Use only in repos and environments you trust.',
  },
]

// Chip-width labels for the preset row. Exhaustive over the union so a preset
// added later fails the build here rather than rendering a blank chip.
const PRESET_CHIP_LABEL: Record<SprintEngineCliPermissionPreset, string> = {
  none: 'CLI default',
  manual: 'Manual',
  auto: 'Auto',
  bypass: 'Bypass',
}

// The CLI default / Manual / Auto / Bypass preset chip row — the one interactive permission
// control every spawn surface renders (composer panel, picker popover footer,
// Automations editor runtime row, and the chat composer's live permission
// pill), so the options and their tone can't drift. Bypass carries the warn
// tone when active; inactive chips stay quiet. `disabled` is for surfaces that
// change a LIVE session's preset: the row locks while the change is in flight
// so a second pick can't race the first. Selection is carried by aria-pressed
// as well as tint, so the active chip reads without color.
export function PermissionPresetChips({
  value,
  onChange,
  disabled = false,
}: {
  value: SprintEngineCliPermissionPreset
  onChange: (preset: SprintEngineCliPermissionPreset) => void
  disabled?: boolean
}) {
  return (
    <>
      {AGENT_SPAWN_PERMISSION_OPTIONS.map((option) => {
        const active = option.value === value
        const isBypass = option.value === 'bypass'
        return (
          <Tooltip key={option.value} content={option.title} placement="bottom">
            <button
              type="button"
              aria-pressed={active}
              disabled={disabled}
              onClick={() => onChange(option.value)}
              className={`rounded px-2 py-0.5 text-micro font-medium transition-colors focus-visible:focus-ring disabled:cursor-not-allowed disabled:opacity-50 ${
                active
                  ? isBypass
                    ? 'bg-[color:var(--tone-warn)]/12 text-[color:var(--tone-warn-on-tint)]'
                    : 'bg-[color:var(--bg-selected)] text-[color:var(--text-strong)]'
                  : 'text-[color:var(--text-disabled)] hover:text-[color:var(--text-muted)]'
              }`}
            >
              {PRESET_CHIP_LABEL[option.value]}
            </button>
          </Tooltip>
        )
      })}
    </>
  )
}

// The error-tone Debug Mode toggle in the picker's mode row. An independent
// on/off control sitting beside the permission-preset group — it does not
// change the selected preset. State is signalled by the literal "DEBUG" label
// and aria-pressed, not by color alone, so it reads for non-color users and AT.
export function SpawnDebugToggle({
  active,
  onChange,
}: {
  active: boolean
  onChange: (next: boolean) => void
}) {
  return (
    <Tooltip
      content="Debug mode drives the agent through a file-backed debugging state machine: reproduce, form hypotheses, instrument, then remove all instrumentation before finishing. Works best with the Auto or Bypass permission presets."
      placement="bottom"
      wrapperClassName="ml-auto inline-flex"
    >
      <button
        type="button"
        aria-pressed={active}
        onClick={() => onChange(!active)}
        className={`rounded px-2 py-0.5 text-micro font-medium transition-colors focus-visible:focus-ring ${
          active
            ? 'bg-[color:var(--tone-error)]/12 text-[color:var(--tone-error-on-tint)]'
            : 'text-[color:var(--text-disabled)] hover:text-[color:var(--text-muted)]'
        }`}
      >
        DEBUG
      </button>
    </Tooltip>
  )
}

// Neutral chat glyph for conversation-runtime rows. CliIcon is reserved for
// terminal CLI plugins; a provider-backed agent is a conversation, so it reads
// as a speech bubble rather than a terminal prompt.
export function ConversationProviderIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M5 5.75h14a1.75 1.75 0 0 1 1.75 1.75v7a1.75 1.75 0 0 1-1.75 1.75H10l-3.75 3v-3H5A1.75 1.75 0 0 1 3.25 15.5v-8A1.75 1.75 0 0 1 5 5.75Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
    </svg>
  )
}

// Terminal glyph for the Terminal quick row. Exported so the top bar's session
// list can reuse the same mark for terminal sessions.
export function TerminalSessionIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="4" y="5.5" width="16" height="13" rx="2.2" stroke="currentColor" strokeWidth="1.7" />
      <path d="M7.25 10L10 12.5L7.25 15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12.5 15H16.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}
