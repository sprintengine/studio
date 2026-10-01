import React, { type JSX } from 'react'

import {
  ChipButton,
  Popover,
  Tooltip,
  roveMenuFocus,
  setCliPermissionPreset,
  useCliPermissionMode,
  useCliPermissionPreset,
} from '../../ui'
import { ChevronDownIcon } from '../../AppIcons'
import { MENU_GROUP_LABEL_CLASS, MENU_LIST_CLASS } from '../../ui/menuClasses'
import {
  agentPermissionOptions,
  agentPermissionChipLabel,
  focusActivePresetRow,
  PermissionPresetMenuRows,
  PresetGlyph,
  type PermissionModeOption,
} from './agentSpawnShared'
import type { AgentCli, CliPermissionPreset } from '../../../types/workspace'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import {
  conversationPermissionModes,
  conversationPermissionPresetRefusals,
} from '../../../../../shared/conversation-harness'

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
            variant="raised"
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

// The accessible name carries the mode's full name: "Permissions: Bypass
// permissions" says which safeguard is off.
function permissionAccessibleName(
  options: readonly PermissionModeOption[],
  preset: CliPermissionPreset,
  mode: string | null | undefined,
): string {
  return `Permissions: ${agentPermissionChipLabel(options, preset, mode)}`
}

/**
 * The rows a permission menu for `cli` lists: the CLI's modes under its own
 * names, from its manifest. A chat lists only the CLI's own modes its runtime
 * maps (`modes`, a running chat's capability, else what the CLI's chat
 * runtime declares); a preset's own mode is always listed, and a preset the
 * chat cannot run is dimmed by the caller with its reason.
 */
export function usePermissionModeOptions(
  cli: AgentCli | null | undefined,
  launch?: 'chat' | 'terminal',
  chatModes?: readonly string[],
): PermissionModeOption[] {
  const specs = useWorkspaceStore((state) =>
    cli ? state.pluginCatalogEntries.find((entry) => entry.id === cli)?.permissionModes : undefined,
  )
  return React.useMemo(() => {
    const options = agentPermissionOptions(specs)
    if (launch !== 'chat') return options
    const own = chatModes ?? conversationPermissionModes(cli)
    return options.filter((option) => !option.mode || own.includes(option.mode))
  }, [chatModes, cli, launch, specs])
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
  launch,
}: {
  cli: AgentCli
  fallback: CliPermissionPreset
  /**
   * What the launch starts: a chat, or an agent in a terminal. Each can be held
   * to a different set of presets, and the rows it cannot take are dimmed with
   * the reason. Absent, every row is offered.
   */
  launch?: 'chat' | 'terminal'
}): JSX.Element {
  const preset = useCliPermissionPreset(cli, fallback)
  const mode = useCliPermissionMode(cli)
  const options = usePermissionModeOptions(cli, launch)
  const disabledReasons = useLaunchPermissionRefusals(cli, launch)
  return (
    <PermissionFooter
      options={options}
      preset={preset}
      mode={mode}
      disabledReasons={disabledReasons}
      onSelect={(next) => setCliPermissionPreset(cli, next.value, next.mode)}
    />
  )
}

/**
 * The presets a launch of `cli` cannot be held to, each with the one line its
 * row shows. A chat's come from the runtime's own limits
 * (`conversationPermissionPresetRefusals`); a terminal agent's from the presets
 * its manifest names a setting for, which main lists with the plugin. A CLI
 * the catalog has not listed yet dims nothing: the launch refuses a preset it
 * cannot take and says why.
 */
export function useLaunchPermissionRefusals(
  cli: AgentCli,
  launch: 'chat' | 'terminal' | undefined,
): Partial<Record<CliPermissionPreset, string>> | undefined {
  const entry = useWorkspaceStore((state) =>
    launch === 'terminal' ? state.pluginCatalogEntries.find((candidate) => candidate.id === cli) : undefined,
  )
  return React.useMemo(() => {
    if (launch === 'chat') return conversationPermissionPresetRefusals(cli)
    if (launch !== 'terminal' || !entry?.permissionPresets) return undefined
    const declared = entry.permissionPresets
    return Object.fromEntries(
      (['none', 'manual', 'auto', 'bypass'] as const)
        .filter((preset) => !declared.includes(preset))
        .map((preset) => [preset, `${entry.displayName} has no setting for this in a terminal.`]),
    )
  }, [cli, entry, launch])
}

/**
 * The permission dropdown itself, over a value the host owns. The launcher's
 * `SpawnPermissionFooter` binds it to the per-CLI memory, on the picker's
 * trailing row; a running chat binds it to that chat's own preset, which a
 * live session changes in place, as a chip of its own in the chat box. Same
 * chip and same rows either way.
 */
export function PermissionFooter({
  options,
  preset,
  mode,
  onSelect,
  disabled = false,
  disabledReasons,
  placement = 'top-end',
}: {
  /** The CLI's modes, from `usePermissionModeOptions`. */
  options: readonly PermissionModeOption[]
  preset: CliPermissionPreset
  /** The CLI's own mode at `preset`, when it is not the preset's own. */
  mode?: string | null
  onSelect: (next: PermissionModeOption) => void
  /** Locks the rows while a live change is in flight. */
  disabled?: boolean
  /** Rows this agent cannot run, by row id (a preset's own mode is keyed by the preset), each with its reason. */
  disabledReasons?: Partial<Record<string, string>>
  /** Which side the menu opens on: the end of a trailing row, the start of a leading one. */
  placement?: 'top-start' | 'top-end'
}): JSX.Element {
  return (
    <FooterMenu
      ariaLabel={permissionAccessibleName(options, preset, mode)}
      heading="Permissions"
      label={
        <>
          <PresetGlyph preset={preset} />
          {/* The chip names the mode, not the sentence behind it — the surface
              carries no explanatory copy (owner, 2026-08-04). */}
          {agentPermissionChipLabel(options, preset, mode)}
        </>
      }
      // Bypass is WARN, not danger: `danger` is the error tone, and the preset
      // wears amber everywhere else in the app. So is a preset this agent
      // cannot run (an app-wide default a CLI has no setting for), which says
      // why on hover rather than reading as if it would hold.
      tone={preset === 'bypass' || disabledReasons?.[preset] ? 'warn' : 'quiet'}
      {...(disabledReasons?.[preset] ? { tooltip: disabledReasons[preset] } : {})}
      placement={placement}
      chevron
      // The rows need the width their summaries were written for, and they land
      // focus on the checked row.
      surfaceClassName={`w-[280px] ${MENU_LIST_CLASS}`}
      bodyClassName="w-full"
      onOpenAutoFocus={focusActivePresetRow}
    >
      {(close) => (
        <PermissionPresetMenuRows
          options={options}
          value={preset}
          mode={mode}
          disabled={disabled}
          disabledReasons={disabledReasons}
          onSelect={(next) => {
            onSelect(next)
            close()
          }}
        />
      )}
    </FooterMenu>
  )
}
