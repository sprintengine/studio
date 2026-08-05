import React from 'react'

import CliIcon from '../CliIcon'
import { Popover } from './Popover'
import { StarGlyph } from './StarGlyph'
import { Tooltip } from './Tooltip'
import { FOCUS_RING_CLASS, FOCUS_RING_WITHIN_INPUT_CLASS } from './tokens'
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
// same model collapse into a family (see cliRuntimeCatalog). Selecting a row
// selects the CLI and the model together, in one action.
//
// A runtime is ONE control, everywhere (owner, 2026-07-30). Reasoning level and
// context window ride this surface's trailing row — they are properties of the
// model you just picked, and as a second pill beside the trigger they read as an
// unrelated setting: a lone "Standard ⌄" next to "Opus 5 ⌄" that nobody could
// name. Hosts get the same picker with the same axes in the same place, whether
// they open it from a composer row, a wizard step, a roster band, or a door bar.

const QUICK_SELECT_LIMIT = 9

// The key the pinned "no runtime" row navigates under. Sentinel-shaped for the
// same reason FAVOURITES_FILTER is: it shares an index space with model keys.
const NONE_ROW_KEY = '__none__'

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
  reasoningAriaLabel,
  noneRow,
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
   * Render the reasoning selector as a trailing row of this surface. This is
   * where the axes live for every host that opens the picker from a trigger;
   * hosts that ARE the trigger (a context menu, a roster row's flyout) pass it
   * too, so the surface reads the same wherever it opens.
   */
  showReasoning?: boolean
  /**
   * Accessible name for that trailing control. Hosts with a trigger name it for
   * the runtime it belongs to ("Reasoning for Agent runtime"), so a screen
   * reader hears which agent the level applies to rather than a bare axis name.
   */
  reasoningAriaLabel?: string
  /**
   * An opt-in row pinned above the models, for hosts where "no runtime at all" is
   * a real choice rather than an empty one (MC-2129's Planning agent: with None,
   * the epic is the plan and nothing plans the sprint). Absent everywhere else, so
   * a picker that must always resolve to a runtime cannot offer an escape from it.
   *
   * Hidden while searching: a query is asking for a model by name, and a pinned
   * row that matches nothing typed is noise in the results.
   */
  noneRow?: { label: string; description?: string; selected: boolean; onSelect: () => void }
}): JSX.Element {
  const favourites = useModelFavourites()
  const favouriteSet = React.useMemo(() => new Set(favourites), [favourites])
  const [query, setQuery] = React.useState('')
  const [filter, setFilter] = React.useState<RailFilter>(() =>
    options.some((option) => option.value === currentCli) ? currentCli : options[0]?.value ?? currentCli,
  )
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
  // Unstarring the last favourite retires the starred rail entry underneath the
  // filter that is pointing at it. Falling back to the current CLI is what stops
  // that leaving an empty list beside a rail where nothing is selected — and,
  // because the rail's tab stop follows the active entry, a rail Tab cannot
  // reach either.
  const filterIsLive = filter !== FAVOURITES_FILTER || hasFavourites
  const activeFilter: RailFilter = filterIsLive ? filter : currentCli
  // Searching reaches across every provider — a name you can spell is faster
  // than a rail you have to pick first — so a live query suspends the filter
  // rather than intersecting with it.
  const searching = query.trim().length > 0
  const visible = searching
    ? rows.filter((row) => rowMatchesQuery(row, query))
    : activeFilter === FAVOURITES_FILTER
      ? rows.filter((row) => favouriteSet.has(row.key))
      : rows.filter((row) => row.cli === activeFilter)

  const effectiveModel = effectiveModelFor(currentCli)
  const isSelected = (row: ModelRow): boolean => {
    if (row.cli !== currentCli) return false
    if (row.model === null) return !effectiveModel
    if (row.family) return row.family.variants.some((variant) => variant.id === effectiveModel)
    return row.model === effectiveModel
  }
  const selectedRowIndex = visible.findIndex(isSelected)

  // ── the keyboard model (MC-2134) ─────────────────────────────────────────
  //
  // The search field is the combobox and keeps focus for the whole life of this
  // surface; the highlighted row is named by `aria-activedescendant` and is
  // never focused. This list used to move real DOM focus onto the row, which
  // meant the first arrow took focus off the field and every keystroke after it
  // went to the row instead of the query — you could narrow, or walk, but not
  // both. The ruling and its two clauses are in
  // `design-system/components/combobox/component.md`.
  //
  // The highlight is tracked by row KEY, not index: narrowing the list leaves it
  // on the same model when that model survives the query, and falls back to the
  // selected row (then the first) when it does not. An index would point at a
  // different model in the window between a rebuild and the effect re-anchoring
  // it.
  const [activeKey, setActiveKey] = React.useState<string | null>(null)
  const activeRowRef = React.useRef<HTMLDivElement | null>(null)
  const showNoneRow = Boolean(noneRow) && !searching
  const navRows: Array<{ key: string; row: ModelRow | null }> = [
    ...(showNoneRow ? [{ key: NONE_ROW_KEY, row: null }] : []),
    ...visible.map((row) => ({ key: row.key, row })),
  ]
  const navSelectedIndex = showNoneRow
    ? noneRow?.selected
      ? 0
      : selectedRowIndex < 0
        ? -1
        : selectedRowIndex + 1
    : selectedRowIndex
  const activeIndex = ((): number => {
    const held = activeKey ? navRows.findIndex((entry) => entry.key === activeKey) : -1
    if (held >= 0) return held
    if (navSelectedIndex >= 0 && navSelectedIndex < navRows.length) return navSelectedIndex
    return navRows.length > 0 ? 0 : -1
  })()
  const optionId = (index: number): string => `${listId}-option-${index}`

  // `scrollIntoView` is optional-called: jsdom does not implement it, and the
  // node tests drive this surface for real rather than through a shim.
  React.useEffect(() => {
    activeRowRef.current?.scrollIntoView?.({ block: 'nearest' })
  }, [activeIndex])

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

  const chooseNav = (index: number): void => {
    const entry = navRows[index]
    if (!entry) return
    if (entry.row) choose(entry.row)
    else noneRow?.onSelect()
  }

  // True when the caret has nothing left to its right, so a horizontal key is
  // free for the list. An empty field is trivially at its end.
  const caretAtEnd = (): boolean => {
    const input = searchRef.current
    if (!input) return true
    const start = input.selectionStart ?? input.value.length
    const end = input.selectionEnd ?? start
    return start === end && start === input.value.length
  }

  // A key this field consumes stops here. Two of this surface's hosts are MENUS
  // — the roster's right-click picker and its `MenuFlyoutItem` — and a menu
  // surface runs `roveMenuFocus` on its own keydown, which answers
  // ArrowUp/Down/Home/End by moving real focus onto one of ITS items. Left to
  // bubble, the host would take focus off the field on the first arrow, which is
  // the exact failure the ruling exists to end. Escape is not consumed here, so
  // the surface still closes from anywhere inside it.
  const consume = (event: React.KeyboardEvent): void => {
    event.preventDefault()
    event.stopPropagation()
  }

  const onQueryKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      consume(event)
      if (navRows.length === 0) return
      const next = (activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + navRows.length) % navRows.length
      setActiveKey(navRows[next]?.key ?? null)
      return
    }
    if (event.key === 'Enter') {
      if (activeIndex < 0) return
      consume(event)
      chooseNav(activeIndex)
      return
    }
    // Home/End belong to the caret whenever the field has text: this is a field
    // you type into, and stealing them leaves no way to reach the ends of the
    // query. With nothing typed there is no caret to serve, so they jump the
    // list.
    if ((event.key === 'Home' || event.key === 'End') && query.length === 0) {
      if (navRows.length === 0) return
      consume(event)
      setActiveKey(navRows[event.key === 'Home' ? 0 : navRows.length - 1]?.key ?? null)
      return
    }
    // The row's own control, reached without a pointer. The star is revealed on
    // hover, so with focus pinned to the field it would otherwise have no
    // keyboard path at all — this is the escape hatch the ruling requires of any
    // picker whose rows carry a control. ArrowLeft on the star comes back.
    if (event.key === 'ArrowRight' && caretAtEnd()) {
      const star = activeRowRef.current?.querySelector<HTMLButtonElement>('[data-model-star="true"]')
      if (!star) return
      consume(event)
      star.focus()
    }
  }

  // The rail is one tab stop with arrows moving inside it, as a tablist is.
  const onRailKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const tabs = Array.from(railRef.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? [])
    const index = tabs.indexOf(event.target as HTMLButtonElement)
    if (index < 0 || tabs.length === 0) return
    event.preventDefault()
    event.stopPropagation()
    tabs[(index + (event.key === 'ArrowDown' ? 1 : -1) + tabs.length) % tabs.length]?.focus()
  }

  const reasoningWired = Boolean(onSelectReasoning && effectiveReasoningFor)
  const currentOption = options.find((option) => option.value === currentCli)
  const currentFamily = familyForModel(
    buildModelFamilies(currentOption?.modelSelection?.options),
    effectiveModel,
  )
  const reasoningAxes = {
    reasoningSelection: currentOption?.reasoningSelection,
    family: currentFamily,
    reasoningEnabled: reasoningWired,
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
  const activeRail = searching ? null : activeFilter
  const chordModifier = quickSelectModifier()

  return (
    <div className="flex w-[380px] max-w-[calc(100vw-2rem)]" onKeyDown={onSurfaceKeyDown}>
      <div
        ref={railRef}
        // A one-of-N filter, not tabs: `tablist`/`tab` promises a tabpanel this
        // rail does not have, and a screen reader announces one.
        role="radiogroup"
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
        {/* The search row is a composite: the input is the tab stop, the row is
            the box a user sees, so the row draws the indicator — the same
            treatment InboxSearchInput uses. It matters more here than in an
            ordinary field, because this input takes focus the moment the
            popover opens: without it the surface opens with a focused element
            and nothing marking it. */}
        <div
          className={`flex items-center gap-2 border-b border-[color:var(--border-subtle)] px-3 py-2 ${FOCUS_RING_WITHIN_INPUT_CLASS}`}
        >
          <SearchGlyph />
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setActiveKey(null)
            }}
            onKeyDown={onQueryKeyDown}
            aria-label={`Search ${ariaLabel}`}
            // This field IS the combobox: it owns the query, keeps focus while
            // the arrows move the highlight, and names the highlighted row
            // through `aria-activedescendant`. The list below is rendered for as
            // long as this surface is, hence the constant `aria-expanded`.
            role="combobox"
            aria-expanded
            aria-controls={listId}
            aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
            placeholder="Search models…"
            className="min-w-0 flex-1 bg-transparent text-meta text-[color:var(--text-default)] outline-none placeholder:text-[color:var(--text-subtle)] [&::-webkit-search-cancel-button]:hidden"
          />
        </div>

        <div
          id={listId}
          role="listbox"
          aria-label={ariaLabel}
          className="max-h-[300px] min-h-0 flex-1 overflow-y-auto p-1"
        >
          {showNoneRow && noneRow ? (
            <NoneRowView
              id={optionId(0)}
              rowRef={activeIndex === 0 ? activeRowRef : undefined}
              label={noneRow.label}
              description={noneRow.description}
              selected={noneRow.selected}
              active={activeIndex === 0}
              onHighlight={() => setActiveKey(NONE_ROW_KEY)}
              onSelect={noneRow.onSelect}
            />
          ) : null}
          {visible.length === 0 ? (
            noneRow && !searching ? null : (
              <p className="px-2 py-3 text-meta text-[color:var(--text-subtle)]">
                {searching ? 'No models match.' : 'No models here yet.'}
              </p>
            )
          ) : (
            visible.map((row, index) => {
              const navIndex = showNoneRow ? index + 1 : index
              return (
                <ModelRowView
                  key={row.key}
                  id={optionId(navIndex)}
                  rowRef={activeIndex === navIndex ? activeRowRef : undefined}
                  row={row}
                  selected={isSelected(row)}
                  active={activeIndex === navIndex}
                  chord={index < QUICK_SELECT_LIMIT ? index + 1 : undefined}
                  chordModifier={chordModifier}
                  showProvider={searching || activeFilter === FAVOURITES_FILTER}
                  starred={favouriteSet.has(row.key)}
                  onHighlight={() => setActiveKey(row.key)}
                  onToggleStar={() => toggleModelFavourite(row.key)}
                  onLeaveStar={() => searchRef.current?.focus()}
                  onSelect={() => choose(row)}
                />
              )
            })
          )}
        </div>

        {showReasoning && hasReasoningAxes(reasoningAxes) ? (
          <div className="flex items-center justify-end border-t border-[color:var(--border-subtle)] px-1.5 py-1">
            <ReasoningSelector
              ariaLabel={reasoningAriaLabel ?? 'Reasoning and context window'}
              reasoningSelection={currentOption?.reasoningSelection}
              reasoning={effectiveReasoningFor?.(currentCli)}
              onSelectReasoning={
                reasoningWired ? (reasoning) => onSelectReasoning!(currentCli, reasoning) : undefined
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
        role="radio"
        aria-checked={selected}
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
//
// A row is never focused (MC-2134): the search field keeps focus and names the
// highlighted row through `aria-activedescendant`, so a row carries no tab stop
// and no key handler of its own. `aria-selected` still marks the CURRENT
// runtime, which is a different fact from the highlight and outlives it —
// `data-active` carries the highlight for the tests that assert on it.
/**
 * The pinned "no runtime" row (MC-2129). Same row geometry and selection
 * treatment as a model row, so the list reads as one list; it carries no CLI
 * glyph because there is no runtime to name, and no star because there is
 * nothing to favourite.
 */
function NoneRowView({
  id,
  rowRef,
  label,
  description,
  selected,
  active,
  onHighlight,
  onSelect,
}: {
  id: string
  rowRef?: React.Ref<HTMLDivElement>
  label: string
  description?: string
  selected: boolean
  active: boolean
  onHighlight: () => void
  onSelect: () => void
}): JSX.Element {
  return (
    <div
      id={id}
      ref={rowRef}
      role="option"
      aria-selected={selected}
      data-model-row="true"
      data-active={active ? 'true' : undefined}
      onClick={onSelect}
      onPointerEnter={onHighlight}
      className={[
        'interactive flex w-full cursor-pointer items-center gap-2 rounded-[5px] py-1.5 pl-2 pr-1.5 text-left',
        // The highlight is `--bg-hover`, the same treatment `Select` gives its
        // own active option — not a second idiom, and not the focus ring, which
        // belongs to the field that actually holds focus. A row that is both
        // current and highlighted keeps the stronger `--bg-selected` fill;
        // nothing is lost, because the row Enter would take is the one already
        // marked as current.
        selected
          ? 'bg-[color:var(--bg-selected)] text-[color:var(--text-strong)]'
          : active
            ? 'bg-[color:var(--bg-hover)] text-[color:var(--text-strong)]'
            : 'text-[color:var(--text-default)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]',
      ].join(' ')}
    >
      <span className="size-icon-sm shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body">{label}</span>
        {description ? (
          <span className="block truncate text-micro text-[color:var(--text-subtle)]">{description}</span>
        ) : null}
      </span>
    </div>
  )
}

function ModelRowView({
  id,
  rowRef,
  row,
  selected,
  active,
  chord,
  chordModifier,
  showProvider,
  starred,
  onHighlight,
  onToggleStar,
  onLeaveStar,
  onSelect,
}: {
  id: string
  rowRef?: React.Ref<HTMLDivElement>
  row: ModelRow
  /** The CURRENT runtime — a persistent fact, not the keyboard highlight. */
  selected: boolean
  /** The keyboard highlight: this row is the search field's `aria-activedescendant`. */
  active: boolean
  chord?: number
  chordModifier: string
  /** True while the list spans more than one provider (searching, or the starred filter). */
  showProvider: boolean
  starred: boolean
  onHighlight: () => void
  onToggleStar: () => void
  /** ArrowLeft on the star hands focus back to the field that owns it. */
  onLeaveStar: () => void
  onSelect: () => void
}): JSX.Element {
  const detail = [showProvider && row.model !== null ? row.provider : null, row.monoId]
    .filter(Boolean)
    .join(' · ')
  return (
    <div
      id={id}
      ref={rowRef}
      role="option"
      aria-selected={selected}
      data-model-row="true"
      data-active={active ? 'true' : undefined}
      onClick={onSelect}
      onPointerEnter={onHighlight}
      className={[
        'interactive group/row flex w-full cursor-pointer items-center gap-2 rounded-[5px] py-1.5 pl-2 pr-1.5 text-left',
        selected
          ? 'bg-[color:var(--bg-selected)] text-[color:var(--text-strong)]'
          : active
            ? 'bg-[color:var(--bg-hover)] text-[color:var(--text-strong)]'
            : 'text-[color:var(--text-default)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]',
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
        onKeyDown={(event) => {
          event.stopPropagation()
          // The way back to the field. Escape is deliberately NOT bound here:
          // Escape closes the surface from anywhere inside it, and a key that
          // means two things depending on where focus sits is worse than a
          // second one that always means the same thing.
          if (event.key !== 'ArrowLeft') return
          event.preventDefault()
          onLeaveStar()
        }}
        className={[
          'interactive grid size-5 shrink-0 place-items-center rounded-[3px]',
          'text-[color:var(--text-disabled)] hover:text-[color:var(--text-default)]',
          // Revealed on hover, on the keyboard HIGHLIGHT, and on its own focus —
          // hover-only is a bug. The highlight earns a reveal because ArrowRight
          // from the field is the star's only keyboard path, and an affordance
          // that appears solely under a pointer cannot advertise it. A starred
          // row keeps its mark at rest, which is the whole point of it.
          //
          // The highlight is branched in JS rather than written as a
          // `group-data-[active=true]/row:` variant: that variant appears
          // nowhere else in the app, and tokens.ts documents at length what a
          // variant Tailwind never emits costs — an affordance that silently
          // renders inert. `opacity-100` is a utility the stylesheet certainly
          // has.
          starred
            ? 'text-[color:var(--text-muted)]'
            : active
              ? 'opacity-100'
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
  noneOption,
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
  /**
   * Opt-in "no runtime" choice, pinned first in the menu (MC-2129). When
   * `selected`, the trigger reads as that choice rather than as a runtime —
   * the row's VALUE is the whole control, so "None" must be legible without
   * a badge or sub-copy beside it.
   */
  noneOption?: { label: string; description?: string; selected: boolean; onSelect: () => void }
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
  const reasoningWired = Boolean(onSelectReasoning && effectiveReasoningFor)
  const axisLabel = reasoningTriggerLabel({
    reasoningSelection: selected.reasoningSelection,
    family,
    reasoningEnabled: reasoningWired,
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
  const isNone = noneOption?.selected === true
  const runtimeLabel = isNone
    ? noneOption.label
    : [runtime, axisLabel].filter(Boolean).join(' · ')

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
          <Tooltip
            content={isNone ? `${ariaLabel}: ${noneOption.label}` : `Agent runtime: ${runtimeLabel}`}
            wrapperClassName="inline-flex min-w-0"
          >
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
                  ? 'h-6 border border-transparent px-1.5 text-micro text-[color:var(--text-muted)] hover:border-[color:var(--border-default)] hover:bg-[color:var(--bg-surface)] hover:text-[color:var(--text-default)]'
                  : 'h-control-xs border border-[color:var(--border-default)] bg-[color:var(--bg-surface-raised)] px-2 text-meta text-[color:var(--text-default)] hover:border-[color:var(--border-strong)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]',
                'disabled:cursor-not-allowed disabled:opacity-45',
                FOCUS_RING_CLASS,
              ].join(' ')}
              {...triggerProps}
            >
              {isNone ? (
                <span className="size-icon-sm shrink-0" aria-hidden="true" />
              ) : (
                <CliIcon cli={selected.value} className="size-icon-sm shrink-0 text-[color:var(--text-muted)]" />
              )}
              <span className="min-w-0 flex-1 truncate">{isNone ? noneOption.label : modelLabel}</span>
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
          showReasoning
          reasoningAriaLabel={`Reasoning for ${ariaLabel}`}
          onSelectCli={(nextCli) => {
            onSelectCli(nextCli)
            setOpen(false)
          }}
          onSelectModel={(nextCli, nextModel) => {
            onSelectModel(nextCli, nextModel)
            setOpen(false)
          }}
          {...(noneOption
            ? {
                noneRow: {
                  label: noneOption.label,
                  ...(noneOption.description ? { description: noneOption.description } : {}),
                  selected: isNone,
                  onSelect: () => {
                    noneOption.onSelect()
                    setOpen(false)
                  },
                },
              }
            : {})}
        />
      </Popover>
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
