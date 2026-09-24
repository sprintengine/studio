import React, { type JSX } from 'react'

import { ChipButton, Popover, Tooltip, roveMenuFocus, setCliPermissionPreset, useCliPermissionPreset } from '../../ui'
import { ChevronDownIcon } from '../../AppIcons'
import { MENU_GROUP_LABEL_CLASS, MENU_LIST_CLASS } from '../../ui/menuClasses'
import {
  agentPermissionOptions,
  agentPermissionChipLabel,
  focusActivePresetRow,
  PermissionPresetMenuRows,
} from './agentSpawnShared'
import type { AgentCli, CliPermissionPreset } from '../../../types/workspace'

// The model picker's footer controls — the row of trailing settings a spawn
// surface hands `CliModelPopoverSurface` through its `footer` slot.
//
// One trigger implementation, so ⋯ and Permissions cannot drift into two chips
// that merely resemble each other. It lives here rather than inside
// any one host because three surfaces now open the picker: the New chat launch
// surface, the spawn picker, and a Backlog item's "Hand to agent".

/**
 * A footer chip that opens a menu. `children` receives a `close` so a row can
 * dismiss the menu it was chosen from.
 *
 * `bodyClassName` / `onOpenAutoFocus` exist for the permissions menu, whose
 * rows are wider than a plain value list and land focus on the checked row;
 * everything else takes the compact defaults.
 */
export function FooterMenu({
  ariaLabel,
  heading,
  label,
  tone,
  placement,
  tooltip,
  chevron,
  surfaceClassName,
  bodyClassName,
  onOpenAutoFocus,
  children,
}: {
  ariaLabel: string
  heading?: string
  label: React.ReactNode
  tone: 'quiet' | 'accent' | 'warn'
  placement: 'top-start' | 'top-end'
  tooltip?: string
  /** Draw the dropdown caret. For a chip that carries a VALUE and opens a menu
   *  of values — it has to read as the same kind of control as the effort
   *  selector it now sits beside. A chip that is an action (⋯) takes none. */
  chevron?: boolean
  surfaceClassName?: string
  bodyClassName?: string
  onOpenAutoFocus?: (surface: HTMLElement) => void
  children: (close: () => void) => React.ReactNode
}): JSX.Element {
  const [open, setOpen] = React.useState(false)
  const surfaceRef = React.useRef<HTMLDivElement | null>(null)
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      ariaLabel={ariaLabel}
      popupRole="menu"
      placement={placement}
      surfaceClassName={surfaceClassName ?? MENU_LIST_CLASS}
      {...(onOpenAutoFocus ? { onOpenAutoFocus } : {})}
      renderTrigger={({ ref, triggerProps, togglePopover }) => {
        // The tooltip wraps the BUTTON, never the Popover: it attaches its
        // handlers by cloning its child, and a component that does not forward
        // them swallows the tooltip silently.
        const button = (
          // The kit's chip. The two tinted tones travel as `tint` — the
          // prop that paints an ink and a 12%-of-the-same ground, which is
          // exactly what `--tone-warn/12` and `--accent-primary-soft` were —
          // rather than as a className, so there is no second `bg-` for a
          // stylesheet to choose between. `quiet` takes the default subtle
          // tone and its `--bg-hover` lift.
          <ChipButton
            ref={ref}
            tint={tone === 'warn' ? 'var(--tone-warn)' : tone === 'accent' ? 'var(--accent-primary)' : undefined}
            aria-label={ariaLabel}
            onClick={togglePopover}
            className="shrink-0"
            {...triggerProps}
          >
            {label}
            {chevron ? <ChevronDownIcon className="size-icon-xs shrink-0 text-[color:var(--text-disabled)]" /> : null}
          </ChipButton>
        )
        return tooltip ? (
          <Tooltip content={tooltip} placement="top">
            {button}
          </Tooltip>
        ) : (
          button
        )
      }}
    >
      <div
        ref={surfaceRef}
        className={bodyClassName ?? 'min-w-[168px]'}
        // The preset rows own their own keyboard contract; the compact bodies
        // borrow the shared menu rove.
        {...(onOpenAutoFocus
          ? {}
          : { onKeyDown: (event: React.KeyboardEvent) => roveMenuFocus(event, surfaceRef.current) })}
      >
        {heading ? <p className={MENU_GROUP_LABEL_CLASS}>{heading}</p> : null}
        {children(() => setOpen(false))}
      </div>
    </Popover>
  )
}

// The chip names the preset, not the sentence behind it — the surface carries
// no explanatory copy (owner, 2026-08-04). It reads the exhaustive chip labels
// the preset rows use, so a preset it cannot tell apart from its neighbour is a
// preset the person cannot see they are on.
function permissionLabel(preset: CliPermissionPreset, cli: AgentCli): string {
  return agentPermissionChipLabel(preset, cli)
}

// The accessible name carries the full option label, not the chip's short one:
// "Permissions: Bypass permissions" says which safeguard is off, where the chip
// only has room for a word.
function permissionAccessibleName(preset: CliPermissionPreset, cli: AgentCli): string {
  const option = agentPermissionOptions(cli).find((entry) => entry.value === preset)
  return `Permissions: ${option?.label ?? preset}`
}

/**
 * Permissions for the CLI of the row the picker is currently on — a dropdown at the
 * trailing end of the picker's one row, sitting immediately right of the effort
 * dropdown (owner, 2026-09-05). Two controls of the same kind, on the same
 * line: effort on the left, permissions on the right.
 *
 * A menu rather than an inline strip, deliberately. Each preset carries a
 * sentence explaining what it does — and one of them turns a safeguard off —
 * which is exactly the case the design system sends to radio rows rather than a
 * segmented control ("longer labels, or choices that need a hint sentence each,
 * belong to radio rows"). The rows are the ones the live-agent pill opens, so
 * there is one rendering of the choice in the app, not two.
 *
 * The value is remembered PER CLI (`cliPermissionPresets`), not once for the
 * app and not per model: the preset is a property of the runtime the row
 * names, which is why this control moved inside the picker rather than
 * standing beside it, and choosing it on one Claude Code model chooses it for
 * every Claude Code model. A CLI nobody has set reads `fallback` — the
 * app-wide default Settings still owns — so nothing moves until someone
 * chooses here.
 */
export function SpawnPermissionFooter({
  cli,
  fallback,
  disabledReasons,
  shown,
  onSelect,
}: {
  cli: AgentCli
  fallback: CliPermissionPreset
  /** Presets this target cannot take, each with the one line it dims with. */
  disabledReasons?: Partial<Record<CliPermissionPreset, string>>
  /**
   * What the chip shows for the stored preset, when this target launches on
   * something else — a remote machine narrows Bypass to Auto for its own launch
   * without rewriting the choice every local launch of the CLI reads.
   */
  shown?: (stored: CliPermissionPreset) => CliPermissionPreset
  /** Notified after the CLI's preset is written (the remote note clears on it). */
  onSelect?: (preset: CliPermissionPreset) => void
}): JSX.Element {
  const stored = useCliPermissionPreset(cli, fallback)
  const preset = shown ? shown(stored) : stored
  return (
    <FooterMenu
      ariaLabel={permissionAccessibleName(preset, cli)}
      heading="Permissions"
      label={permissionLabel(preset, cli)}
      // Bypass is WARN, not danger: `danger` is the error tone, and the preset
      // wears amber everywhere else in the app.
      tone={preset === 'bypass' ? 'warn' : preset === 'auto' ? 'accent' : 'quiet'}
      placement="top-end"
      chevron
      // The rows need the width their summaries were written for, and they land
      // focus on the checked row.
      surfaceClassName={`w-[280px] ${MENU_LIST_CLASS}`}
      bodyClassName="w-full"
      onOpenAutoFocus={focusActivePresetRow}
    >
      {(close) => (
        <PermissionPresetMenuRows
          cli={cli}
          value={preset}
          {...(disabledReasons ? { disabledReasons } : {})}
          onSelect={(next) => {
            setCliPermissionPreset(cli, next)
            onSelect?.(next)
            close()
          }}
        />
      )}
    </FooterMenu>
  )
}
