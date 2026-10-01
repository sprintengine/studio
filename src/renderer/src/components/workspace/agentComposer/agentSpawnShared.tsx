// Imported from the concrete module rather than the `../../ui` barrel to keep
// this hookless module free of the barrel's whole component graph.
import type React from 'react'
import { MenuOption } from '../../ui/MenuOption'
import { LockGlyph, PresetDialGlyph, SparkGlyph, UnlockedGlyph } from '../../AppIcons'
import type { CliPermissionPreset } from '../../../types/workspace'

// Shared, presentation-only pieces of the agent spawn surfaces (the compact
// SpawnPicker and the New Chat panel). Kept in one hookless module so every
// surface can import them without pulling in the composer's store hook.

// Permission preset chips shown in the picker footer. Exported because the top
// bar's split-button trigger tooltip names the active preset. Bypass leads: it
// is what every agent spawns with unless the person, or their organization,
// chooses otherwise (owner ruling 2026-09-27); the rest follow from least to
// most asking, and No flag, which asks whatever the CLI is configured to, last
// (owner request 2026-09-30 for all four in a chat).
export const AGENT_SPAWN_PERMISSION_OPTIONS: Array<{
  value: CliPermissionPreset
  label: string
  /** One line for a menu row's meta — the row has 280px, not a paragraph. */
  summary: string
  /** The full explanation, for a tooltip. */
  title: string
}> = [
  {
    value: 'bypass',
    label: 'Bypass permissions',
    summary: 'Skip every prompt. Trusted repos only.',
    title: 'Skip CLI permission prompts. Use only in repos and environments you trust.',
  },
  {
    value: 'auto',
    label: 'Auto',
    summary: 'Edits go through; commands and the rest ask.',
    title:
      'Read and edit files in the workspace without asking, and in a chat use your connected MCP tools too. Commands, web access and anything outside the workspace ask first.',
  },
  {
    value: 'manual',
    label: 'Manual',
    summary: 'Asks before every edit and command.',
    title:
      'Ask before every action that changes something or reaches out: each edit, command, web request and MCP tool. Reading and searching the workspace does not ask.',
  },
  {
    value: 'none',
    label: 'No flag',
    summary: 'The CLI’s default — no permission flag is passed.',
    title:
      'Pass no permission flag, so the agent runs on its own configured permissions. That can mean asking for approval, or not.',
  },
]

// Chip-width labels for the preset row. Exhaustive over the union so a preset
// added later fails the build here rather than rendering a blank chip. Exported
// because the model picker's permission footer wears the same short label.
export const PRESET_CHIP_LABEL: Record<CliPermissionPreset, string> = {
  none: 'No flag',
  manual: 'Manual',
  auto: 'Auto',
  bypass: 'Bypass',
}

// Keep stored preset ids stable; only the vocabulary depends on the runtime,
// and only where the runtime means something different by it. A GPT model
// alone does not imply Codex: callers pass the selected agent id.
export function agentPermissionOptions(cli?: string | null): typeof AGENT_SPAWN_PERMISSION_OPTIONS {
  return AGENT_SPAWN_PERMISSION_OPTIONS.map((option) => {
    if (cli === 'codex' && option.value === 'bypass') {
      return {
        ...option,
        label: 'YOLO',
        summary: 'No approvals or sandbox.',
        title: 'Run Codex without approval prompts or sandbox restrictions.',
      }
    }
    if (cli === 'codex' && option.value === 'auto') {
      return {
        ...option,
        summary: 'Workspace sandbox; asks to go past it.',
        title:
          'Codex edits and runs commands inside the workspace sandbox without asking, and asks before it writes outside the workspace or uses the network.',
      }
    }
    if (cli === 'claude-code' && option.value === 'auto') {
      return {
        ...option,
        summary: 'Claude runs what it judges safe; blocks the rest.',
        title:
          'Claude Code’s own auto mode: a classifier runs the tool calls it judges safe and turns the risky ones back to Claude. Where your plan or model does not offer it, Claude asks instead.',
      }
    }
    if (cli === 'cursor' && option.value === 'auto') {
      return {
        ...option,
        summary: 'Cursor runs what it judges safe; asks for the rest.',
        title: 'Cursor’s own auto-review: a classifier runs the tool calls it judges safe and asks for the rest.',
      }
    }
    return option
  })
}

export function agentPermissionChipLabel(preset: CliPermissionPreset, cli?: string | null): string {
  return cli === 'codex' && preset === 'bypass' ? 'YOLO' : PRESET_CHIP_LABEL[preset]
}

// One glyph per preset, a vocabulary that reads at a glance, drawn once in
// AppIcons: an open lock for Bypass, a spark for Auto, a closed lock for
// Manual, a quiet dial for the CLI's own default. All-or-nothing per the menu
// spec's leading-slot rule — every row carries one.
export function PresetGlyph({
  preset,
  className = 'icon-xs shrink-0',
}: {
  preset: CliPermissionPreset
  className?: string
}) {
  if (preset === 'bypass') return <UnlockedGlyph className={className} />
  if (preset === 'auto') return <SparkGlyph className={className} />
  if (preset === 'manual') return <LockGlyph className={className} />
  return <PresetDialGlyph className={className} />
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
// distinct from hover; Bypass keeps warn INK, never a fill.
//
// Roving tabIndex: the checked row is the tab stop, arrows move (the contract
// above). A row in `disabledReasons` stays listed and dimmed with its reason
// as the meta line — a control that vanishes when unavailable teaches nothing.
export function PermissionPresetMenuRows({
  cli,
  value,
  disabled = false,
  disabledReasons,
  onSelect,
}: {
  cli?: string | null
  value: CliPermissionPreset
  /** Locks the rows while a live change is in flight. */
  disabled?: boolean
  /** Rows a target cannot take, each with the one-line reason it shows. */
  disabledReasons?: Partial<Record<CliPermissionPreset, string>>
  onSelect: (preset: CliPermissionPreset) => void
}) {
  return (
    <>
      {agentPermissionOptions(cli).map((option) => {
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
