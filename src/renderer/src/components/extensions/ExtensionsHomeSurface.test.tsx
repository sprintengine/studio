import assert from 'node:assert/strict'

// The Extensions home's tile contract (Extensions drawer ruling, 2026-09-05,
// Stage 3): five tiles, in the drawer's order, opening exactly what the drawer
// rows open, and absent for a module that is switched off.
//
// Mounted against the REAL module registry, like the drawer's own test, because
// the contract is the WIRING. The ruling's words are "tiles ... that open the
// same surfaces the drawer rows do", and the only way to prove "the same" is to
// click both and compare the state each leaves behind — a tile asserted against
// a hand-written expectation would keep passing on the day a view's deep-link
// latch changed under it and only the drawer was updated.
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost', pretendToBeVisual: true })
const anyGlobal = globalThis as unknown as Record<string, unknown>
const domWindow = dom.window as unknown as Record<string, unknown>
anyGlobal.window = domWindow
anyGlobal.document = dom.window.document
anyGlobal.navigator = dom.window.navigator
anyGlobal.HTMLElement = dom.window.HTMLElement
anyGlobal.HTMLInputElement = dom.window.HTMLInputElement
anyGlobal.Node = dom.window.Node
anyGlobal.MouseEvent = dom.window.MouseEvent
anyGlobal.KeyboardEvent = dom.window.KeyboardEvent
anyGlobal.CustomEvent = dom.window.CustomEvent
anyGlobal.getComputedStyle = dom.window.getComputedStyle
anyGlobal.localStorage = dom.window.localStorage
anyGlobal.IS_REACT_ACT_ENVIRONMENT = true
class FakeResizeObserver { observe() {} unobserve() {} disconnect() {} }
anyGlobal.ResizeObserver = FakeResizeObserver
domWindow.ResizeObserver = FakeResizeObserver
dom.window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} })) as unknown as typeof dom.window.matchMedia
// The page's five readers, stubbed at the preload boundary. The two that are
// absent here (`skillsListSources`, `listDesignSystemLibrary`) are absent on
// purpose: every reader is guarded, and a missing one must leave its tile
// standing with no count line rather than taking the tile down with it.
domWindow.api = {
  listSprintRuns: async () => [],
  onSprintRunsChanged: () => () => {},
}

import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import ExtensionsHomeSurface from './ExtensionsHomeSurface'
import { EXTENSIONS_HOME_TILE_SUMMARIES } from './extensionsHomeTiles'
import { ExtensionsRail } from '../workspace/ExtensionsRail'
import { getRendererHost } from '../../modules'
import type { RegisteredSidebarNavEntry } from '../../modules/renderer-host'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { consumePendingExtensionsSurfaceTarget } from '../workspace/globalSurface/extensions/extensionsSurfaceTarget'

const RULED_ORDER = ['Sprints', 'Design', 'Plugins', 'Skills', 'Agent CLIs']

function mount(element: React.ReactElement): { host: HTMLElement; unmount: () => void } {
  const host = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(host)
  const root = createRoot(host as unknown as Element)
  act(() => {
    root.render(element)
  })
  return {
    host,
    unmount: () => {
      act(() => root.unmount())
      host.remove()
    },
  }
}

const tilesIn = (host: HTMLElement) => [...host.querySelectorAll('ul button')] as HTMLElement[]
// The name is the tile's first span that is not decorative — the glyph and the
// chevron wrappers are `aria-hidden`, which is both correct markup and what
// makes the name findable without depending on child order.
const nameOf = (tile: HTMLElement) =>
  tile.querySelector(':scope > span:not([aria-hidden])')?.textContent?.trim() ?? ''

// ── Five tiles, in the drawer's order ────────────────────────────────────────
const home = mount(React.createElement(ExtensionsHomeSurface))
assert.deepEqual(
  tilesIn(home.host).map(nameOf),
  RULED_ORDER,
  'the home is the ruling’s five parts in the ruling’s order — the same list the drawer holds, resolved by the same function',
)

// Each tile is a real button carrying its own name as text, so it is in the tab
// order, has an accessible name without an aria-label, and is operable from the
// keyboard by being a button at all.
for (const tile of tilesIn(home.host)) {
  assert.equal(tile.tagName, 'BUTTON', 'a tile is a button, not a div with a click handler')
  assert.equal(tile.getAttribute('type'), 'button')
  const name = nameOf(tile)
  assert.ok(name.length > 0, 'a tile names itself in text')
  // The glyph and the chevron say nothing a reader needs — the name is already
  // there — so neither may be announced.
  for (const svg of [...tile.querySelectorAll('svg')]) {
    assert.equal(svg.getAttribute('aria-hidden'), 'true', `${name}: a decorative glyph is hidden from readers`)
  }
}

// Each tile carries the summary its id was given, on the tile it belongs to —
// a copy table keyed by the wrong id would swap two sentences silently.
const summaryFor: Record<string, string> = {
  Sprints: EXTENSIONS_HOME_TILE_SUMMARIES.sprints,
  Design: EXTENSIONS_HOME_TILE_SUMMARIES.design,
  Plugins: EXTENSIONS_HOME_TILE_SUMMARIES.plugins,
  Skills: EXTENSIONS_HOME_TILE_SUMMARIES.skills,
  'Agent CLIs': EXTENSIONS_HOME_TILE_SUMMARIES['agent-clis'],
}
for (const tile of tilesIn(home.host)) {
  const name = nameOf(tile)
  assert.ok(
    tile.textContent?.includes(summaryFor[name]),
    `${name}: the tile carries its own one-line summary`,
  )
}

// ── The Community section stays, and there is no module list ─────────────────
assert.ok(
  home.host.textContent?.includes('Community') && home.host.textContent.includes('Coming soon'),
  'the Community section keeps its heading and its tag',
)
assert.ok(
  home.host.textContent?.includes(
    'A browse of modules other people have published, with search and one-click install, will be listed here once the registry scan lands.',
  ),
  'and the ruling’s copy, word for word',
)
assert.equal(
  [...home.host.querySelectorAll('input[type="checkbox"], [role="switch"]')].length,
  0,
  'no module switches here: those live in Settings → Modules, and one choice in two shapes on two surfaces is the thing Stage 2 removed',
)

// ── A tile opens EXACTLY what the drawer row opens ───────────────────────────
// The drawer's Sprints row is the sprint-engine module's OWN lazy component,
// which a Suspense boundary in this bundle has nothing to show for — so the
// drawer draws four of the five rows here and the home draws all five (a tile
// is built from the door's declared label and glyph, with no component to
// load). The four the shell draws are the real ones, resolved from the real
// registry by the function both surfaces call.
const drawer = mount(React.createElement(ExtensionsRail, { collapsed: false }))
const drawerRows = () => [...drawer.host.querySelectorAll('[role="listitem"] button')] as HTMLElement[]
const SHELL_DRAWN = RULED_ORDER.filter((label) => label !== 'Sprints')
assert.deepEqual(
  drawerRows().map((row) => row.textContent?.trim()),
  SHELL_DRAWN,
  'the drawer and the home are the same rows in the same order — they are resolved by one function',
)
assert.equal(
  drawer.host.querySelectorAll('[role="listitem"]').length,
  RULED_ORDER.length,
  'and the Sprints slot is there, holding its module’s own row',
)

/** What clicking left behind: the routed surface, and the view it was latched to. */
function landing(click: () => void): { surface: string | null; view: string | null } {
  act(() => {
    useWorkspaceStore.getState().closeGlobalSurface()
  })
  consumePendingExtensionsSurfaceTarget()
  act(click)
  return {
    surface: useWorkspaceStore.getState().activeGlobalSurface,
    view: consumePendingExtensionsSurfaceTarget(),
  }
}

for (const label of SHELL_DRAWN) {
  const row = drawerRows().find((candidate) => candidate.textContent?.trim() === label)
  const tile = tilesIn(home.host).find((candidate) => nameOf(candidate) === label)
  assert.ok(row && tile, `${label}: both the drawer row and the tile exist`)
  const fromRow = landing(() => row.click())
  const fromTile = landing(() => tile.click())
  assert.deepEqual(
    fromTile,
    fromRow,
    `${label}: the tile lands where the row lands — same surface, same latched view`,
  )
  assert.ok(fromTile.surface, `${label}: and clicking it actually routes the card region somewhere`)
}

// A sprint door already open does not change what the next tile does: the view
// latches before the shell opens, exactly as a drawer row does, so an
// already-open surface and a cold one both land on the tile that was clicked.
act(() => {
  useWorkspaceStore.getState().openGlobalSurface('sprints')
})
consumePendingExtensionsSurfaceTarget()
act(() => {
  tilesIn(home.host).find((tile) => nameOf(tile) === 'Skills')?.click()
})
assert.equal(useWorkspaceStore.getState().activeGlobalSurface, 'extensions')
assert.deepEqual(
  consumePendingExtensionsSurfaceTarget(),
  { view: 'skills' },
  'a tile clicked over an open door latches its view first, like the row does',
)
act(() => {
  useWorkspaceStore.getState().closeGlobalSurface()
})

// ── A disabled module takes its tile with it, as it takes its row ────────────
act(() => {
  useWorkspaceStore.setState((state) => ({
    appSettings: { ...state.appSettings, modules: { ...state.appSettings.modules, design: false } },
  }))
})
assert.deepEqual(
  tilesIn(home.host).map(nameOf),
  ['Sprints', 'Plugins', 'Skills', 'Agent CLIs'],
  'a tile for a module that is off is absent rather than dead, and the rest keep their order',
)
assert.deepEqual(
  drawerRows().map((row) => row.textContent?.trim()),
  tilesIn(home.host).map(nameOf).filter((label) => label !== 'Sprints'),
  'and the drawer says the same thing at the same moment',
)

home.unmount()
drawer.unmount()
console.log('ExtensionsHomeSurface.test.tsx: ok')
