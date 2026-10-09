// `@sprintengine/module-sdk/surface` — the host-provided door shell.
//
// TYPES ONLY AT RUNTIME, exactly like `./ui`: the host resolves this specifier
// through the import map it installs before evaluating a third-party renderer
// bundle. Evaluating this module throws.
//
// esbuild:
//   --external:@sprintengine/module-sdk/surface
//
// Render a module's modal or global surface inside `GlobalSurfaceShell` and it
// gets the app's own door chrome — title bar, back navigation, rail gutter,
// attention slot — instead of a re-implementation a shade off. `SurfaceRail`
// and `SurfaceCanvasState` are the two substrate pieces every bundled door
// uses for its list column and its loading/empty/error canvas.

import type * as React from 'react'
import type { FilterMenuGroup, SelectItem } from './ui'

const HOST_PROVIDED_MESSAGE =
  '@sprintengine/module-sdk/surface is provided by the host at runtime; mark it external in your bundler'

function hostProvided(): never {
  throw new Error(HOST_PROVIDED_MESSAGE)
}

// ── The shell ────────────────────────────────────────────────────────────────

export type GlobalSurfaceBar = {
  title: React.ReactNode
  actions?: React.ReactNode
}

export type GlobalSurfaceShellProps = {
  ariaLabel: string
  bar?: GlobalSurfaceBar
  attention?: React.ReactNode
  rail?: React.ReactNode
  onBack?: () => void
  canGoBack?: boolean
  /** Contextual Control-Tab group this surface belongs to. */
  controlTabContext?: string
  children: React.ReactNode
}

export const GlobalSurfaceShell: (props: GlobalSurfaceShellProps) => React.ReactElement = hostProvided()

/** Wire the shell's back affordance to the host's surface history. Pass the
 *  door's own close when it has one. */
export const useSurfaceBackNav: (close?: () => void) => {
  onBack: () => void
  canGoBack: boolean
} = hostProvided()

// ── Canvas states ────────────────────────────────────────────────────────────

export type SurfaceCanvasStateProps =
  | { kind: 'loading'; label: string }
  | {
      kind: 'empty'
      glyph: React.ReactNode
      title: string
      body?: React.ReactNode
      action?: React.ReactNode
      firstRun?: boolean
    }
  | {
      kind: 'error'
      title: string
      hint?: string
      detail?: string
      onRetry: () => void
      retryLabel?: string
      extraAction?: React.ReactNode
    }

export const SurfaceCanvasState: (props: SurfaceCanvasStateProps) => React.ReactElement = hostProvided()

// ── The rail ─────────────────────────────────────────────────────────────────

/**
 * One row of the rail. A row comes in two shapes, and which one it takes is
 * decided by two fields alone:
 *
 * - The PLAIN row (the default): an optional `icon`, the `title`, and the
 *   `stateLine` under it. `tooltip`, `mark` and `actions` apply here.
 * - The RICH row: set `context` or `detail` (either is enough) and the row
 *   becomes the app sidebar's three-line row — the context line above the
 *   title, the title, and the detail line under it — and takes `surface` and
 *   `emphasis`. It draws no `icon`, no `mark` and no whole-row `tooltip`: its
 *   marks live on its context and detail lines.
 *
 * Keep one shape per rail; a rail that mixes them ladders its titles.
 */
export interface SurfaceRailRow {
  /** Stable selection id (your record's id). */
  id: string
  /** The row's name. One line, truncating with its full text in a tooltip
   *  only when it was actually clipped. */
  title: string
  /** The one-line at-a-glance state ("Active · step 3 of 7", "Ran 2h ago · passed").
   *  Always required: on a rich row with a `detail` it is not drawn but stays
   *  the row's accessible summary and the text search and tests read. */
  stateLine: string
  /** The row's status/type mark (a `LifecycleGlyph` or a type glyph). Optional —
   *  a row with no mark renders title + state line only. The rail reserves one
   *  fixed slot for it as soon as one row carries one, so titles line up.
   *  Plain rows only. */
  icon?: React.ReactNode
  /** A whole-row tooltip, for a row that carries more than it shows. Without
   *  it the title and the state line each reveal their own full text only when
   *  clipped. Never a native `title=` on anything you put in the row.
   *  Plain rows only. */
  tooltip?: string
  /** Row-scoped actions (an overflow trigger). Rendered as a SIBLING of the
   *  row button, never inside it, and revealed on hover, on focus within, and
   *  while the row is selected — so the keyboard can reach it. */
  actions?: React.ReactNode
  /** Right-click anywhere on the row, with the pointer's viewport position —
   *  open the same `ContextMenu` the `actions` trigger opens, there. */
  onContextMenu?: (position: { x: number; y: number }) => void
  /** A small standing mark beside the title (a "3 new" chip). Always visible,
   *  unlike `actions`: it is a fact about the row, not a control. The title
   *  truncates before it does. Plain rows only. */
  mark?: React.ReactNode
  /** Setting this (or `detail`) makes the row a RICH row.
   *
   *  The line ABOVE the title: a small mark, the name of the place the row
   *  belongs to (its project), and a trailing `seat` for the row's clock — how
   *  long it has run, or how long since it rested. */
  context?: { icon?: React.ReactNode; label: string; seat?: React.ReactNode }
  /** Setting this (or `context`) makes the row a RICH row.
   *
   *  The line UNDER the title, replacing the plain `stateLine` text: the
   *  lifecycle mark, a branch chip, the state in words. `stateLine` is then
   *  screen-reader-only. A rich row with a `context` and no `detail` shows
   *  `stateLine` here instead. */
  detail?: React.ReactNode
  /** The row's surface: it wants a person (the gold wash), or it finished
   *  while nobody was looking (the faint green wash, until it is opened).
   *  Nothing for the ordinary row. Rich rows only. */
  surface?: 'attention' | 'done'
  /** How loudly the title reads: `active` is bold, `quiet` sits a step back and
   *  brightens on hover, so an old record recedes. Ignored on a plain row. */
  emphasis?: 'active' | 'quiet'
  /** Pointer-inert siblings layered over the row (a one-shot state-change
   *  flash), absolutely positioned inside the row's `li`. */
  overlay?: React.ReactNode
}

/** The rail's optional search field. Controlled: the rail draws the field and
 *  reports keystrokes, and you narrow your own `rows`. */
export interface SurfaceRailSearch {
  value: string
  onChange: (next: string) => void
  placeholder: string
  ariaLabel: string
}

/** The rail's optional filter affordance: one glyph beside the search field
 *  that opens a menu of radio groups (status, kind, …). Each group is
 *  controlled by you; you narrow your own `rows`. Drawn only when the rail
 *  also has a `search`. */
export interface SurfaceRailFilter {
  ariaLabel: string
  groups: ReadonlyArray<FilterMenuGroup>
}

/** The rail's optional project lens. It is NOT a visible control of its own:
 *  it rides inside the filter glyph's menu as its LEADING group, labelled
 *  "Project", so it is out of sight until the filter opens — and like the
 *  filter it shows only beside a `search`. The group's default (what the
 *  glyph treats as "not narrowed") is the FIRST item, so lead with
 *  "All projects". A project that must stay visible belongs in `intro`. */
export interface SurfaceRailScope {
  ariaLabel: string
  items: SelectItem<string>[]
  value: string
  onChange: (value: string) => void
}

/** The dashed "New …" row at the head of the rail. Omit it on a door with
 *  nothing to create and no New row is drawn. */
export interface SurfaceRailNewAffordance {
  /** The row's words ("New automation"). A plus glyph leads it. */
  label: string
  /** The "New …" row is itself the current selection (a create flow open in
   *  the canvas). */
  selected?: boolean
  /** Invoked on activate; `anchor` is the row's bottom-left, for a popover. */
  onActivate: (anchor: { x: number; y: number }) => void
  /** There is nowhere to create into. Inert and marked as such, never a
   *  control that opens an empty menu. */
  disabled?: boolean
}

/** One quiet group heading and the rows under it. A group with no rows has
 *  its heading dropped. */
export interface SurfaceRailGroup {
  key: string
  label: string
  rows: ReadonlyArray<SurfaceRailRow>
}

export type SurfaceRailProps = {
  /** The rail's section label. */
  label: string
  /** One line above everything the rail offers — WHICH THING the door is
   *  showing (a project chip). Omit it rather than explain the door in prose. */
  intro?: React.ReactNode
  /** Every row, in display order. ↑/↓ and j/k walk this list and select as
   *  they go. */
  rows: ReadonlyArray<SurfaceRailRow>
  /** Optional grouping: rows render under quiet group headers instead of one
   *  flat list. `rows` must equal the groups' rows flattened — keyboard
   *  navigation walks that flat order. */
  groups?: ReadonlyArray<SurfaceRailGroup>
  /** The selected row id, or null (nothing selected, or the New row is). */
  selectedId: string | null
  onSelect: (id: string) => void
  /** The dashed "New …" row at the head of the rail. Omit it on a door with
   *  nothing to create, and no New row is drawn. */
  newAffordance?: SurfaceRailNewAffordance
  /** The project lens. It is NOT a visible control of its own: it is folded
   *  into the filter glyph's menu as the leading group, labelled "Project",
   *  so it shows only beside a `search`. Omit on a door with nothing to scope
   *  by. */
  scope?: SurfaceRailScope
  /** Search over the rows, rendered above the list. The rail never filters:
   *  you narrow `rows` from `search.value`. */
  search?: SurfaceRailSearch
  /** Filter glyph beside the search field, opening `scope` (as "Project")
   *  followed by these groups. Ignored without `search`. */
  filter?: SurfaceRailFilter
  /** Why a narrowed rail is empty ("No runs match."). Rendered only when the
   *  rail has no rows; leave it out when an empty rail means "nothing exists
   *  yet" and let the canvas's empty state say so. */
  emptyNotice?: React.ReactNode
  /** This rail's rows are the OUTER level of a two-level rail, so their
   *  selection rests rather than competing with the inner list's. */
  outerContext?: boolean
  /** A second level rendered inside the rail's scroll region, below the rows. */
  afterRows?: React.ReactNode
  /** What `afterRows` hangs off: `'rows'` (default) — the selected row, so a
   *  search that hides every row hides it too; `'list'` — the list itself, so
   *  it stays when nothing matches. */
  afterRowsScope?: 'rows' | 'list'
}

/** The door's list column: the app's row shapes, keyboard navigation, New
 *  row, search and filter. */
export const SurfaceRail: (props: SurfaceRailProps) => React.ReactElement = hostProvided()
