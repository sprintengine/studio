// The shared substrate for the three door surfaces (Roadmap / Automations /
// Reviews) — the "Door substrate" view of mockups/2026-07-20-post-merge-ui-polish
// (#view-doors). The three surfaces landed as copy-paste triplets that drifted:
// loading, empty, and error each grew three dialects, only one rail had keyboard
// navigation, and one error state withheld its rail with no retry. This module is
// the single source for those three shared pieces, so every door reads and behaves
// the same:
//
//   • SurfaceCanvasState — the canvas renders exactly one of three states:
//       loading (spinner + line), empty (glyph + CTA), error (the shared error
//       card, ALWAYS with "Try again", never a dead end, never a blocking dialog).
//   • SurfaceRail — the internal list rail: list semantics (role="list"), a
//       status glyph + title + state line per row, ↑/↓ + j/k keyboard navigation,
//       the "New …" affordance at the top, an optional leading project lens, and
//       an optional search + filter row (the Backlog toolbar idiom). The rail is
//       the surface's, never the app sidebar.
//   • BarStatusChip — the one status idiom in the surface bar: a 6 px dot + label,
//       never a competing pill or badge.

import React, { useCallback, useRef } from 'react'

import { GhostButton } from '../../ui/Buttons'
import { FilterMenu, type FilterMenuGroup } from '../../ui/FilterMenu'
import { InboxSearchInput } from '../../ui/InboxSearchInput'
import { InlineNotice } from '../../ui/InlineNotice'
import { type SelectItem } from '../../ui/Select'
import { Spinner } from '../../ui/Spinner'
import { StatusDot } from '../../ui/StatusDot'
import { FOCUS_RING_CLASS, type StatusTone } from '../../ui/tokens'

// ── SurfaceCanvasState ───────────────────────────────────────────────────────
// The three shared canvas states. Same anatomy on every door; only the copy
// changes. A refresh never re-enters `loading` — that state is for the first read
// only, so populated content never blinks back to a spinner.

export type SurfaceCanvasStateProps =
  | { kind: 'loading'; label: string }
  | {
      kind: 'empty'
      /** The glyph inside the accent-soft circle (an svg or a single character). */
      glyph: React.ReactNode
      title: string
      body?: React.ReactNode
      /** The one call-to-action (never a dead end for a first-time surface). */
      action?: React.ReactNode
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
      <div className="flex h-full w-full items-center justify-center gap-2 text-[12px] text-[color:var(--text-muted)]">
        <Spinner size={14} />
        {props.label}
      </div>
    )
  }
  if (props.kind === 'empty') {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-6 py-12 text-center">
        <div className="mb-1 flex h-11 w-11 items-center justify-center rounded-full bg-[color:var(--accent-primary-soft)] text-[18px] text-[color:var(--accent-primary)]">
          {props.glyph}
        </div>
        <h3 className="text-[15px] font-semibold text-[color:var(--text-strong)]">{props.title}</h3>
        {props.body ? (
          <p className="max-w-[46ch] text-[12px] leading-5 text-[color:var(--text-muted)]">{props.body}</p>
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
// A door failure is contained to the door (MC-1835). Without this, any throw in
// a surface's render — or a lazy chunk failing to load — propagated to the root
// and white-screened the whole renderer. The fallback follows the copy-voice
// error shape: state first, blast radius named, two recoveries — remount the
// surface, or close the door and keep working.

interface GlobalSurfaceErrorBoundaryProps {
  /** The door id ("reviews", "sprints", …) — names the surface in the log line. */
  surfaceId: string
  /** Human name for the fallback title ("Reviews hit a problem and stopped"). */
  surfaceLabel: string
  onClose: () => void
  children: React.ReactNode
}

interface GlobalSurfaceErrorBoundaryState {
  failed: boolean
}

export class GlobalSurfaceErrorBoundary extends React.Component<
  GlobalSurfaceErrorBoundaryProps,
  GlobalSurfaceErrorBoundaryState
> {
  state: GlobalSurfaceErrorBoundaryState = { failed: false }

  static getDerivedStateFromError(): GlobalSurfaceErrorBoundaryState {
    return { failed: true }
  }

  componentDidCatch(error: unknown): void {
    console.error(`[global-surface] the ${this.props.surfaceId} door crashed`, error)
  }

  componentDidUpdate(previous: GlobalSurfaceErrorBoundaryProps): void {
    // The boundary instance is reused as the operator moves between doors; a
    // failure in one surface must not stick to the next one.
    if (previous.surfaceId !== this.props.surfaceId && this.state.failed) {
      this.setState({ failed: false })
    }
  }

  render(): React.ReactNode {
    if (this.state.failed) {
      return (
        <SurfaceCanvasState
          kind="error"
          title={`${this.props.surfaceLabel} hit a problem and stopped.`}
          hint="The rest of the app is unaffected. Reload the surface, or close it and keep working."
          onRetry={() => this.setState({ failed: false })}
          retryLabel="Reload surface"
          extraAction={<GhostButton onClick={this.props.onClose}>Close</GhostButton>}
        />
      )
    }
    return this.props.children
  }
}

// ── SurfaceRail ──────────────────────────────────────────────────────────────
// The internal list rail shared by every door. A row is a status glyph, a
// title, and a one-line state; selecting it fills the canvas. Row actions live on
// the bar or canvas, never here — the rail stays a calm navigation list.
// Rows never carry a bare tone dot (owner ruling): the mark is the app's
// lifecycle/type iconography, or nothing — the state line carries the words.

export interface SurfaceRailRow {
  /** Stable selection id (roadmapRef / automation id / reviewId). */
  id: string
  title: string
  /** The one-line at-a-glance state ("Active · step 3 of 7", "Ran 2h ago · passed"). */
  stateLine: string
  /** The row's status/type mark (a LifecycleGlyph or a type glyph). Optional —
   *  a row with no mark renders title + state line only. */
  icon?: React.ReactNode
  /** Hover tooltip for the whole row; defaults to "title — stateLine" so a
   *  truncated row is always readable in place. */
  tooltip?: string
  /** Row-scoped actions (an overflow trigger). Rendered as a SIBLING of the row
   *  button, never nested inside it — one click target per row stays the rule, and
   *  a button inside a button is invalid. Revealed on hover and whenever the row
   *  is selected or something inside it has focus, so the keyboard can reach it. */
  actions?: React.ReactNode
  /** Right-click anywhere on the row. The same menu the `actions` trigger opens,
   *  so the affordance is discoverable both ways. */
  onContextMenu?: (position: { x: number; y: number }) => void
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

export function SurfaceRail({
  label,
  rows,
  groups,
  selectedId,
  onSelect,
  newAffordance,
  scope,
  search,
  filter,
}: {
  /** The rail's section label ("Roadmaps", "Automations", "Reviews"). */
  label: string
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

  const renderRow = (row: SurfaceRailRow): JSX.Element => {
    const selected = row.id === selectedId
    return (
      <li key={row.id} className="group/rail-row relative flex min-w-0">
        <button
          ref={(node) => {
            rowRefs.current.set(row.id, node)
          }}
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
          // The tooltip carries the untruncated row — title AND state — so a
          // clipped title or a terse state line is always readable on hover.
          title={row.tooltip ?? `${row.title} — ${row.stateLine}`}
          className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors ${FOCUS_RING_CLASS} ${
            selected ? 'bg-[color:var(--bg-selected)]' : 'hover:bg-[color:var(--bg-hover)]'
          }`}
        >
          {row.icon ?? null}
          <span className="flex min-w-0 flex-1 flex-col">
            {/* The selected row's ink lift is the second channel of the
                selection, so an unselected title has to sit a step below it —
                and in a resting rail the lift drops back out with the fill. */}
            <span
              className={`truncate text-[12px] font-medium ${
                selected ? 'text-[color:var(--text-strong)]' : 'text-[color:var(--text-default)]'
              }`}
            >
              {row.title}
            </span>
            <span className="truncate text-[10px] text-[color:var(--text-subtle)]">{row.stateLine}</span>
          </span>
          {/* Reserve the trailing gutter so revealing the overflow never reflows
              the title mid-hover. */}
          {row.actions ? <span aria-hidden="true" className="w-5 shrink-0" /> : null}
        </button>
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
    <div className="flex min-h-0 flex-col" data-selection-pane="primary" onKeyDown={onKeyDown}>
      {/* The "New …" affordance and the search row lead the rail and stay pinned
          while the list scrolls: with a long list they must never hide below (or
          above) the scroll — creating and narrowing are the rail's
          always-reachable actions, in the same place on every door. The negative
          offsets fold the shell aside's p-2.5 into the sticky header so it sits
          flush with the scrollport and paints over passing rows.

          ONE rule shared by every list surface: exactly one divider, drawn under
          the search row, which is what says "a list starts here". The project
          lens rides inside the filter glyph rather than standing as its own
          full-width Select above the search — a second control stacked over the
          field it narrows read as chrome for its own sake, and put the same
          choice in two different shapes on two different doors. */}
      <div className="sticky -top-2.5 z-10 -mx-2.5 -mt-2.5 mb-2 shrink-0 border-b border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)] px-2.5 pt-2.5">
        <button
          type="button"
          aria-current={newAffordance.selected ? 'true' : undefined}
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect()
            newAffordance.onActivate({ x: rect.left, y: rect.bottom })
          }}
          className={`mb-2 flex w-full items-center gap-2 rounded-md border border-dashed border-[color:var(--border-default)] px-2 py-1.5 text-left text-[12px] transition-colors ${FOCUS_RING_CLASS} ${
            newAffordance.selected
              ? 'bg-[color:var(--bg-selected)] font-medium text-[color:var(--text-strong)]'
              : 'text-[color:var(--text-muted)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)]'
          }`}
        >
          {PLUS_ICON}
          {newAffordance.label}
        </button>
        {search ? (
          <div className="flex items-center gap-1 pb-2">
            <InboxSearchInput
              value={search.value}
              onChange={search.onChange}
              ariaLabel={search.ariaLabel}
              placeholder={search.placeholder}
            />
            {menuGroups.length > 0 ? (
              <FilterMenu
                ariaLabel={filter?.ariaLabel ?? scope?.ariaLabel ?? 'Filter'}
                groups={menuGroups}
                className="shrink-0"
              />
            ) : null}
          </div>
        ) : null}
      </div>
      {/* No heading over an ungrouped list, and none over a lone group. "Horizons"
          above a field that already reads "Search horizons…" is the placeholder
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
              <span className="text-[11px] font-semibold text-[color:var(--text-subtle)]">{group.label}</span>
              <span className="font-mono text-[10px] tabular-nums text-[color:var(--text-disabled)]">
                {group.rows.length}
              </span>
            </div>
            <ul role="list" aria-label={`${label}: ${group.label}`} className="flex min-w-0 flex-col gap-0.5">
              {group.rows.map(renderRow)}
            </ul>
          </div>
        ))
      ) : (
        <ul role="list" aria-label={label} className="flex min-w-0 flex-col gap-0.5">
          {rows.map(renderRow)}
        </ul>
      )}
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
    <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-[color:var(--text-muted)]">
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
// the Horizon plan column's own j/k reads it too, so a search field or a popover
// trigger cannot be typed into while a list quietly moves underneath.
export function swallowsRailNavigation(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) return true
  return Boolean(target.closest('[role="combobox"], [aria-haspopup]'))
}
