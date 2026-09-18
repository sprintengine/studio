// Imported from the concrete module rather than the `../../ui` barrel to keep
// this hookless module free of the barrel's whole component graph.
import type React from 'react'
import { Tooltip } from '../../ui/Tooltip'
import { ChipButton } from '../../ui/ChipButton'
import { DefaultChip } from '../../ui/DefaultChip'
import { MenuOption } from '../../ui/MenuOption'
import { LockGlyph, PresetDialGlyph, SparkGlyph, UnlockedGlyph } from '../../AppIcons'
import type { CliPermissionPreset } from '../../../types/workspace'

// Shared, presentation-only pieces of the agent spawn surfaces (the compact
// SpawnPicker and the New Chat panel). Kept in one hookless module so every
// surface can import them without pulling in the composer's store hook.

// Permission preset chips shown in the picker footer. Exported because the top
// bar's split-button trigger tooltip names the active preset.
export const AGENT_SPAWN_PERMISSION_OPTIONS: Array<{
  value: CliPermissionPreset
  label: string
  /** One line for a menu row's meta — the row has 280px, not a paragraph. */
  summary: string
  /** The full explanation, for a tooltip. */
  title: string
}> = [
  {
    value: 'none',
    label: 'None',
    summary: 'No flag — the CLI decides.',
    title:
      'Pass no permission flag and let the CLI choose. Claude Code now starts in auto mode on Pro, Max and Team plans, so this is no longer the same as asking every time.',
  },
  {
    value: 'manual',
    label: 'Manual',
    summary: 'Ask before every action.',
    title: 'Ask before every action.',
  },
  {
    value: 'auto',
    label: 'Auto',
    summary: 'Run without asking; the CLI’s own safety checks stay on.',
    title:
      'Run without stopping to ask, with the CLI’s own safety checks — a classifier on Claude Code, a workspace sandbox on Codex.',
  },
  {
    value: 'bypass',
    label: 'Bypass permissions',
    summary: 'Skip every prompt. Trusted repos only.',
    title: 'Skip CLI permission prompts. Use only in repos and environments you trust.',
  },
]

// Chip-width labels for the preset row. Exhaustive over the union so a preset
// added later fails the build here rather than rendering a blank chip. Exported
// because the model picker's permission footer wears the same short label.
export const PRESET_CHIP_LABEL: Record<CliPermissionPreset, string> = {
  none: 'None',
  manual: 'Manual',
  auto: 'Auto',
  bypass: 'Bypass',
}

// One glyph per preset, a vocabulary that reads at a glance, drawn once in
// AppIcons: quiet dial for the CLI's own default, a closed lock for Manual, a
// spark for Auto, an open lock for Bypass. All-or-nothing per the menu spec's
// leading-slot rule — every row carries one.
function PresetGlyph({ preset }: { preset: CliPermissionPreset }) {
  const className = 'icon-xs shrink-0'
  if (preset === 'manual') return <LockGlyph className={className} />
  if (preset === 'auto') return <SparkGlyph className={className} />
  if (preset === 'bypass') return <UnlockedGlyph className={className} />
  return <PresetDialGlyph className={className} />
}

/**
 * What a remote gateway will actually take (remote-sessions-ux /
 * new-chat-on-a-remote-machine). The gateway's `terminal.create` accepts
 * exactly `manual` and `auto` (`LAUNCH_PERMISSION_PRESETS` in
 * automation-tools.ts): `bypass` is refused with its own code, and `none`
 * cannot travel at all — it means "send no flag", which on the wire becomes
 * an omitted field the REMOTE machine fills with its own spawn default. A
 * person who picked "CLI default" would get whatever the other machine last
 * chose, so neither is offered for a remote target; a value the gateway would
 * refuse must never be learned about after a network round-trip.
 */
export const REMOTE_PERMISSION_PRESETS: ReadonlySet<CliPermissionPreset> = new Set(['manual', 'auto'])

const REMOTE_PRESET_UNAVAILABLE_REASON = 'Not available on a remote machine'

/** The row reasons a remote target disables, keyed by preset. */
export const REMOTE_PRESET_DISABLED_REASONS: Partial<Record<CliPermissionPreset, string>> = {
  none: REMOTE_PRESET_UNAVAILABLE_REASON,
  bypass: REMOTE_PRESET_UNAVAILABLE_REASON,
}

/**
 * Where a preset lands when a remote target cannot take it: the nearest
 * supported neighbour in strictness. `none` (the CLI's own choice, usually
 * asking) moves to Manual; `bypass` moves DOWN to Auto rather than up to
 * nothing — the remote would clamp to Manual anyway, and Auto is the closest
 * the surface can honestly offer.
 */
export function nearestRemotePermissionPreset(preset: CliPermissionPreset): CliPermissionPreset {
  if (REMOTE_PERMISSION_PRESETS.has(preset)) return preset
  return preset === 'bypass' ? 'auto' : 'manual'
}

const PRESET_ROW_SELECTOR = '[data-preset-option="true"]'

/**
 * Land focus on the checked preset row when a host opens the menu — the
 * surface is portaled to <body>, so Tab from the trigger would never reach the
 * rows. Shared by the chat composer's pill and the launch panel's pill through
 * `Popover`'s `onOpenAutoFocus`. Popover paints its surface `visibility:
 * hidden` until measured and a hidden element cannot take focus, so the call
 * retries on the next frame once the surface is visible (only jsdom focuses a
 * hidden element, which is why a passing unit test could not see this).
 */
export function focusActivePresetRow(surface: HTMLElement): void {
  const rows = Array.from(surface.querySelectorAll<HTMLButtonElement>(PRESET_ROW_SELECTOR))
  const target =
    rows.find((row) => row.getAttribute('aria-checked') === 'true' && !row.disabled) ??
    rows.find((row) => !row.disabled)
  if (!target) return
  target.focus()
  if (document.activeElement === target) return
  requestAnimationFrame(() => {
    if (surface.isConnected) target.focus()
  })
}

/**
 * The menu spec's keyboard contract for a list of `menuitemradio` rows
 * (design-system/components/menu, "Accessibility"): ArrowUp/ArrowDown move and
 * wrap, Home/End jump to the ends, disabled rows are skipped so the walk only
 * lands on rows that do something, and Enter/Space activate the row under
 * focus. Escape is left alone — the Popover listens for it on `document` and
 * returns focus to the trigger. Every other key stops here: the surface is
 * portaled, but React bubbles through the REACT tree, which can run back
 * through a host row that treats Enter as "select me".
 *
 * Rows are found by `selector` inside `surface` (the closest `[role="menu"]`
 * to the row), so any host list of radio rows can adopt the contract by
 * spelling the selector on its rows and calling this from `onKeyDown`.
 */
export function menuRadioRowKeyDown(
  event: React.KeyboardEvent<HTMLButtonElement>,
  selector: string,
  activate: () => void,
): void {
  if (event.key === 'Escape') return
  event.stopPropagation()
  const current = event.currentTarget
  const surface = current.closest<HTMLElement>('[role="menu"]') ?? current.parentElement
  const rows = Array.from(surface?.querySelectorAll<HTMLButtonElement>(selector) ?? []).filter((row) => !row.disabled)
  const index = rows.indexOf(current)
  const focusAt = (next: number): void => {
    if (rows.length === 0) return
    rows[((next % rows.length) + rows.length) % rows.length]?.focus()
  }
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    focusAt(index + 1)
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    focusAt(index - 1)
  } else if (event.key === 'Home') {
    event.preventDefault()
    focusAt(0)
  } else if (event.key === 'End') {
    event.preventDefault()
    focusAt(rows.length - 1)
  } else if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    if (!current.disabled) activate()
  }
}

// The permission choice as the menu spec's STACKED items — glyph on the first
// line, `body` name, one-line `meta` summary — shared by the chat composer's
// pill and the launch panel's pill so one choice never renders two ways
// (remote-sessions-ux / selector-menus-premium; the chip row above stays the
// compact in-line form for footers). Selection is `bg.selected` + a check,
// distinct from hover; Bypass keeps warn INK, never a fill. The CLI-default
// row wears the same quiet Default chip the reasoning selector uses: it is
// the runtime's own choice, a fact about the option rather than a status.
//
// Roving tabIndex: the checked row is the tab stop, arrows move (the contract
// above). A row in `disabledReasons` stays listed and dimmed with its reason
// as the meta line — a control that vanishes when unavailable teaches nothing.
export function PermissionPresetMenuRows({
  value,
  disabled = false,
  disabledReasons,
  onSelect,
}: {
  value: CliPermissionPreset
  /** Locks the rows while a live change is in flight. */
  disabled?: boolean
  /** Rows a target cannot take, each with the one-line reason it shows. */
  disabledReasons?: Partial<Record<CliPermissionPreset, string>>
  onSelect: (preset: CliPermissionPreset) => void
}) {
  return (
    <>
      {AGENT_SPAWN_PERMISSION_OPTIONS.map((option) => {
        const active = option.value === value
        const isBypass = option.value === 'bypass'
        const reason = disabledReasons?.[option.value] ?? null
        const rowDisabled = disabled || reason !== null
        return (
          // The kit's value row in its stacked shape. Bypass's warn ink moves
          // onto the row's OWN title span rather than staying on the button: as
          // a caller className it met the primitive's resting and selected inks
          // at equal specificity, and which one painted was stylesheet order.
          <MenuOption
            key={option.value}
            role="menuitemradio"
            selected={active}
            stacked
            data-preset-option="true"
            tabIndex={active ? 0 : -1}
            disabled={rowDisabled}
            onKeyDown={(event) => menuRadioRowKeyDown(event, PRESET_ROW_SELECTOR, () => onSelect(option.value))}
            onClick={() => onSelect(option.value)}
            icon={
              <span className="mt-0.5 inline-flex shrink-0">
                <PresetGlyph preset={option.value} />
              </span>
            }
            trailing={
              active ? (
                <svg
                  viewBox="0 0 16 16"
                  fill="none"
                  aria-hidden="true"
                  className="mt-0.5 icon-xs shrink-0 text-[color:var(--accent-primary)]"
                >
                  <path
                    d="M3.5 8.5L6.5 11.5L12.5 4.5"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              ) : null
            }
          >
            <span
              className={`flex items-center gap-1.5 text-body font-medium ${
                isBypass ? 'text-[color:var(--tone-warn)]' : 'text-[color:var(--text-strong)]'
              }`}
            >
              <span className="min-w-0 truncate">{option.label}</span>
              {option.value === 'none' ? <DefaultChip /> : null}
            </span>
            <span className="block text-meta leading-snug text-[color:var(--text-subtle)]">
              {reason ?? option.summary}
            </span>
          </MenuOption>
        )
      })}
    </>
  )
}

// The error-tone Debug Mode toggle in the picker's mode row. An independent
// on/off control sitting beside the permission-preset group — it does not
// change the selected preset. State is signalled by the literal "DEBUG" label
// and aria-pressed, not by color alone, so it reads for non-color users and AT.
export function SpawnDebugToggle({ active, onChange }: { active: boolean; onChange: (next: boolean) => void }) {
  return (
    <Tooltip
      content="Debug mode drives the agent through a file-backed debugging state machine: reproduce, form hypotheses, instrument, then remove all instrumentation before finishing. Works best with the Auto or Bypass permission presets."
      placement="bottom"
      wrapperClassName="ml-auto inline-flex"
    >
      {/* The permission chips' toggle, in the error tone: a thrown DEBUG keeps
          its own tint, because a state that went neutral would stop saying what
          it says. Quiet until thrown, so it does not shout from the row. */}
      <ChipButton tone={active ? 'error' : 'subtle'} pressed={active} onClick={() => onChange(!active)}>
        DEBUG
      </ChipButton>
    </Tooltip>
  )
}

// Terminal glyph for the Terminal quick row. Exported so the top bar's session
// list can reuse the same mark for terminal sessions.
export function TerminalSessionIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="4" y="5.5" width="16" height="13" rx="2.2" stroke="currentColor" strokeWidth="1.7" />
      <path
        d="M7.25 10L10 12.5L7.25 15"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M12.5 15H16.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}
