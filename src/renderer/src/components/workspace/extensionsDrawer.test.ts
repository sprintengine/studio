import assert from 'node:assert/strict'

// What the Extensions drawer IS, and the two rules that keep it standing
// (Extensions drawer ruling, 2026-09-05). This is the leaf both the drawer's
// renderer and the store's `openGlobalSurface` read, so the answers here are
// the ones that decide whether the drawer is still on screen after a row is
// clicked — the failure the ruling's Stage 2 exists to prevent.
import {
  DRAWER_ROWS,
  EXTENSIONS_DRAWER_ROW_IDS,
  EXTENSIONS_DRAWER_SURFACE_IDS,
  EXTENSIONS_HOME_SURFACE_ID,
  isExtensionsDrawerRowId,
  isExtensionsDrawerSurface,
  openExtensionsDrawerRow,
  surfaceTakesSidebarColumn,
} from './extensionsDrawer'

// ── The four rows, in the ruled order ────────────────────────────────────────
assert.deepEqual(
  DRAWER_ROWS.map((row) => (row.kind === 'nav' ? row.entryId : row.kind === 'surface' ? row.surfaceId : row.viewId)),
  ['design', 'plugins', 'skills', 'agent-clis'],
  'the drawer is Design · Plugins · Skills · Agent CLIs, and the shell holds that order',
)
assert.deepEqual(
  DRAWER_ROWS.filter((row) => row.kind === 'view').map((row) => (row.kind === 'view' ? row.surfaceId : '')),
  ['extensions', 'extensions', 'extensions'],
  'the last three rows are three views of ONE surface, not three surfaces',
)

// ── Each row's own name ──────────────────────────────────────────────────────
// What a row's unread count is keyed by, and what a notification names to say
// which row it belongs to (owner, 2026-09-08). Not a surface id: three of the
// rows are views of one surface, and a count keyed on it would light all three.
assert.deepEqual([...EXTENSIONS_DRAWER_ROW_IDS], ['design', 'plugins', 'skills', 'agent-clis'])
assert.equal(isExtensionsDrawerRowId('plugins'), true)
assert.equal(isExtensionsDrawerRowId('extensions'), false, 'the surface three rows share is not a row')
assert.equal(isExtensionsDrawerRowId(undefined), false)

// Which row is on screen — the moment its news counts as read.
assert.equal(openExtensionsDrawerRow(null, null), null, 'a chat on screen opens no row')
assert.equal(
  openExtensionsDrawerRow(EXTENSIONS_HOME_SURFACE_ID, null),
  null,
  'the home is not a row; it reads its own cards',
)
assert.equal(openExtensionsDrawerRow('automations', null), null)
assert.equal(openExtensionsDrawerRow('design', null), 'design')
assert.equal(openExtensionsDrawerRow('extensions', 'plugins'), 'plugins')
assert.equal(openExtensionsDrawerRow('extensions', 'skills'), 'skills')
assert.equal(openExtensionsDrawerRow('extensions', 'agent-clis'), 'agent-clis')
assert.equal(
  openExtensionsDrawerRow('extensions', null),
  null,
  'the surface with no view yet has opened no row — Plugins must not read Skills',
)

// ── Which surfaces live under the Extensions glyph ───────────────────────────
// Opening one of these is a move INSIDE the section, so the sidebar follows it
// and leaving lands back on the drawer rather than on the workspaces tree.
assert.deepEqual(
  [...EXTENSIONS_DRAWER_SURFACE_IDS].sort(),
  ['design', 'extensions', 'extensions-home'],
  'the home the glyph opens, plus every surface a row leads to',
)
assert.equal(EXTENSIONS_HOME_SURFACE_ID, 'extensions-home')
for (const id of EXTENSIONS_DRAWER_SURFACE_IDS) {
  assert.equal(isExtensionsDrawerSurface(id), true, `${id} is a drawer surface`)
}
// Automations stands on the RAIL because it is what the product does rather
// than something added to it. Opening it used to flip the sidebar into the
// Extensions drawer, which swapped the column for a section the operator had
// not asked for and lit the Extensions glyph for a surface that is not one of
// its rows.
assert.equal(
  isExtensionsDrawerSurface('automations'),
  false,
  'Automations is not a drawer surface, so opening it leaves the section alone',
)
assert.equal(
  isExtensionsDrawerSurface('acme.compass'),
  false,
  'runtime module doors enter the section through the registry resolver, not the built-in leaf',
)

// ── The drawer stays put ─────────────────────────────────────────────────────
// A door that IS a drawer row must not take the sidebar column: the drawer is
// the navigation that reached it, and taking the column would delete the column
// the person is navigating with. The default is the swap every door made before
// the ruling, so this is opt-OUT and a new drawer door has to say so.
assert.equal(surfaceTakesSidebarColumn({ railPlacement: 'inline' }), false)
assert.equal(surfaceTakesSidebarColumn({ railPlacement: 'sidebar' }), true)
assert.equal(surfaceTakesSidebarColumn({}), true, 'a door that says nothing keeps the context-rail swap')
// No door open is not "a door that keeps its rail": the host reads this to
// decide whether to offer the rail slot at all, and answering true with nothing
// mounted would hide the workspaces tree behind an empty column.
assert.equal(surfaceTakesSidebarColumn(null), true, 'null answers the default, and the host gates on the entry first')

console.log('extensionsDrawer.test.ts: ok')
