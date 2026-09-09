// The shared substrate for the door surfaces (Sprints / Automations / Reviews)
// — the "Door substrate" view of mockups/2026-07-20-post-merge-ui-polish
// (#view-doors). They landed as copy-paste triplets that drifted:
// loading, empty, and error each grew three dialects, only one rail had keyboard
// navigation, and one error state withheld its rail with no retry. This module is
// the single source for those three shared pieces, so every door reads and behaves
// the same:
//
//   • SurfaceCanvasState — the canvas renders exactly one of three states:
//       loading (spinner + line), empty (the kit EmptyState, or the richer
//       first-run canvas when the door has never held anything), error (the
//       shared error card, ALWAYS with "Try again", never a dead end, never a
//       blocking dialog).
//   • SurfaceRail — the internal list rail: list semantics (role="list"), a
//       status glyph + title + state line per row, ↑/↓ + j/k keyboard navigation,
//       the "New …" affordance at the top, an optional leading project lens, and
//       an optional search + filter row (the Backlog toolbar idiom). The rail's
//       CONTENT is the surface's; since item 1993 its COLUMN is the app
//       sidebar's, which the surface's rail replaces while the door is open.
//   • SurfaceRailHeader — that rail's pinned head on its own, for the door whose
//       rows are too rich to be SurfaceRailRows (Backlog) but whose head is the
//       same head. New-at-top and one narrowing glyph is a cross-door contract,
//       so it lives in exactly one place.
//   • BarStatusChip — the one status idiom in the surface bar: a 6 px dot + label,
//       never a competing pill or badge.

import React, { useCallback, useRef } from 'react'

import { GhostButton } from '../../ui/Buttons'
import { EmptyState } from '../../ui/EmptyState'
import { FilterMenu, type FilterMenuGroup } from '../../ui/FilterMenu'
import { InboxSearchInput } from '../../ui/InboxSearchInput'
import { InlineNotice } from '../../ui/InlineNotice'
import { RowButton } from '../../ui/RowButton'
import { type SelectItem } from '../../ui/Select'
import { Spinner } from '../../ui/Spinner'
import { StatusDot } from '../../ui/StatusDot'
import { FOCUS_RING_CLASS, type StatusTone } from '../../ui/tokens'
import { Tooltip } from '../../ui/Tooltip'
import { TruncatedText } from '../../ui/TruncatedText'
import { SELECTION_EDGE_CLASS, attentionRowSurfaceClass, doneRowSurfaceClass } from '../rowStatusParts'

// ── SurfaceCanvasState ───────────────────────────────────────────────────────
// The three shared canvas states. Same anatomy on every door; only the copy
// changes. A refresh never re-enters `loading` — that state is for the first read
// only, so populated content never blinks back to a spinner.

export type SurfaceCanvasStateProps =
  | { kind: 'loading'; label: string }
  | {
      kind: 'empty'
      /** An svg glyph (from `AppIcons` or the door's own mark) — never a text
       *  character: the glyph spec forbids characters as icons. */
      glyph: React.ReactNode
      title: string
      body?: React.ReactNode
      /** The one call-to-action (never a dead end for a first-time surface). */
      action?: React.ReactNode
      /**
       * The door has never held anything — "No reviews yet", "Run your first
       * sprint". Only that canvas keeps the richer treatment (the accent-soft
       * disc and a title-sized heading), per the empty-state ruling (MC-2117).
       * Everything else — a list narrowed to nothing, a scan that failed, no
       * project open — is the quiet kit `EmptyState`, the same one a pane one
       * click away already renders. Defaults to false so a new call site gets
       * the quiet state unless it says otherwise.
       */
      firstRun?: boolean
    }
  | {
      kind: 'error'
      /** Plain sentence: what happened, in the user's terms. */
      title: string
      /** What it means / the one next step. */
      hint?: string
      /** Raw technical string, shown only behind "Show details". */
      detail?: string
      onRetry: () => void
      /** Label for the retry action; defaults to "Try again". */
      retryLabel?: string
      /** Extra recovery action(s) rendered before "Try again" (e.g. "Open settings"). */
      extraAction?: React.ReactNode
    }

export function SurfaceCanvasState(props: SurfaceCanvasStateProps): JSX.Element {
  if (props.kind === 'loading') {
    return (
      <div className="flex h-full w-full items-center justify-center gap-2 text-meta text-[color:var(--text-muted)]">
        <Spinner size={14} />
        {props.label}
      </div>
    )
  }
  if (props.kind === 'empty') {
    if (!props.firstRun) {
      return (
        <EmptyState
          density="pane"
          glyph={props.glyph}
          title={props.title}
          body={props.body}
          action={props.action}
        />
      )
    }
    // First run only: the one canvas that earns the accent disc and a heading.
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-6 py-8 text-center">
        <div className="mb-1 flex h-11 w-11 items-center justify-center rounded-full bg-[color:var(--accent-primary-soft)] text-[color:var(--accent-primary)]">
          {props.glyph}
        </div>
        <h3 className="text-title font-semibold text-[color:var(--text-strong)]">{props.title}</h3>
        {props.body ? (
          <p className="max-w-[46ch] text-meta leading-5 text-[color:var(--text-muted)]">{props.body}</p>
        ) : null}
        {props.action ? <div className="mt-2 flex items-center gap-2">{props.action}</div> : null}
      </div>
    )
  }
  // Error: the shared error card. Non-blocking (never a dialog), always a retry —
  // the rail stays present because the shell, not this canvas, owns the rail.
  return (
    <div className="flex h-full w-full items-center justify-center px-6">
      <InlineNotice
        tone="error"
        title={props.title}
        hint={props.hint}
        detail={props.detail}
        className="w-full max-w-md"
        action={
          <>
            {props.extraAction}
            <GhostButton onClick={props.onRetry}>{props.retryLabel ?? 'Try again'}</GhostButton>
          </>
        }
      />
    </div>
  )
}

// ── GlobalSurfaceErrorBoundary ───────────────────────────────────────────────
// The boundary itself moved to `surfaceErrorBoundary.tsx` — it is the ONE piece
// of this module the shell must hold before any door opens, and importing it
// from here dragged the rail, its filter menu and its search input into the
// eager boot chunk (bundle-budget ratchet). Re-exported so every existing
// importer, and the door tests, still name this module.
export { GlobalSurfaceErrorBoundary } from './surfaceErrorBoundary'

// ── SurfaceRail ──────────────────────────────────────────────────────────────
// The internal list rail shared by every door. A row is a status glyph, a
// title, and a one-line state; selecting it fills the canvas. Row actions live on
// the bar or canvas, never here — the rail stays a calm navigation list.
// Rows never carry a bare tone dot (owner ruling): the mark is the app's
// lifecycle/type iconography, or nothing — the state line carries the words.

export interface SurfaceRailRow {
  /** Stable selection id (run slug / automation id / reviewId). */
  id: string
  title: string
  /** The one-line at-a-glance state ("Active · step 3 of 7", "Ran 2h ago · passed"). */
  stateLine: string
  /** The row's status/type mark (a LifecycleGlyph or a type glyph). Optional —
   *  a row with no mark renders title + state line only. */
  icon?: React.ReactNode
  /** A whole-row tooltip (the product `Tooltip`, on the row button), for a door
   *  whose row carries more than it shows — Sprints adds the lifecycle word its
   *  glyph draws. Without it the title and the state line each surface their
   *  own full text only when actually clipped (`TruncatedText`), so a row that
   *  fits says nothing twice. Never a native `title=`: an OS tooltip is a
   *  second dialect beside the product one and is unreachable by keyboard. */
  tooltip?: string
  /** Row-scoped actions (an overflow trigger). Rendered as a SIBLING of the row
   *  button, never nested inside it — one click target per row stays the rule, and
   *  a button inside a button is invalid. Revealed on hover and whenever the row
   *  is selected or something inside it has focus, so the keyboard can reach it. */
  actions?: React.ReactNode
  /** Right-click anywhere on the row. The same menu the `actions` trigger opens,
   *  so the affordance is discoverable both ways. */
  onContextMenu?: (position: { x: number; y: number }) => void
  /** A small standing mark beside the title — the Design door's "3 new" chip.
   *  Unlike `actions` it is always visible: `actions` is a control that appears
   *  on hover, this is a FACT about the row, and a fact that only shows while
   *  the pointer is over it is a fact nobody reads. It shares the title's line
   *  and never grows it: the title truncates first (`shrink-0` on the mark), so
   *  a long name cannot push the mark out of the row. Plain rows only — the rich
   *  row already has a line of marks under its title, which is where a door
   *  wearing that shape puts one. */
  mark?: React.ReactNode

  // ── The rich row ────────────────────────────────────────────────────────
  // A row in the app sidebar's own shape (door-rails-premium): a line above the
  // title saying where the thing lives with a clock at its trailing edge, the
  // title, and a line under it of marks and chips. The run doors wear it so a
  // sprint reads exactly like a chat in the column next to it — same clock in
  // the same corner, same branch chip, same gold-when-it-wants-you wash. A row
  // that sets neither `context` nor `detail` is the plain two-line row it
  // always was, so the other doors are untouched.

  /** The line ABOVE the title: a small mark, the name of the place the row
   *  belongs to (its project), and a trailing seat that holds the row's clock
   *  — the working dots and how long, or how long since it rested. The one
   *  line that is the same shape on every row, which is what lets the eye
   *  find the clock without reading the row. */
  context?: { icon?: React.ReactNode; label: string; seat?: React.ReactNode }
  /** The line UNDER the title, replacing the plain `stateLine` text: the
   *  lifecycle mark, a branch chip, ±lines, the state in words. `stateLine`
   *  stays required — it is the row's one-sentence accessible summary and the
   *  text any search or test can read — and renders sr-only when this is set. */
  detail?: React.ReactNode
  /** The row's surface: it wants a person (the gold wash), or it finished
   *  while nobody was looking (the faint green wash, until it is opened).
   *  Nothing for the ordinary row. */
  surface?: 'attention' | 'done'
  /** How loudly the title reads: `active` is bold, `quiet` sits a step back in
   *  subtle ink and brightens on hover — the sidebar's emphasis tiers, so an
   *  hour-old run recedes the way an hour-old chat does. Ignored on a plain row. */
  emphasis?: 'active' | 'quiet'
  /** Pointer-inert siblings layered over the row (the one-shot state-change
   *  flash). Rendered inside the row's `li`, absolutely positioned, never
   *  inside the button — so replaying one never remounts the button.
   *
   *  A rich row does not take `actions`: its trailing edge is the clock's
   *  seat, and nothing has asked for a second thing there yet. */
  overlay?: React.ReactNode
}

/** The rail's optional search field — the same idiom as the Backlog toolbar. */
export interface SurfaceRailSearch {
  value: string
  onChange: (next: string) => void
  placeholder: string
  ariaLabel: string
}

/** The rail's optional filter affordance beside the search field. */
export interface SurfaceRailFilter {
  ariaLabel: string
  groups: ReadonlyArray<FilterMenuGroup>
}

/** The rail's optional project lens. It rides inside the filter glyph's menu as
 *  its leading group — never a separate Select LEADING the rail's
 *  filter controls, exactly where the Backlog door's toolbar puts its own
 *  (MC-1816). Which projects a door offers is the door's business; that the
 *  operator finds the control in the same place on both is this substrate's. */
export interface SurfaceRailScope {
  ariaLabel: string
  items: SelectItem<string>[]
  value: string
  onChange: (value: string) => void
}

export interface SurfaceRailNewAffordance {
  label: string
  /** The "New …" affordance is itself the current selection (Reviews' create flow). */
  selected?: boolean
  /** Invoked on activate; `anchor` is the button's bottom-left, for popover hosts. */
  onActivate: (anchor: { x: number; y: number }) => void
  /** There is nowhere to create into — the Backlog door with no project open,
   *  whose picker would otherwise open with no projects in it. Inert and marked
   *  as such, never a control that opens an empty menu. */
  disabled?: boolean
}

const PLUS_ICON = (
  <svg viewBox="0 0 16 16" fill="none" className="icon-xs shrink-0" aria-hidden="true">
    <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
)

export interface SurfaceRailGroup {
  key: string
  label: string
  rows: ReadonlyArray<SurfaceRailRow>
}

/**
 * The rail's pinned head: the `New …` row, then search beside one filter glyph.
 *
 * Factored out of `SurfaceRail` for the doors whose LIST cannot be a
 * `SurfaceRailRow[]` — the Backlog door's rail is its own listbox, because its
 * rows carry epic identity paint, a collapsible group header with a progress
 * roll-up, and a project tag that no title/state-line row can hold. Its head is
 * still this head: New-at-top and one narrowing glyph beside the search is a
 * cross-door contract (MC-1816), and copying thirty lines of it into a fourth
 * door is precisely the drift this module was created to stop.
 *
 * Creating and narrowing never scroll away: with a long list they must stay in
 * the same place on every door. That is structural, not sticky — the head is a
 * SIBLING of the rail's scrollport rather than a child of it, so rows cannot
 * reach it and it paints no ground of its own. ONE divider, under the search row,
 * which is what says "a list starts here".
 */
export function SurfaceRailHeader({
  intro,
  newAffordance,
  search,
  filterControl,
}: {
  /** One line under the door's name, above everything it offers — WHICH THING
   *  the door is showing, where a global door is scoped to one project (the
   *  Design door's project chip). Said once, here, and nowhere else on the
   *  surface; a door with nothing to distinguish it omits it entirely, which
   *  is every door that would only be explaining itself in prose.
   *
   *  It sits outside the group headings deliberately: a heading whose group has
   *  no rows is dropped, and a scope control that vanished when its project had
   *  nothing in it would disappear at exactly the moment it was wanted. */
  intro?: React.ReactNode
  newAffordance: SurfaceRailNewAffordance
  /** Search over the rows. Omit on a rail with nothing to narrow. */
  search?: SurfaceRailSearch
  /** The narrowing affordance beside the search field — `SurfaceRail`'s own
   *  `FilterMenu`, or a door's equivalent glyph. Ignored without `search`. */
  filterControl?: React.ReactNode
}): JSX.Element {
  return (
    // Outside the scrollport, not stuck to the top of it (owner, 2026-07-30).
    // While this lived inside the scrolling column it had to be `sticky` and paint
    // an opaque ground to occlude rows sliding under it — and that ground is a
    // different material from the chrome around it, so the head read as a solid
    // slab dropped into the bar. Under the glass window material it was worse: the
    // column goes transparent to let the OS frost through, and the slab stayed
    // opaque on top of it. The app sidebar has never had that seam because its own
    // head sits above its scrollport (WorkspaceSidebar's `flex-1 overflow-y-auto`),
    // so nothing can pass beneath it and it paints nothing. This is that shape:
    // rows physically cannot reach it, so it needs no ground and inherits whatever
    // the column is made of — including transparent.
    // Head inset is `--sem-space-sm` (8px), matching the pattern's `.rail-head`
    // — deliberately WIDER than the scrollport's 4px, because the head holds
    // full-width controls while the rows hold hover fills (MC-2101's grid).
    <div className="shrink-0 border-b border-[color:var(--border-subtle)] px-2 pb-0 pt-2">
      {/* A div, not a p: the slot is typed `ReactNode` and the Design door puts
          its project chip here, whose popover renders a div — inside a `p` the
          browser silently closes the paragraph and the chip lands outside it. */}
      {intro ? (
        <div className="mb-2 text-meta leading-4 text-[color:var(--text-muted)]">{intro}</div>
      ) : null}
      {/* The kit's row button in its `dashed` variant — the system's one dashed
          edge, and the "New …" affordance it exists for (design-system/
          components/row-button). The width, the inset, the dashed edge, the
          muted ink and its hover lift, the selection fill and the disabled
          canon (the opacity step, `not-allowed`, and the hover pinned back off
          under `disabled:hover:`) are all the primitive's now, so none of them
          is spelled here. `aria-current` stays explicit: the row announces
          itself as the current one whenever the door says it is selected, even
          while it is off, which is one step wider than the fill it paints. */}
      <RowButton
        variant="dashed"
        selected={newAffordance.selected && !newAffordance.disabled}
        aria-current={newAffordance.selected ? 'true' : undefined}
        disabled={newAffordance.disabled}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect()
          newAffordance.onActivate({ x: rect.left, y: rect.bottom })
        }}
        className="mb-2 text-meta"
      >
        {PLUS_ICON}
        {newAffordance.label}
      </RowButton>
      {search ? (
        <div className="flex items-center gap-1 pb-2">
          <InboxSearchInput
            value={search.value}
            onChange={search.onChange}
            ariaLabel={search.ariaLabel}
            placeholder={search.placeholder}
          />
          {filterControl}
        </div>
      ) : null}
    </div>
  )
}

/**
 * The rich row's surface, in the app sidebar's precedence: wanting a person
 * outranks having finished, which outranks being the selected row — a selected
 * row that wants you keeps its gold and gains the selection edge, never the
 * neutral fill that would say the ask has been dealt with.
 */
function richRowSurfaceClass(row: SurfaceRailRow, selected: boolean): string {
  if (row.surface === 'attention') return attentionRowSurfaceClass(selected)
  if (row.surface === 'done') return doneRowSurfaceClass(selected)
  if (selected) return `bg-[color:var(--bg-selected)] text-[color:var(--text-strong)] ${SELECTION_EDGE_CLASS}`
  return 'text-[color:var(--text-default)] hover:bg-[color:var(--bg-surface-raised)] hover:text-[color:var(--text-strong)]'
}

/**
 * The rich row's button: context line, title, detail line — the app sidebar's
 * flat-stream row, in the door column. Its classes are that row's classes: the
 * 30px minimum, the 20px meta lines, the 44px seat the clock sits in, the
 * `text-heading` title whose weight is the emphasis tier and whose ink is the
 * surface's. Kept as a function of the row rather than a component so the
 * rail's roving `ref` lands on the button exactly as it does on a plain row.
 *
 * It stays a raw `<button>` where the plain row above became a `RowButton`, and
 * the reason is `richRowSurfaceClass`: a row that wants a person wears the gold
 * wash and a row that finished unseen wears the green one, both HELD on hover
 * so hovering never reads as the ask going away. `RowButton` ships one ground —
 * `bg.hover` at rest, `bg.selected` when chosen — and no status surface, so the
 * wash could only arrive through `className`, where its `bg-…`, `hover:bg-…`
 * and `text-…` meet the primitive's own at equal specificity and which of them
 * paints is stylesheet order. That is the exact failure `RowButton` exists to
 * prevent, so this waits for a `surface` axis on the primitive rather than
 * gambling on the build's emit order.
 */
function renderRichRowButton(
  row: SurfaceRailRow,
  selected: boolean,
  ref: (node: HTMLButtonElement | null) => void,
  onSelect: (id: string) => void,
): JSX.Element {
  const quiet = row.emphasis === 'quiet' && !selected
  const lineInk = quiet ? 'text-[color:var(--text-disabled)]' : 'text-[color:var(--text-subtle)]'
  const titleInk = quiet ? 'text-[color:var(--text-subtle)] group-hover/rich-row:text-[color:var(--text-default)]' : ''
  const titleWeight = row.emphasis === 'active' || selected ? 'font-semibold' : ''
  return (
    <button
      ref={ref}
      type="button"
      aria-current={selected ? 'true' : undefined}
      onClick={() => onSelect(row.id)}
      onContextMenu={
        row.onContextMenu
          ? (event) => {
              event.preventDefault()
              row.onContextMenu?.({ x: event.clientX, y: event.clientY })
            }
          : undefined
      }
      data-rail-row="rich"
      className={`interactive group/rich-row relative flex min-h-control-sm w-full cursor-pointer select-none flex-col justify-center gap-0.5 rounded-md py-1 pl-3 pr-1.5 text-left text-heading ${FOCUS_RING_CLASS} ${richRowSurfaceClass(
        row,
        selected,
      )}`}
    >
      {row.context ? (
        <span className={`flex h-5 min-w-0 items-center gap-1.5 text-meta ${lineInk}`}>
          {row.context.icon ?? null}
          <span className="min-w-0 truncate">{row.context.label}</span>
          {row.context.seat ? (
            <span className="relative ml-auto flex h-5 min-w-[44px] shrink-0 items-center justify-end gap-1 pl-2 tabular-nums">
              {row.context.seat}
            </span>
          ) : null}
        </span>
      ) : null}
      <span className="flex min-w-0 items-center gap-1.5">
        <TruncatedText as="span" text={row.title} className={`min-w-0 flex-1 ${titleWeight} ${titleInk}`} />
      </span>
      {/* The detail line's parts are the accessible sentence — the mark's
          label, the branch, the words — so `stateLine` is not spoken again
          here: a row that said its project and its state twice over was the
          rich row's first review finding. It renders only on a row with a
          context line and no detail of its own. */}
      {row.detail ? (
        <span className={`flex h-5 min-w-0 items-center gap-2 overflow-hidden text-meta ${lineInk}`}>
          {row.detail}
        </span>
      ) : (
        <TruncatedText as="span" text={row.stateLine} className={`text-meta ${lineInk}`} />
      )}
    </button>
  )
}

export function SurfaceRail({
  label,
  intro,
  rows,
  groups,
  selectedId,
  onSelect,
  newAffordance,
  scope,
  search,
  filter,
  emptyNotice,
  outerContext,
  afterRows,
  afterRowsScope = 'rows',
}: {
  /** The rail's section label ("Sprints", "Automations", "Reviews"). */
  label: string
  /** One line under the door's name — see `SurfaceRailHeader`'s `intro`. */
  intro?: React.ReactNode
  rows: ReadonlyArray<SurfaceRailRow>
  /** Optional grouping (the Sprints door): rows render under quiet group
   *  headers instead of one flat list. `rows` must equal the groups' rows
   *  flattened — keyboard navigation walks that flat order. */
  groups?: ReadonlyArray<SurfaceRailGroup>
  /** The selected row id, or null (nothing selected / the "New" affordance is). */
  selectedId: string | null
  onSelect: (id: string) => void
  newAffordance: SurfaceRailNewAffordance
  /** The project lens, leading the rail's filter controls (the Backlog toolbar
   *  idiom). Omit on a door with nothing to scope by. */
  scope?: SurfaceRailScope
  /** Search over the rows, rendered above the list (the Backlog toolbar idiom). */
  search?: SurfaceRailSearch
  /** Filter glyph beside the search field. Ignored without `search`. */
  filter?: SurfaceRailFilter
  /** Why a narrowed rail is empty ("No sprints match."). Rendered only when the
   *  rail has no rows; the door decides whether an empty rail means "nothing
   *  matched" (say so) or "nothing exists yet" (leave it to the canvas's empty
   *  state), because only the door can see the unfiltered set.
   *
   *  It lives here rather than in each door because as a SIBLING of the rail it
   *  was wrong twice over: at `px-2` it sat 8px in while the rows it explains sat
   *  at the row inset, and because the rail is `flex-1`, an empty list stretched
   *  and flex-pushed the notice to the BOTTOM of the column — furthest from the
   *  search field that caused it, right above the Back row. Five doors had
   *  copy-pasted it; five doors had both bugs. */
  emptyNotice?: React.ReactNode
  /** This rail's rows are the OUTER level of a two-level rail — which container,
   *  which project — so their selection rests permanently rather than competing
   *  with the inner list's (assets/index.css, "Selection tiers").
   *
   *  Marked on the list itself, not on a wrapper around the whole rail: the CSS
   *  rule is a descendant selector, so a marker further out also catches whatever
   *  `afterRows` renders, and the inner list's real selection would quietly
   *  render as resting. The group is the rows, not the column. */
  outerContext?: boolean
  /** A second level rendered INSIDE the scrollport, below the rows — a
   *  two-level door's contents under its containers. It belongs in the scrollport rather than
   *  beside the rail, because a rail column has one scroll region: as a sibling
   *  it scrolled separately from the list it hangs off, and anything with its own
   *  height cap became a third. */
  afterRows?: React.ReactNode
  /** What `afterRows` HANGS OFF, which decides whether an empty list takes it
   *  with it. `'rows'` (the default) means it belongs to a row: the contents are
   *  the contents of the row that is selected, so a search that hides every row
   *  hides them too, rather than leaving them
   *  stranded under "Nothing matches." `'list'` means it belongs to the LIST
   *  itself — the run doors' `+` — and a list you can add to is still a list you
   *  can add to when the filter matches nothing. Getting this wrong on the run
   *  doors removed the only way to make a run from a door whose search happened
   *  to match nothing, and, worse, unmounted an open new-row form mid-typing
   *  with the goal in it. */
  afterRowsScope?: 'rows' | 'list'
}): JSX.Element {
  const rowRefs = useRef<Map<string, HTMLButtonElement | null>>(new Map())

  // ↑/↓ + j/k move the selection through the rows and carry focus with it, so the
  // keyboard and the canvas stay in step. Ignored while typing in a field.
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (swallowsRailNavigation(event.target) || rows.length === 0) return
      const next = event.key === 'ArrowDown' || event.key === 'j'
      const prev = event.key === 'ArrowUp' || event.key === 'k'
      if (!next && !prev) return
      event.preventDefault()
      const index = selectedId ? rows.findIndex((row) => row.id === selectedId) : -1
      const target = next
        ? rows[Math.min(index + 1, rows.length - 1)] ?? rows[0]
        : rows[Math.max(index - 1, 0)] ?? rows[0]
      if (!target) return
      onSelect(target.id)
      rowRefs.current.get(target.id)?.focus()
    },
    [rows, selectedId, onSelect],
  )

  // The project lens leads the filter glyph's menu; the door's own axes follow.
  // One affordance narrows the list, so there is one place to look for "why am I
  // not seeing everything?" — and the rail keeps a single full-width control.
  const menuGroups: FilterMenuGroup[] = [
    ...(scope
      ? [
          {
            label: 'Project',
            items: scope.items,
            value: scope.value,
            defaultValue: scope.items[0]?.value ?? scope.value,
            onChange: scope.onChange,
          },
        ]
      : []),
    ...(filter?.groups ?? []),
  ]

  // The leading icon slot is the SUBSTRATE's contract, not the door's (MC-2098).
  // Doors fill the slot; they never size it. Before this, `renderRow` laid out
  // whatever glyph the door handed it, so the title's x-offset was
  // `10 (scrollport) + 8 (row pad) + iconWidth + 8 (gap)` — and iconWidth was the
  // only free variable: 16px on Sprints/Roadmap/Automations, 13px on Extensions'
  // bare `icon-xs` svgs, 12px on Design's identity chip. Opening a different door
  // in the same physical column therefore slid every row title 38↔42px, a visible
  // re-flow of a column that is supposed to read as one continuous rail.
  //
  // A fixed `icon-sm` (16px) box pins that term. Doors may still render a smaller
  // mark inside it — Design's 12px chip is a deliberate identity square, and
  // Extensions' 13px marks are deliberately quiet — they simply center in a slot
  // whose width no door can change.
  //
  // Reserved per-RAIL rather than per-row: a rail where only some rows carry a
  // mark would otherwise ladder its own titles against each other, which is the
  // same defect one level down.
  const reserveIconSlot = rows.some((row) => row.icon)

  const renderRow = (row: SurfaceRailRow): JSX.Element => {
    const selected = row.id === selectedId
    const rich = row.context !== undefined || row.detail !== undefined
    // Never a native `title=`: the OS tooltip beside the product `Tooltip` one
    // column over was two tooltip dialects on one door, and a native one cannot
    // be reached from the keyboard. The row button is the focusable trigger for
    // the door's whole-row tooltip; a clipped title or state line reveals its
    // own full text through `TruncatedText`.
    const rowButton = rich ? (
      renderRichRowButton(row, selected, (node) => {
        rowRefs.current.set(row.id, node)
      }, onSelect)
    ) : (
      // The kit's row button at its default density, which IS this row's shape:
      // full width, left-aligned, `radius.overlay`, the 8px inset and the 8px
      // icon-to-title gap the 36px title offset above is measured from. The
      // selection fill, its inset edge and its `aria-current` are the
      // primitive's `selected`; the roving `ref`, the context menu and the rest
      // pass straight through. The press scale is gone with the raw classes: a
      // full-width row that shrank under the pointer detached from the rows
      // either side of it, which is why `RowButton` states no `.interactive`.
      <RowButton
        ref={(node) => {
          rowRefs.current.set(row.id, node)
        }}
        selected={selected}
        onClick={() => onSelect(row.id)}
        onContextMenu={
          row.onContextMenu
            ? (event) => {
                event.preventDefault()
                row.onContextMenu?.({ x: event.clientX, y: event.clientY })
              }
            : undefined
        }
      >
        {reserveIconSlot ? (
          <span
            data-rail-icon-slot="true"
            className="flex size-icon-sm shrink-0 items-center justify-center"
          >
            {row.icon ?? null}
          </span>
        ) : null}
        <span className="flex min-w-0 flex-1 flex-col">
          {/* The selected row's ink lift is the second channel of the
              selection, so an unselected title has to sit a step below it —
              and in a resting rail the lift drops back out with the fill. */}
          {/* The mark shares the title's line, and only a row that HAS one pays
              for the extra box — every other door's row markup is untouched. */}
          {row.mark ? (
            <span className="flex min-w-0 items-center gap-1.5">
              <TruncatedText
                as="span"
                text={row.title}
                className={`min-w-0 flex-1 text-body font-medium ${
                  selected ? 'text-[color:var(--text-strong)]' : 'text-[color:var(--text-default)]'
                }`}
              />
              {row.mark}
            </span>
          ) : (
            <TruncatedText
              as="span"
              text={row.title}
              className={`text-body font-medium ${
                selected ? 'text-[color:var(--text-strong)]' : 'text-[color:var(--text-default)]'
              }`}
            />
          )}
          <TruncatedText as="span" text={row.stateLine} className="text-meta text-[color:var(--text-subtle)]" />
        </span>
        {/* Reserve the trailing gutter so revealing the overflow never reflows
            the title mid-hover. */}
        {row.actions ? <span aria-hidden="true" className="w-5 shrink-0" /> : null}
      </RowButton>
    )
    return (
      <li key={row.id} className="group/rail-row relative flex min-w-0">
        {/* A rich row carries its own tooltips (the mark, the chip, the clock),
            so no whole-row tooltip wraps it — a chip's tooltip inside a row's
            tooltip would be two surfaces fighting for one hover. */}
        {row.tooltip && !rich ? (
          <Tooltip content={row.tooltip} wrapperClassName="flex min-w-0 flex-1">
            {rowButton}
          </Tooltip>
        ) : (
          rowButton
        )}
        {/* The flash is a sibling of the button, AFTER it in the tree so it
            paints over it (two positioned siblings paint in tree order), and
            pointer-inert — replaying it never remounts the row under the
            pointer. */}
        {row.overlay ?? null}
        {row.actions ? (
          <span
            className={`absolute right-1 top-1/2 flex -translate-y-1/2 items-center transition-opacity ${
              selected ? 'opacity-100' : 'opacity-0 focus-within:opacity-100 group-hover/rail-row:opacity-100'
            }`}
          >
            {row.actions}
          </span>
        ) : null}
      </li>
    )
  }

  return (
    // The door's leading list: it holds the full-strength selection tier until
    // another pane on the surface takes focus, so a door that has just opened
    // shows one focused selection rather than none (assets/index.css,
    // "Selection tiers").
    // The rail owns its own scroll boundary: the head is a sibling of the
    // scrollport, never a child of it, which is what lets the head paint nothing.
    <div className="flex min-h-0 flex-1 flex-col" data-selection-pane="primary" onKeyDown={onKeyDown}>
      {/* The shared rail head (SurfaceRailHeader): New-at-top, then search beside
          ONE narrowing glyph. The project lens rides inside that glyph's menu
          rather than standing as its own full-width Select above the search — a
          second control stacked over the field it narrows read as chrome for its
          own sake, and put the same choice in two different shapes on two
          different doors. */}
      <SurfaceRailHeader
        intro={intro}
        newAffordance={newAffordance}
        search={search}
        filterControl={
          menuGroups.length > 0 ? (
            <FilterMenu
              ariaLabel={filter?.ariaLabel ?? scope?.ariaLabel ?? 'Filter'}
              groups={menuGroups}
              className="shrink-0"
            />
          ) : null
        }
      />
      {/* The scrollport. It carries the rail's inset so the head above can sit
          flush to the column's edges, the way the app sidebar's chrome does.
          4px (`--sem-space-2xs`) is the pattern's `.rail-rows` padding, and it
          is what puts a row's TITLE on the column's 36px text grid:
          4 (here) + 8 (row padding) + 16 (icon slot) + 8 (gap) — the same edge
          the app sidebar's workspace rows and the Back row's label land on. */}
      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-1 pb-2 pt-2">
      {/* Under the head, at the row inset, where the rows would have been —
          never flex-pushed to the bottom of the column. */}
      {emptyNotice && rows.length === 0 ? (
        <p className="px-2 pt-1 text-meta leading-4 text-[color:var(--text-muted)]">{emptyNotice}</p>
      ) : null}
      {/* No heading over an ungrouped list, and none over a lone group. "Projects"
          above a field that already reads "Search projects…" is the placeholder
          said twice, and a "Recent" header spanning every row groups nothing —
          a group heading earns its place only by separating one group from
          another. The list's accessible name carries the label either way. */}
      {groups ? (
        groups.map((group) => (
          <div key={group.key} className="flex min-w-0 flex-col">
            <div
              className={`flex items-baseline gap-1.5 px-2 pb-1 pt-2 first:pt-0.5 ${
                groups.length > 1 ? '' : 'hidden'
              }`}
            >
              <span className="text-micro font-semibold text-[color:var(--text-subtle)]">{group.label}</span>
              {/* The UI face, not the mono one: after the Design door's captions,
                  token paths and provenance line came off mono (2026-09-08),
                  two digits in a rail heading were the last mono string in a
                  door's chrome. `tabular-nums` is what a count actually needed
                  from that face. */}
              <span className="text-micro tabular-nums text-[color:var(--text-disabled)]">
                {group.rows.length}
              </span>
            </div>
            <ul
              role="list"
              aria-label={`${label}: ${group.label}`}
              data-rail-group={outerContext ? 'outer-context' : undefined}
              className="flex min-w-0 flex-col gap-0.5"
            >
              {group.rows.map(renderRow)}
            </ul>
          </div>
        ))
      ) : (
        <ul
          role="list"
          aria-label={label}
          data-rail-group={outerContext ? 'outer-context' : undefined}
          className="flex min-w-0 flex-col gap-0.5"
        >
          {rows.map(renderRow)}
        </ul>
      )}
      {/* The inner level goes with its outer one. While a search has narrowed
          the rows to nothing, the row that OWNS this second level is not on
          screen either — rendering it anyway put a two-level door's inner list
          directly under "Nothing matches.", contents belonging to a row the
          filter had just hidden. The notice explains an empty list; it cannot
          also explain the populated thing under it.
          That reasoning is about a level hanging off a ROW, which is why it is
          conditioned on `afterRowsScope` rather than on emptiness alone: a slot
          that hangs off the LIST — the run doors' `+` — is not explained by the
          notice and is not hidden by it. */}
      {afterRows && !(afterRowsScope === 'rows' && emptyNotice && rows.length === 0) ? afterRows : null}
      </div>
    </div>
  )
}

// ── BarStatusChip ────────────────────────────────────────────────────────────
// The one status idiom in the surface bar: a 6 px dot + a short label. Never a
// tinted pill or badge — the dot carries the tone.

export function BarStatusChip({
  tone,
  label,
  pulse,
}: {
  tone: StatusTone
  /** The visible label ("Active", "On", "In progress") — carries the state for
   *  screen readers, so the dot stays decorative (no competing double-read). */
  label: React.ReactNode
  pulse?: boolean
}): JSX.Element {
  return (
    <span className="inline-flex items-center gap-1.5 text-micro font-medium text-[color:var(--text-muted)]">
      <StatusDot tone={tone} pulse={pulse} />
      {label}
    </span>
  )
}

// A field being typed into swallows the rail's navigation keys — and so does a
// control with its own Arrow-key contract. The project lens and the filter glyph
// sit INSIDE the rail's key handler, and neither stops propagation, so without
// this an ArrowDown on the lens would open its listbox and move the rail's
// selection, pulling focus off the control the operator is using.
//
// Exported because every keyboard-navigable list on a door owes the same rule:
// an inner plan column's own j/k reads it too, so a search field or a popover
// trigger cannot be typed into while a list quietly moves underneath.
export function swallowsRailNavigation(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) return true
  return Boolean(target.closest('[role="combobox"], [aria-haspopup]'))
}
