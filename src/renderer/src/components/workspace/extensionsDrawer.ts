import type { RegisteredGlobalSurface } from '../../modules/renderer-host'

// What the Extensions drawer IS, as data (Extensions drawer ruling, 2026-09-05).
//
// SIX rows, in a fixed order the owner ruled:
//
//   Workflows · Sprints · Design · Plugins · Skills · Agent CLIs
//
// It was five until item 2470 split the run doors in two (owner ruling R7,
// 2026-09-06): one noun, "sprint", named two jobs that have nothing to do with
// each other, so Workflows and Sprints are separate rows leading to separate
// lists. Workflows leads because it is where a goal starts.
//
// Registry `order` does not decide it. The earlier cut sorted doors and modal
// surfaces together by their declared `order`, which meant the column a person
// reads top to bottom was arranged by whichever numbers modules happened to
// claim, and any module registered later could push Sprints down it. The order
// of the product's parts is a ruling; the list below is that ruling, and each
// entry names only WHERE its row comes from — the owning module still supplies
// the label, the glyph and what opening the row does.
//
// A leaf: pure data plus two predicates, no React and no store, so the drawer
// that RENDERS the rows (ExtensionsRail) and the store action that has to know
// which surfaces BELONG to the drawer (settingsSlice.openGlobalSurface) can
// share one answer instead of keeping two lists that drift.

/**
 * The Extensions home — the surface the app rail's Extensions glyph opens.
 * Core, not a module's: it is where the product's own parts are offered, so no
 * module toggle may take it away (renderer-host reserves the id).
 */
export const EXTENSIONS_HOME_SURFACE_ID = 'extensions-home'

// Where a row comes from. Three kinds, because the registry has three shapes of
// contribution and the drawer must not flatten them into one hand-written list
// of components:
//   nav     — a module's `registerSidebarNavEntry` row (Sprints), which owns its
//             own status dot and open behaviour.
//   surface — a module's door, one row for the whole surface (Design).
//   view    — one of a door's registered `views` (renderer-host): the single
//             `extensions` surface is Plugins, Skills and Agent CLIs to the
//             person, so it contributes three rows, each with its own label,
//             glyph and way of landing the surface on it.
export type DrawerRow =
  | { kind: 'nav'; rowId: ExtensionsDrawerRowId; entryId: string }
  | { kind: 'surface'; rowId: ExtensionsDrawerRowId; surfaceId: string }
  | { kind: 'view'; rowId: ExtensionsDrawerRowId; surfaceId: string; viewId: string }

/**
 * A row's own name, stable across what it resolves to. Two things address a row
 * by it: the unread count each row wears (`useExtensionsRowBadges`), and a bell
 * notification's `extensionsRow`, which says which row a piece of news belongs
 * to. Neither is a surface id — Plugins, Skills and Agent CLIs are three rows of
 * ONE surface, and a count keyed on the surface would light all three.
 */
export type ExtensionsDrawerRowId = 'workflows' | 'sprints' | 'design' | 'plugins' | 'skills' | 'agent-clis'

export const DRAWER_ROWS: readonly DrawerRow[] = [
  { kind: 'nav', rowId: 'workflows', entryId: 'workflows' },
  { kind: 'nav', rowId: 'sprints', entryId: 'sprints' },
  { kind: 'surface', rowId: 'design', surfaceId: 'design' },
  { kind: 'view', rowId: 'plugins', surfaceId: 'extensions', viewId: 'plugins' },
  { kind: 'view', rowId: 'skills', surfaceId: 'extensions', viewId: 'skills' },
  { kind: 'view', rowId: 'agent-clis', surfaceId: 'extensions', viewId: 'agent-clis' },
]

export const EXTENSIONS_DRAWER_ROW_IDS: readonly ExtensionsDrawerRowId[] = DRAWER_ROWS.map((row) => row.rowId)

export function isExtensionsDrawerRowId(value: unknown): value is ExtensionsDrawerRowId {
  return typeof value === 'string' && (EXTENSIONS_DRAWER_ROW_IDS as readonly string[]).includes(value)
}

/**
 * Which row the card region is showing, from the open surface and — for the
 * three rows that are views of one surface — the view it stands on. Null while
 * no drawer row is open (the home, a chat, Automations, a surface that is not
 * a row). This is what "opening a row" means to the row's unread count: the
 * moment its page is on screen, its news has been seen.
 */
export function openExtensionsDrawerRow(
  activeGlobalSurface: string | null,
  activeView: string | null,
): ExtensionsDrawerRowId | null {
  if (!activeGlobalSurface) return null
  for (const row of DRAWER_ROWS) {
    if (row.kind === 'nav' && row.entryId === activeGlobalSurface) return row.rowId
    if (row.kind === 'surface' && row.surfaceId === activeGlobalSurface) return row.rowId
    if (row.kind === 'view' && row.surfaceId === activeGlobalSurface && row.viewId === activeView) return row.rowId
  }
  return null
}

/**
 * The surfaces that live UNDER the Extensions glyph: the home the glyph opens,
 * plus every surface the drawer's rows lead to. Opening one of these is a move
 * inside the Extensions section, so the rail glyph follows it and leaving lands
 * back on the drawer rather than on the workspaces tree.
 *
 * Automations is deliberately absent. It stands on the rail because it is what
 * the product DOES rather than something added to it, so opening it must not
 * drag the sidebar into a section it does not belong to — the section glyph
 * that reads current while Automations is open is whichever one was showing.
 */
export const EXTENSIONS_DRAWER_SURFACE_IDS: readonly string[] = [
  ...new Set([
    EXTENSIONS_HOME_SURFACE_ID,
    // A nav row's entry id IS its surface id — that pairing is the door contract
    // (`registerSidebarNavEntry` + `registerGlobalSurface` under one id), which
    // is why Workflows and Sprints belong here without a second list naming
    // them. Deduplicated because three of the six rows are three VIEWS of one
    // surface.
    ...DRAWER_ROWS.map((row) => (row.kind === 'nav' ? row.entryId : row.surfaceId)),
  ]),
]

/** Whether opening this surface is a move inside the Extensions section. */
export function isExtensionsDrawerSurface(surfaceId: string): boolean {
  return EXTENSIONS_DRAWER_SURFACE_IDS.includes(surfaceId)
}

/**
 * Whether this door's rail REPLACES the sidebar column (the context-rail swap,
 * item 1993) or renders beside its own canvas.
 *
 * Default `sidebar`, which is what every door did before the drawer ruling. A
 * door that is itself a row of the drawer declares `inline`: the drawer is the
 * navigation that reached it and must stay put while the card region swaps, so
 * taking the column would delete the column the person is navigating with.
 * Only Sprints — whose rail is its own list of runs — still swaps, and so does
 * Automations, which is not a drawer row at all.
 */
export function surfaceTakesSidebarColumn(
  surface: Pick<RegisteredGlobalSurface, 'railPlacement'> | null | undefined,
): boolean {
  return (surface?.railPlacement ?? 'sidebar') === 'sidebar'
}
