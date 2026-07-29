import React from 'react'

import CliIcon from '../CliIcon'
import { Popover } from './Popover'
import { StarGlyph } from './StarGlyph'
import { Tooltip } from './Tooltip'
import { FOCUS_RING_CLASS } from './tokens'
import { ReasoningSelector, hasReasoningAxes, reasoningTriggerLabel } from './ReasoningSelector'
import { modelFavouriteKey, toggleModelFavourite, useModelFavourites } from './modelFavourites'
import {
  buildModelFamilies,
  familyForModel,
  meaningfulModelId,
  type CliModelFamily,
  type CliRuntimeOption,
} from './cliRuntimeCatalog'
import type { AgentCli } from '../../types/workspace'

export type { CliRuntimeOption } from './cliRuntimeCatalog'
export { meaningfulModelId } from './cliRuntimeCatalog'

// The model popover: a provider rail down the left, search over a flat list of
// models on the right. It replaces a grouped listbox whose every CLI header and
// indented child competed for the same scan — with the rail carrying the
// provider axis, a row only has to say which model it is.
//
// Each row is one model, not one catalog id: context-window variants of the
// same model collapse into a family (see cliRuntimeCatalog) and the window is
// picked on the ReasoningSelector beside the trigger. Selecting a row selects
// the CLI and the model together, in one action.

const MODEL_ROW_SELECTOR = '[data-model-row="true"]'
const QUICK_SELECT_LIMIT = 9

// The starred rail entry. Sentinel-shaped so it cannot collide with a plugin id.
const FAVOURITES_FILTER = '__starred__'

type RailFilter = AgentCli | typeof FAVOURITES_FILTER

type ModelRow = {
  key: string
  cli: AgentCli
  /** The model's name, or the CLI's when this is the CLI's own default row. */
  name: string
  /** The provider line under the name. */
  provider: string
  /** Render the name in the mono face — an id nothing labelled. */
  mono: boolean
  /** The raw id beside a friendly label, when it adds information the label does not. */
  monoId?: string
  /** Muted trailing annotation: today, a persisted model the catalog dropped. */
  note?: string
  /** The catalog id this row selects; null selects the CLI's own default model. */
  model: string | null
  family?: CliModelFamily
}

// Hosted models (manifest-derived `hostedVia`, e.g. Kimi K3 and Z.AI GLM riding
// the claude binary) name their host on the provider line. The old listbox said
// it once in a section heading; with a provider rail there is no section to
// hang it on, and the fact — this runs on someone else's binary — is exactly
// the kind a row cannot infer.
function providerLine(option: CliRuntimeOption): string {
  return option.hostedVia === 'claude-code' ? `${option.label} · via Claude Code` : option.label
}

// Every selectable runtime, flattened. Order is rail order, and within a
// provider the CLI's own default leads its models — the same reading order the
// grouped listbox had, minus the indentation that carried it.
export function buildModelRows(
  options: ReadonlyArray<CliRuntimeOption>,
  currentCli: AgentCli,
  effectiveModelFor: (cli: AgentCli) => string | undefined,
): ModelRow[] {
  const rows: ModelRow[] = []
  for (const option of options) {
    const provider = providerLine(option)
    const families = buildModelFamilies(option.modelSelection?.options)
    rows.push({
      key: modelFavouriteKey(option.value, null),
      cli: option.value,
      name: option.label,
      provider,
      mono: false,
      model: null,
    })
    for (const family of families) {
      rows.push({
        key: modelFavouriteKey(option.value, family.defaultId),
        cli: option.value,
        name: family.label ?? family.defaultId,
        provider,
        mono: !family.label,
        monoId: meaningfulModelId(family.defaultId, family.label),
        model: family.defaultId,
        family,
      })
    }
    // A persisted model no longer in the catalog still launches with that id;
    // surface it as its own row, marked "Not listed" so it reads as active but
    // not one of the configured ids.
    const effective = option.value === currentCli ? effectiveModelFor(option.value) : undefined
    if (option.modelSelection && effective && !familyForModel(families, effective)) {
      rows.push({
        key: modelFavouriteKey(option.value, effective),
        cli: option.value,
        name: effective,
        provider,
        mono: true,
        note: 'Not listed',
        model: effective,
      })
    }
  }
  return rows
}

function rowMatchesQuery(row: ModelRow, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return (
    row.name.toLowerCase().includes(needle) ||
    row.provider.toLowerCase().includes(needle) ||
    (row.model ?? '').toLowerCase().includes(needle)
  )
}

export function CliModelPopoverSurface({
  ariaLabel,
  options,
  currentCli,
  effectiveModelFor,
  effectiveReasoningFor,
  onSelectReasoning,
  onSelectCli,
  onSelectModel,
  showReasoning = false,
}: {
  ariaLabel: string
  options: ReadonlyArray<CliRuntimeOption>
  currentCli: AgentCli
  effectiveModelFor: (cli: AgentCli) => string | undefined
  /** Opt-in effort support: both accessors must be set for the Reasoning group to appear. */
  effectiveReasoningFor?: (cli: AgentCli) => string | undefined
  onSelectReasoning?: (cli: AgentCli, reasoning: string | null) => void
  onSelectCli: (cli: AgentCli) => void
  onSelectModel: (cli: AgentCli, model: string | null) => void
  /**
   * Render the reasoning selector as a trailing row of this surface. For hosts
   * with no trigger row to put it beside — a context menu, a roster row's
   * flyout — where the two controls stack instead of sitting side by side.
   */
  showReasoning?: boolean
}): JSX.Element {
  const favourites = useModelFavourites()
  const favouriteSet = React.useMemo(() => new Set(favourites), [favourites])
  const [query, setQuery] = React.useState('')
  const [filter, setFilter] = React.useState<RailFilter>(() =>
    options.some((option) => option.value === currentCli) ? currentCli : options[0]?.value ?? currentCli,
  )
  const listRef = React.useRef<HTMLDivElement | null>(null)
  const railRef = React.useRef<HTMLDivElement | null>(null)
  const searchRef = React.useRef<HTMLInputElement | null>(null)
  const listId = React.useId()

  // Search takes focus on open. Not React's `autoFocus`: this surface is
  // portaled into a Popover that paints `visibility: hidden` until it has
  // measured itself, and a hidden element cannot take focus — the mount-time
  // call lands nowhere and a keyboard user is stranded on the trigger. Retrying
  // once the surface is visible is what makes the popover typeable.
  React.useEffect(() => {
    const input = searchRef.current
    if (!input) return
    input.focus()
    if (document.activeElement === input) return
    const frame = requestAnimationFrame(() => searchRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [])

  const rows = React.useMemo(
    () => buildModelRows(options, currentCli, effectiveModelFor),
    [options, currentCli, effectiveModelFor],
  )
  const hasFavourites = rows.some((row) => favouriteSet.has(row.key))
  // Searching reaches across every provider — a name you can spell is faster
  // than a rail you have to pick first — so a live query suspends the filter
  // rather than intersecting with it.
  const searching = query.trim().length > 0
  const visible = searching
    ? rows.filter((row) => rowMatchesQuery(row, query))
    : filter === FAVOURITES_FILTER
      ? rows.filter((row) => favouriteSet.has(row.key))
      : rows.filter((row) => row.cli === filter)

  const effectiveModel = effectiveModelFor(currentCli)
  const isSelected = (row: ModelRow): boolean => {
    if (row.cli !== currentCli) return false
    if (row.model === null) return !effectiveModel
    if (row.family) return row.family.variants.some((variant) => variant.id === effectiveModel)
    return row.model === effectiveModel
  }
  const selectedRowIndex = visible.findIndex(isSelected)

  const choose = (row: ModelRow): void => {
    if (row.model === null) {
      const option = options.find((entry) => entry.value === row.cli)
      if (option?.modelSelection) onSelectModel(row.cli, null)
      else onSelectCli(row.cli)
      return
    }
    // Re-choosing the family that is already selected must not silently drop
    // the context window the user picked on it.
    if (isSelected(row) && effectiveModel) {
      onSelectModel(row.cli, effectiveModel)
      return
    }
    onSelectModel(row.cli, row.model)
  }

  // ⌘1–⌘9 pin to the first nine rows of the CURRENT filter, so the chord a row
  // advertises is the row it selects. Bound on the whole surface, because the
  // search field owns focus for most of the popover's life.
  const onSurfaceKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (!(event.metaKey || event.ctrlKey) || !/^[1-9]$/.test(event.key)) return
    const row = visible[Number(event.key) - 1]
    if (!row) return
    event.preventDefault()
    choose(row)
  }

  const onListKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'ArrowRight') return
    const nodes = Array.from(listRef.current?.querySelectorAll<HTMLElement>(MODEL_ROW_SELECTOR) ?? [])
    if (nodes.length === 0) return
    const current = (event.target as HTMLElement | null)?.closest<HTMLElement>(MODEL_ROW_SELECTOR)
    if (event.key === 'ArrowRight') {
      // The star is revealed on hover, so keyboard needs its own way in.
      const star = current?.querySelector<HTMLButtonElement>('[data-model-star="true"]')
      if (!star) return
      event.preventDefault()
      star.focus()
      return
    }
    event.preventDefault()
    if (!current) {
      // Arrowing out of the search field enters the list at its selected row.
      nodes[event.key === 'ArrowDown' ? Math.max(selectedRowIndex, 0) : nodes.length - 1]?.focus()
      return
    }
    const index = nodes.indexOf(current)
    if (index < 0) return
    nodes[(index + (event.key === 'ArrowDown' ? 1 : -1) + nodes.length) % nodes.length]?.focus()
  }

  // The rail is one tab stop with arrows moving inside it, as a tablist is.
  const onRailKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const tabs = Array.from(railRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])
    const index = tabs.indexOf(event.target as HTMLButtonElement)
    if (index < 0 || tabs.length === 0) return
    event.preventDefault()
    event.stopPropagation()
    tabs[(index + (event.key === 'ArrowDown' ? 1 : -1) + tabs.length) % tabs.length]?.focus()
  }

  const currentOption = options.find((option) => option.value === currentCli)
  const currentFamily = familyForModel(
    buildModelFamilies(currentOption?.modelSelection?.options),
    effectiveModel,
  )
  const reasoningAxes = {
    reasoningSelection: currentOption?.reasoningSelection,
    family: currentFamily,
    reasoningEnabled: Boolean(onSelectReasoning && effectiveReasoningFor),
  }

  const railEntries: Array<{ key: RailFilter; label: string; glyph: React.ReactNode }> = [
    ...(hasFavourites
      ? [
          {
            key: FAVOURITES_FILTER as RailFilter,
            label: 'Starred',
            glyph: <StarGlyph filled className="size-icon-sm" />,
          },
        ]
      : []),
    ...options.map((option) => ({
      key: option.value as RailFilter,
      label: option.label,
      glyph: <CliIcon cli={option.value} className="size-icon-sm" />,
    })),
  ]
  const activeRail = searching ? null : filter
  const chordModifier = quickSelectModifier()

  return (
    <div className="flex w-[380px] max-w-[calc(100vw-2rem)]" onKeyDown={onSurfaceKeyDown}>
      <div
        ref={railRef}
        role="tablist"
        aria-label="Provider"
        aria-orientation="vertical"
        onKeyDown={onRailKeyDown}
        className="flex flex-col gap-0.5 border-r border-[color:var(--border-subtle)] p-1.5"
      >
        {railEntries.map((entry, index) => (
          <RailButton
            key={String(entry.key)}
            label={entry.label}
            controls={listId}
            selected={activeRail === entry.key}
            // Roving tab stop: the active filter owns it, and with search
            // suspending the filter the first entry keeps the rail reachable.
            tabbable={activeRail === entry.key || (activeRail === null && index === 0)}
            onSelect={() => setFilter(entry.key)}
          >
            {entry.glyph}
          </RailButton>
        ))}
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-[color:var(--border-subtle)] px-3 py-2">
          <SearchGlyph />
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onListKeyDown}
            aria-label={`Search ${ariaLabel}`}
            aria-controls={listId}
            placeholder="Search models…"
            className="min-w-0 flex-1 bg-transparent text-meta text-[color:var(--text-default)] outline-none placeholder:text-[color:var(--text-subtle)] [&::-webkit-search-cancel-button]:hidden"
          />
        </div>

        <div
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label={ariaLabel}
          onKeyDown={onListKeyDown}
          className="max-h-[300px] min-h-0 flex-1 overflow-y-auto p-1"
        >
          {visible.length === 0 ? (
            <p className="px-2 py-3 text-meta text-[color:var(--text-subtle)]">
              {searching ? 'No models match.' : 'No models here yet.'}
            </p>
          ) : (
            visible.map((row, index) => (
              <ModelRowView
                key={row.key}
                row={row}
                selected={isSelected(row)}
                tabbable={index === (selectedRowIndex < 0 ? 0 : selectedRowIndex)}
                chord={index < QUICK_SELECT_LIMIT ? index + 1 : undefined}
                chordModifier={chordModifier}
                showProvider={searching || filter === FAVOURITES_FILTER}
                starred={favouriteSet.has(row.key)}
                onToggleStar={() => toggleModelFavourite(row.key)}
                onSelect={() => choose(row)}
              />
            ))
          )}
        </div>

        {showReasoning && hasReasoningAxes(reasoningAxes) ? (
          <div className="flex items-center justify-end border-t border-[color:var(--border-subtle)] px-1.5 py-1">
            <ReasoningSelector
              ariaLabel="Reasoning and context window"
              reasoningSelection={currentOption?.reasoningSelection}
              reasoning={effectiveReasoningFor?.(currentCli)}
              onSelectReasoning={
                onSelectReasoning ? (reasoning) => onSelectReasoning(currentCli, reasoning) : undefined
              }
              family={currentFamily}
              model={effectiveModel}
              onSelectModel={(model) => onSelectModel(currentCli, model)}
            />
          </div>
        ) : null}
      </div>
    </div>
  )
}

function RailButton({
  label,
  selected,
  tabbable,
  controls,
  onSelect,
  children,
}: {
  label: string
  selected: boolean
  tabbable: boolean
  controls: string
  onSelect: () => void
  children: React.ReactNode
}): JSX.Element {
  return (
    <Tooltip content={label} placement="bottom">
      <button
        type="button"
        role="tab"
        aria-selected={selected}
        aria-controls={controls}
        aria-label={label}
        tabIndex={tabbable ? 0 : -1}
        onClick={onSelect}
        className={[
          'interactive grid size-7 shrink-0 place-items-center rounded-[5px]',
          selected
            ? 'bg-[color:var(--bg-selected)] text-[color:var(--text-strong)]'
            : 'text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-default)]',
          FOCUS_RING_CLASS,
        ].join(' ')}
      >
        {children}
      </button>
    </Tooltip>
  )
}

// One model. The row is a `div[role=option]` rather than a `<button>` because it
// hosts the star's own button, and a button inside a button is invalid.
// Selection keeps full keyboard operation: the row is a tab stop with
// Enter/Space selecting, arrows roving between rows, ArrowRight reaching the
// star.
function ModelRowView({
  row,
  selected,
  tabbable,
  chord,
  chordModifier,
  showProvider,
  starred,
  onToggleStar,
  onSelect,
}: {
  row: ModelRow
  selected: boolean
  tabbable: boolean
  chord?: number
  chordModifier: string
  /** True while the list spans more than one provider (searching, or the starred filter). */
  showProvider: boolean
  starred: boolean
  onToggleStar: () => void
  onSelect: () => void
}): JSX.Element {
  const detail = [showProvider && row.model !== null ? row.provider : null, row.monoId]
    .filter(Boolean)
    .join(' · ')
  return (
    <div
      role="option"
      aria-selected={selected}
      data-model-row="true"
      tabIndex={tabbable ? 0 : -1}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        onSelect()
      }}
      className={[
        'interactive group/row flex w-full cursor-pointer items-center gap-2 rounded-[5px] py-1.5 pl-2 pr-1.5 text-left',
        selected
          ? 'bg-[color:var(--bg-selected)] text-[color:var(--text-strong)]'
          : 'text-[color:var(--text-default)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]',
        FOCUS_RING_CLASS,
      ].join(' ')}
    >
      <CliIcon cli={row.cli} className="size-icon-sm shrink-0 text-[color:var(--text-muted)]" />
      <span className="min-w-0 flex-1">
        <span className={`block truncate text-body ${row.mono ? 'font-mono text-meta' : ''}`} title={row.name}>
          {row.name}
        </span>
        {/* The second line qualifies the name; it never restates it. The
            provider appears only while the list spans more than one — under a
            rail filter the rail already said it, and on the CLI's own row the
            name IS the provider. The raw id appears only when the label does
            not already spell it (meaningfulModelId). */}
        {detail ? (
          <span className="block truncate font-mono text-micro tracking-wide text-[color:var(--text-subtle)]">
            {detail}
          </span>
        ) : null}
      </span>
      {row.note ? (
        <span className="shrink-0 whitespace-nowrap text-micro text-[color:var(--text-muted)]">{row.note}</span>
      ) : null}
      {chord ? (
        <kbd className="shrink-0 rounded-[3px] bg-[color:var(--bg-active)] px-1 font-mono text-micro tracking-wide text-[color:var(--text-subtle)]">
          {chordModifier}
          {chord}
        </kbd>
      ) : null}
      <button
        type="button"
        data-model-star="true"
        aria-pressed={starred}
        aria-label={starred ? `Unstar ${row.name}` : `Star ${row.name}`}
        tabIndex={-1}
        onClick={(event) => {
          event.stopPropagation()
          onToggleStar()
        }}
        onKeyDown={(event) => event.stopPropagation()}
        className={[
          'interactive grid size-5 shrink-0 place-items-center rounded-[3px]',
          'text-[color:var(--text-disabled)] hover:text-[color:var(--text-default)]',
          // Revealed on hover AND on keyboard focus — hover-only is a bug. A
          // starred row keeps its mark at rest, which is the whole point of it.
          starred
            ? 'text-[color:var(--text-muted)]'
            : 'opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100 focus-visible:opacity-100',
          FOCUS_RING_CLASS,
        ].join(' ')}
      >
        <StarGlyph filled={starred} stroked={!starred} className="size-icon-xs" />
      </button>
    </div>
  )
}

// The chord the rows advertise. Cmd on macOS, Ctrl elsewhere — the handler
// accepts either, so a mislabelled platform is cosmetic, not a dead shortcut.
// Read per render, never once at module load: preload publishes `window.api`
// after this module is first evaluated, so a module constant freezes on the
// wrong platform for the life of the session.
function quickSelectModifier(): string {
  return typeof window !== 'undefined' && window.api?.platform === 'darwin' ? '⌘' : 'Ctrl+'
}

function SearchGlyph(): JSX.Element {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 11 11"
      aria-hidden="true"
      focusable="false"
      className="shrink-0 text-[color:var(--text-muted)]"
    >
      <circle cx="4.5" cy="4.5" r="3" stroke="currentColor" strokeWidth="1.2" fill="none" />
      <path d="M7 7l2.5 2.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

// The two controls as a host embeds them: the model trigger (provider glyph +
// model name) and, when the runtime has a second axis to offer, the reasoning
// selector beside it. One inline-flex wrapper, so a host lays this out as the
// single control it replaced.
export function CliModelPickerButton({
  ariaLabel,
  options,
  cli,
  effectiveModelFor,
  effectiveReasoningFor,
  onSelectReasoning,
  disabled,
  quiet,
  maxWidthClassName = 'max-w-[220px]',
  onSelectCli,
  onSelectModel,
}: {
  ariaLabel: string
  options: CliRuntimeOption[]
  cli: AgentCli
  effectiveModelFor: (cli: AgentCli) => string | undefined
  /**
   * Opt-in reasoning-effort support (manifest reasoningSelection). When both
   * accessors are provided, the reasoning selector offers the CLI's levels.
   * Hosts without effort persistence omit them and the selector carries the
   * context-window axis alone — or nothing, when the model has no windows.
   */
  effectiveReasoningFor?: (cli: AgentCli) => string | undefined
  onSelectReasoning?: (cli: AgentCli, reasoning: string | null) => void
  disabled?: boolean
  /**
   * Opt-in low-emphasis trigger for in-place property editing (the Sprint
   * Engine roster's role bands): renders as plain muted text until hover or
   * focus reveal the control chrome.
   */
  quiet?: boolean
  /** Trigger width clamp override for hosts where the model name must never truncate. */
  maxWidthClassName?: string
  onSelectCli: (cli: AgentCli) => void
  onSelectModel: (cli: AgentCli, model: string | null) => void
}): JSX.Element | null {
  const [open, setOpen] = React.useState(false)
  const resolvedOptions = options.some((option) => option.value === cli)
    ? options
    : [{ value: cli, label: cli }, ...options]
  const selected = resolvedOptions.find((option) => option.value === cli) ?? resolvedOptions[0]
  if (!selected) return null

  const model = effectiveModelFor(cli)
  const families = buildModelFamilies(selected.modelSelection?.options)
  const family = familyForModel(families, model)
  // The trigger names the model, not the runtime that carries it: the glyph
  // already says which provider this is, so repeating "Claude Code · " spends
  // the row's width on a fact the icon states. Hosted runtimes name their own
  // model, so their CLI label is the model name. A model the catalog dropped
  // still reads as its raw id rather than vanishing.
  const modelLabel = family?.label ?? model ?? selected.label
  const reasoning = effectiveReasoningFor?.(cli)
  const axisLabel = reasoningTriggerLabel({
    reasoningSelection: selected.reasoningSelection,
    family,
    reasoningEnabled: Boolean(onSelectReasoning && effectiveReasoningFor),
    reasoning,
    model,
  })
  // The accessible name carries the whole runtime the visible trigger trims to
  // its model: provider, model, and the axes the selector beside it holds.
  const runtime = model
    ? `${selected.label} · ${modelLabel}`
    : selected.hostedVia === 'claude-code'
      ? `${selected.label} · Claude Code`
      : selected.label
  const runtimeLabel = [runtime, axisLabel].filter(Boolean).join(' · ')

  return (
    <span className="inline-flex min-w-0 shrink-0 items-center gap-0.5">
      <Popover
        open={open}
        onOpenChange={setOpen}
        ariaLabel={ariaLabel}
        popupRole="dialog"
        placement="bottom-start"
        className="min-w-0 shrink-0"
        surfaceClassName="overflow-hidden"
        renderTrigger={({ ref, triggerProps, togglePopover }) => (
          <Tooltip content={`Agent runtime: ${runtimeLabel}`} wrapperClassName="inline-flex min-w-0">
            <button
              ref={ref}
              type="button"
              aria-label={`${ariaLabel}: ${runtimeLabel}`}
              disabled={disabled}
              onClick={togglePopover}
              className={[
                'interactive group/pill inline-flex items-center gap-2 rounded-[5px] text-left',
                maxWidthClassName,
                quiet
                  ? 'h-6 border border-transparent px-1.5 text-micro text-[color:var(--text-muted)] hover:border-[color:var(--border-default)] hover:bg-[color:var(--bg-surface)] hover:text-[color:var(--text-default)] focus-visible:border-[color:var(--border-default)]'
                  : 'h-control-xs border border-[color:var(--border-default)] bg-[color:var(--bg-surface-raised)] px-2 text-meta text-[color:var(--text-default)] hover:border-[color:var(--border-strong)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]',
                'disabled:cursor-not-allowed disabled:opacity-45',
                FOCUS_RING_CLASS,
              ].join(' ')}
              {...triggerProps}
            >
              <CliIcon cli={selected.value} className="size-icon-sm shrink-0 text-[color:var(--text-muted)]" />
              <span className="min-w-0 flex-1 truncate">{modelLabel}</span>
              <ChevronGlyph
                className={`shrink-0 text-[color:var(--text-disabled)] ${
                  quiet ? 'opacity-0 transition-opacity group-hover/pill:opacity-100 group-focus-visible/pill:opacity-100' : ''
                }`}
              />
            </button>
          </Tooltip>
        )}
      >
        <CliModelPopoverSurface
          ariaLabel={`${ariaLabel} options`}
          options={resolvedOptions}
          currentCli={cli}
          effectiveModelFor={effectiveModelFor}
          effectiveReasoningFor={effectiveReasoningFor}
          onSelectReasoning={onSelectReasoning}
          onSelectCli={(nextCli) => {
            onSelectCli(nextCli)
            setOpen(false)
          }}
          onSelectModel={(nextCli, nextModel) => {
            onSelectModel(nextCli, nextModel)
            setOpen(false)
          }}
        />
      </Popover>
      <ReasoningSelector
        ariaLabel={`Reasoning for ${ariaLabel}`}
        reasoningSelection={selected.reasoningSelection}
        reasoning={reasoning}
        onSelectReasoning={onSelectReasoning ? (next) => onSelectReasoning(cli, next) : undefined}
        family={family}
        model={model}
        onSelectModel={(next) => onSelectModel(cli, next)}
        disabled={disabled}
        quiet={quiet}
      />
    </span>
  )
}

function ChevronGlyph({ className }: { className?: string }): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className={`size-icon-xs ${className ?? ''}`}>
      <path d="M4.5 6.5L8 10l3.5-3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
