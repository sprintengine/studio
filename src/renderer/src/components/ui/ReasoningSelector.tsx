import React from 'react'

import { ChevronDownIcon } from '../AppIcons'
import { Popover } from './Popover'
import {
  MENU_DIVIDER_CLASS,
  MENU_GROUP_LABEL_CLASS,
  MENU_ITEM_CLASS,
  MENU_LIST_CLASS,
} from './menuClasses'
import { FOCUS_RING_CLASS } from './tokens'
import type { CliModelFamily } from './cliRuntimeCatalog'
import type { PluginReasoningCatalog, PluginReasoningOption } from '../../../../shared/plugin-manifest'

// The runtime's second control: how hard the model thinks, and how much it can
// hold. It sits beside the model trigger rather than inside the model list,
// because effort and context window are axes OF a chosen model, not more
// models. The trigger composes both — "High · 1M" — so the row states the whole
// runtime without opening anything.
//
// Both groups are earned, never assumed: the Reasoning group renders only for a
// CLI whose manifest declares levels, and the Context window group only for a
// model the catalog actually ships at more than one window. A CLI with neither
// renders no control at all — not a greyed one, not an empty menu.

const REASONING_OPTION_SELECTOR = '[data-reasoning-option="true"]'

// The costliest level is the last one the manifest declares (Codex `ultra`,
// claude-code `max`). Derived rather than listed, so a manifest that adds a
// level above the current top tones the new one without a code change.
export function costliestReasoningLevel(levels: ReadonlyArray<PluginReasoningOption>): string | undefined {
  return levels[levels.length - 1]?.id
}

// Blank reasoning passes no flag, so the CLI's own default effort wins. The
// trigger has to say something, and "Auto" is what that is — the choice was
// left to the runtime.
const UNSET_LEVEL_LABEL = 'Auto'

export type ReasoningAxes = {
  /** The CLI's declared levels, or undefined when it declares none. */
  reasoningSelection?: PluginReasoningCatalog
  /** The selected model's family, or undefined when no catalog model is selected. */
  family?: CliModelFamily
  /** False on hosts that do not persist a level; the Reasoning group is then not offered. */
  reasoningEnabled: boolean
}

function offeredLevels({
  reasoningSelection,
  reasoningEnabled,
}: ReasoningAxes): ReadonlyArray<PluginReasoningOption> {
  return reasoningEnabled ? reasoningSelection?.levels ?? [] : []
}

function offeredWindows({ family }: ReasoningAxes): ReadonlyArray<CliModelFamily['variants'][number]> {
  return family && family.variants.length > 1 ? family.variants : []
}

// Whether this runtime has anything to select. Hosts that place the selector in
// their own chrome (a bordered trailing row) ask first, so the chrome is never
// drawn around nothing.
export function hasReasoningAxes(axes: ReasoningAxes): boolean {
  return offeredLevels(axes).length > 0 || offeredWindows(axes).length > 0
}

// The trigger's label, exported so a host can name the control in a tooltip
// without re-deriving the composition.
export function reasoningTriggerLabel(
  axes: ReasoningAxes & { reasoning?: string; model?: string },
): string {
  const parts: string[] = []
  const levels = offeredLevels(axes)
  if (levels.length > 0) {
    const level = levels.find((entry) => entry.id === axes.reasoning)
    parts.push(level ? level.label ?? level.id : UNSET_LEVEL_LABEL)
  }
  const windows = offeredWindows(axes)
  if (windows.length > 0) {
    parts.push((windows.find((entry) => entry.id === axes.model) ?? windows[0]!).label)
  }
  return parts.join(' · ')
}

export function ReasoningSelector({
  ariaLabel,
  reasoningSelection,
  reasoning,
  onSelectReasoning,
  family,
  model,
  onSelectModel,
  disabled,
  quiet,
}: Omit<ReasoningAxes, 'reasoningEnabled'> & {
  ariaLabel: string
  /** The stored level, or undefined for "the CLI's own default effort". */
  reasoning?: string
  /** Set only by hosts that persist a level; without it no Reasoning group is offered. */
  onSelectReasoning?: (reasoning: string | null) => void
  /** The selected catalog model id. */
  model?: string
  /** Picking a context window selects that window's catalog id. */
  onSelectModel: (model: string) => void
  disabled?: boolean
  /** Low-emphasis form for dense in-row hosts, matching the model trigger. */
  quiet?: boolean
}): JSX.Element | null {
  const [open, setOpen] = React.useState(false)
  const surfaceRef = React.useRef<HTMLElement | null>(null)
  const triggerRef = React.useRef<HTMLButtonElement | null>(null)

  const axes: ReasoningAxes = {
    reasoningSelection,
    family,
    reasoningEnabled: Boolean(onSelectReasoning),
  }
  const levels = offeredLevels(axes)
  const variants = offeredWindows(axes)
  if (levels.length === 0 && variants.length === 0) return null

  // Two groups is what earns the headings; one group is its own label and the
  // menu's accessible name carries it.
  const grouped = levels.length > 0 && variants.length > 0
  const costliest = costliestReasoningLevel(levels)
  const label = reasoningTriggerLabel({ ...axes, reasoning, model })

  const focusChecked = (surface: HTMLElement) => {
    surfaceRef.current = surface
    const checked = surface.querySelector<HTMLButtonElement>(
      `${REASONING_OPTION_SELECTOR}[data-checked="true"]`,
    )
    const target = checked ?? surface.querySelector<HTMLButtonElement>(REASONING_OPTION_SELECTOR)
    if (!target) return
    target.focus()
    // Popover paints its surface `visibility: hidden` until it has measured and
    // anchored it, and a hidden element cannot take focus — so in a real browser
    // the call above lands nowhere and focus stays stranded on the trigger.
    // Retrying on the next frame, once the surface is visible, is what makes the
    // menu keyboard-operable. Only jsdom focuses a hidden element, which is why
    // a passing unit test could not see this.
    if (document.activeElement === target) return
    requestAnimationFrame(() => {
      if (surfaceRef.current === surface && surface.isConnected) target.focus()
    })
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
    // The surface is portaled to <body>, but React still bubbles its events
    // through the REACT tree — which can run back through a host row that treats
    // Enter/Space as "select me". Keeping the menu's keys to itself is what lets
    // a level be chosen from the keyboard at all. Escape is the exception: the
    // Popover listens for it on `window`.
    if (event.key !== 'Escape') event.stopPropagation()
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      focusByOffset(event.currentTarget, 1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      focusByOffset(event.currentTarget, -1)
    }
  }
  const choose = (apply: () => void) => {
    apply()
    setOpen(false)
    // Choosing unmounts the menu, and with it the focused item — focus would
    // fall to <body>, stranding a keyboard user outside the control they were
    // just operating. Hand it back to the trigger, which is where Escape
    // already returns it.
    triggerRef.current?.focus()
  }

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      ariaLabel={ariaLabel}
      popupRole="menu"
      placement="bottom-start"
      className="shrink-0"
      surfaceClassName={`w-[220px] ${MENU_LIST_CLASS}`}
      onOpenAutoFocus={focusChecked}
      renderTrigger={({ ref, togglePopover, triggerProps }) => (
        <button
          ref={(node) => {
            ref.current = node
            triggerRef.current = node
          }}
          type="button"
          {...triggerProps}
          data-reasoning-trigger="true"
          disabled={disabled}
          aria-label={`${ariaLabel}: ${label}`}
          onClick={(event) => {
            event.stopPropagation()
            togglePopover()
          }}
          onKeyDown={(event) => event.stopPropagation()}
          className={[
            'interactive inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[5px]',
            quiet
              ? 'h-6 border border-transparent px-1.5 text-micro text-[color:var(--text-muted)]'
              : 'h-control-xs border border-transparent px-2 text-meta font-medium text-[color:var(--text-muted)]',
            'hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-default)]',
            'disabled:cursor-not-allowed disabled:opacity-45',
            FOCUS_RING_CLASS,
          ].join(' ')}
        >
          <span>{label}</span>
          <ChevronDownIcon className="size-icon-xs shrink-0 text-[color:var(--text-disabled)]" />
        </button>
      )}
    >
      {levels.length > 0 ? (
        <ReasoningGroup heading={grouped ? 'Reasoning' : undefined}>
          <ReasoningMenuItem
            checked={!reasoning}
            onKeyDown={onOptionKey}
            onSelect={() => choose(() => onSelectReasoning!(null))}
          >
            {UNSET_LEVEL_LABEL}
          </ReasoningMenuItem>
          {levels.map((level) => (
            <ReasoningMenuItem
              key={level.id}
              checked={level.id === reasoning}
              defaultChip={level.id === reasoningSelection?.default}
              // The costliest level carries the warn tone inside the menu, so it
              // reads as expensive before it is chosen rather than after.
              warn={level.id === costliest}
              onKeyDown={onOptionKey}
              onSelect={() => choose(() => onSelectReasoning!(level.id))}
            >
              {level.label ?? level.id}
            </ReasoningMenuItem>
          ))}
        </ReasoningGroup>
      ) : null}
      {grouped ? <div role="separator" className={MENU_DIVIDER_CLASS} /> : null}
      {variants.length > 0 ? (
        <ReasoningGroup heading={grouped ? 'Context window' : undefined}>
          {variants.map((variant) => (
            <ReasoningMenuItem
              key={variant.id}
              checked={variant.id === model}
              defaultChip={variant.base}
              onKeyDown={onOptionKey}
              onSelect={() => choose(() => onSelectModel(variant.id))}
            >
              {variant.label}
            </ReasoningMenuItem>
          ))}
        </ReasoningGroup>
      ) : null}
    </Popover>
  )
}

function ReasoningGroup({
  heading,
  children,
}: {
  heading?: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <div role="group" aria-label={heading}>
      {heading ? (
        <div className={`${MENU_GROUP_LABEL_CLASS} pb-0.5 pt-1.5`}>{heading}</div>
      ) : null}
      {children}
    </div>
  )
}

function ReasoningMenuItem({
  checked,
  defaultChip,
  warn,
  children,
  onSelect,
  onKeyDown,
}: {
  checked: boolean
  defaultChip?: boolean
  warn?: boolean
  children: React.ReactNode
  onSelect: () => void
  onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => void
}): JSX.Element {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      data-reasoning-option="true"
      data-checked={checked || undefined}
      // Radiogroup roving: the checked entry is the tab stop, arrows move.
      tabIndex={checked ? 0 : -1}
      onKeyDown={onKeyDown}
      onClick={(event) => {
        event.stopPropagation()
        onSelect()
      }}
      // The shared menu row (MC-2103). It was a bespoke `rounded-[5px] px-2 py-1`
      // row inside a `p-1` surface — the inset-fill-in-a-padded-surface shape
      // the menu spec rules out, at an inset no other menu in the app used.
      className={[
        MENU_ITEM_CLASS,
        checked
          ? 'bg-[color:var(--bg-selected)] text-[color:var(--text-strong)]'
          : warn
            ? 'text-[color:var(--tone-warn-on-tint)]'
            : 'text-[color:var(--text-default)] hover:text-[color:var(--text-strong)]',
      ].join(' ')}
    >
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {/* The catalog's own default, marked with a neutral chip rather than a
          tone: it is a fact about the option, not a status. */}
      {defaultChip ? (
        <span className="shrink-0 rounded-[3px] border border-[color:var(--border-default)] px-1 text-micro text-[color:var(--text-subtle)]">
          Default
        </span>
      ) : null}
    </button>
  )
}
