import React from 'react'
// Imported from the concrete modules rather than the `../../ui` barrel: the
// barrel re-exports CliModelListbox, which imports ReasoningLevelPicker from
// here, so going through it would make this module part of an import cycle.
import { Popover } from '../../ui/Popover'
import { Tooltip } from '../../ui/Tooltip'
import { FOCUS_RING_CLASS } from '../../ui/tokens'
import type { SprintEngineCliPermissionPreset } from '../../../types/workspace'
import type { PluginReasoningOption } from '../../../../../shared/plugin-manifest'

// Shared, presentation-only pieces of the agent picker surfaces (the compact
// AgentComposerPopover and the AgentComposer panel). Kept in one hookless module
// so every surface can import them without pulling in the composer's store hook.

// Permission preset chips shown in the picker footer. Exported because the top
// bar's split-button trigger tooltip names the active preset.
export const AGENT_SPAWN_PERMISSION_OPTIONS: Array<{
  value: SprintEngineCliPermissionPreset
  label: string
  title: string
}> = [
  {
    value: 'default',
    label: 'Default permissions',
    title: 'Use the CLI default permission behavior.',
  },
  {
    value: 'auto_workspace',
    label: 'Auto in workspace',
    title: 'Reduce prompts while keeping workspace-scoped guardrails where the CLI supports them.',
  },
  {
    value: 'bypass_all',
    label: 'Bypass permissions',
    title: 'Skip CLI permission prompts. Use only in repos and environments you trust.',
  },
]

// The Default / Auto / Bypass preset chip row — the one interactive permission
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
        const isBypass = option.value === 'bypass_all'
        return (
          <Tooltip key={option.value} content={option.title} placement="bottom">
            <button
              type="button"
              aria-pressed={active}
              disabled={disabled}
              onClick={() => onChange(option.value)}
              className={`rounded px-2 py-0.5 text-[11px] font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-primary)] disabled:cursor-not-allowed disabled:opacity-50 ${
                active
                  ? isBypass
                    ? 'bg-[color:var(--tone-warn)]/12 text-[color:var(--tone-warn-on-tint)]'
                    : 'bg-[color:var(--accent-primary-soft)] text-[color:var(--text-strong)]'
                  : 'text-[color:var(--text-disabled)] hover:text-[color:var(--text-muted)]'
              }`}
            >
              {option.value === 'default' ? 'Default' : option.value === 'auto_workspace' ? 'Auto' : 'Bypass'}
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
        className={`rounded px-2 py-0.5 text-[11px] font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--tone-error)] ${
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

// The inline reasoning-effort picker that rides the right edge of the selected
// model row (MC-1884). Blank is the CLI's own default effort and passes no
// flag, so the at-rest state is an em-dash and a caret — nothing names it,
// because a control that needs a sentence is the wrong control. Picking the
// checked level again clears the stored level back to blank, so clearing is the
// same gesture as choosing.
//
// The menu is a real Popover: portaled to <body> at fixed coordinates, so it can
// never be clipped by the listbox's max-h scroll clamp, and it flips above the
// trigger by itself when the row sits near the bottom edge.
//
// Hosts opt in per CLI — a CLI whose manifest declares no reasoningSelection has
// no levels and therefore never renders this control, not even greyed.

const REASONING_OPTION_SELECTOR = '[data-reasoning-option="true"]'

// The costliest level is the last one the manifest declares (Codex `ultra`,
// claude-code `max`). Derived rather than listed, so a manifest that adds a
// level above the current top tones the new one without a code change.
export function costliestReasoningLevel(levels: ReadonlyArray<PluginReasoningOption>): string | undefined {
  return levels[levels.length - 1]?.id
}

export function ReasoningLevelPicker({
  levels,
  value,
  onSelect,
  className,
}: {
  levels: ReadonlyArray<PluginReasoningOption>
  /** The stored level, or undefined for "the CLI's own default effort". */
  value: string | undefined
  /** `null` clears the stored level back to blank. */
  onSelect: (reasoning: string | null) => void
  className?: string
}): JSX.Element | null {
  const [open, setOpen] = React.useState(false)
  const surfaceRef = React.useRef<HTMLElement | null>(null)
  if (levels.length === 0) return null

  const costliest = costliestReasoningLevel(levels)
  const selected = levels.find((level) => level.id === value)
  const selectedLabel = selected ? selected.label ?? selected.id : undefined
  const isCostliest = Boolean(selected) && selected!.id === costliest

  const focusChecked = (surface: HTMLElement) => {
    surfaceRef.current = surface
    const checked = surface.querySelector<HTMLButtonElement>(`${REASONING_OPTION_SELECTOR}[data-checked="true"]`)
    ;(checked ?? surface.querySelector<HTMLButtonElement>(REASONING_OPTION_SELECTOR))?.focus()
  }
  const focusByOffset = (current: HTMLElement, offset: 1 | -1) => {
    const nodes = Array.from(
      surfaceRef.current?.querySelectorAll<HTMLButtonElement>(REASONING_OPTION_SELECTOR) ?? [],
    )
    const index = nodes.indexOf(current as HTMLButtonElement)
    if (index < 0 || nodes.length === 0) return
    nodes[(index + offset + nodes.length) % nodes.length]?.focus()
  }
  const onOptionKey = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      focusByOffset(event.currentTarget, 1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      focusByOffset(event.currentTarget, -1)
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      // The accessible name carries the control's meaning so the visible
      // surface can stay wordless.
      ariaLabel="Reasoning effort"
      popupRole="menu"
      placement="bottom-end"
      className={`shrink-0 ${className ?? ''}`}
      surfaceClassName="min-w-[7rem] p-1"
      onOpenAutoFocus={focusChecked}
      renderTrigger={({ ref, togglePopover, triggerProps }) => (
        <button
          ref={ref}
          type="button"
          {...triggerProps}
          data-reasoning-picker="true"
          aria-label={selectedLabel ? `Reasoning effort: ${selectedLabel}` : 'Reasoning effort'}
          // The row owns selection; opening the picker must not re-select or
          // close the listbox underneath it.
          onClick={(event) => {
            event.stopPropagation()
            togglePopover()
          }}
          onKeyDown={(event) => event.stopPropagation()}
          className={[
            'interactive inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-[3px]',
            'border border-transparent px-1.5 py-px text-[11px] transition-colors',
            'hover:border-[color:var(--border-default)]',
            FOCUS_RING_CLASS,
            selectedLabel
              ? isCostliest
                ? 'font-medium text-[color:var(--tone-warn-on-tint)]'
                : 'font-medium text-[color:var(--text-strong)]'
              : 'text-[color:var(--text-subtle)] hover:text-[color:var(--text-default)]',
          ].join(' ')}
        >
          <span aria-hidden="true">{selectedLabel ?? '—'}</span>
          <span aria-hidden="true" className="text-[8px] text-[color:var(--text-disabled)]">
            ▾
          </span>
        </button>
      )}
    >
      {levels.map((level) => {
        const checked = level.id === value
        const warn = level.id === costliest
        return (
          <button
            key={level.id}
            type="button"
            role="menuitemradio"
            aria-checked={checked}
            data-reasoning-option="true"
            data-checked={checked || undefined}
            // Radiogroup roving: the checked level is the tab stop, arrows move.
            tabIndex={checked ? 0 : -1}
            onKeyDown={onOptionKey}
            onClick={(event) => {
              event.stopPropagation()
              // Re-selecting the checked level clears it — the same gesture
              // chooses and un-chooses, so blank needs no separate control.
              onSelect(checked ? null : level.id)
              setOpen(false)
            }}
            className={[
              'flex w-full items-center gap-1.5 rounded-[3px] px-2 py-1 text-left text-[11px]',
              'hover:bg-[color:var(--bg-hover)]',
              FOCUS_RING_CLASS,
              // The costliest level carries the warn tone inside the menu, so it
              // reads as expensive before it is chosen rather than after.
              warn ? 'text-[color:var(--tone-warn-on-tint)]' : 'text-[color:var(--text-default)]',
            ].join(' ')}
          >
            <span className="flex shrink-0 items-center justify-center text-[color:var(--accent-primary)]">
              {checked ? <ReasoningCheckGlyph /> : null}
            </span>
            <span className="min-w-0 flex-1 truncate">{level.label ?? level.id}</span>
          </button>
        )
      })}
    </Popover>
  )
}

function ReasoningCheckGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="icon-xs" aria-hidden="true">
      <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
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
