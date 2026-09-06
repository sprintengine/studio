import type { RegisteredGlobalSurface } from '../../modules/renderer-host'

// What the Extensions drawer IS, as data (Extensions drawer ruling, 2026-09-05).
//
// FIVE rows, in a fixed order the owner ruled:
//
//   Sprints · Design · Plugins · Skills · Agent CLIs
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
  | { kind: 'nav'; entryId: string }
  | { kind: 'surface'; surfaceId: string }
  | { kind: 'view'; surfaceId: string; viewId: string }

export const DRAWER_ROWS: readonly DrawerRow[] = [
  { kind: 'nav', entryId: 'sprints' },
  { kind: 'surface', surfaceId: 'design' },
  { kind: 'view', surfaceId: 'extensions', viewId: 'plugins' },
  { kind: 'view', surfaceId: 'extensions', viewId: 'skills' },
  { kind: 'view', surfaceId: 'extensions', viewId: 'agent-clis' },
]

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
    // is why Sprints belongs here without a second list naming it. Deduplicated
    // because three of the five rows are three VIEWS of one surface.
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
