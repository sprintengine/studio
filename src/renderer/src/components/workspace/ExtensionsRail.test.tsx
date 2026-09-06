import assert from 'node:assert/strict'

// The Extensions drawer (Extensions drawer ruling, 2026-09-05): FIVE rows in a
// fixed order — Sprints · Design · Plugins · Skills · Agent CLIs — where the
// last three are three views of the ONE `extensions` surface. This renders the
// real drawer against the real module registry because the contract is the
// WIRING: the ruling's order survives whatever `order` the modules declared, a
// row opens a DOOR (Stage 2 — the rows stopped opening modals) latched to its
// view, exactly the row the open surface is standing on reads selected, and a
// disabled module's row is simply absent.
//
// The drawer STAYING PUT is the other half of the ruling, and it is a property
// of the surfaces the rows open rather than of this column: a drawer door
// declares `railPlacement: 'inline'`, so the host withholds the sidebar column
// and the door renders its rail beside its own canvas. Asserted here against
// the live registry, because a door that forgot the declaration would delete
// the very drawer that opened it.
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
domWindow.api = {}

import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { ExtensionsRail } from './ExtensionsRail'
import { getRendererHost } from '../../modules'
import type { RegisteredSidebarNavEntry } from '../../modules/renderer-host'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { SidebarNavButton } from './SidebarNavButton'
import { getSurfaceView, subscribeSurfaceViews } from './surfaceView'
import ExtensionsGlobalSurface from './globalSurface/extensions/ExtensionsGlobalSurface'
import {
  consumePendingExtensionsSurfaceTarget,
  dispatchExtensionsSurfaceTarget,
} from './globalSurface/extensions/extensionsSurfaceTarget'

function render(navEntries: readonly RegisteredSidebarNavEntry[]): HTMLElement {
  const host = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(host)
  const root = createRoot(host as unknown as Element)
  act(() => {
    root.render(React.createElement(ExtensionsRail, { collapsed: false, navEntries }))
  })
  return host
}

const rows = () => [...dom.window.document.querySelectorAll('[role="listitem"] button')] as HTMLElement[]
const rowLabels = () => rows().map((row) => row.textContent?.trim() ?? '')
const row = (label: string) => rows().find((candidate) => candidate.textContent?.trim() === label)

// A door row, as a module registers one. The declared `order` is deliberately
// absurd: the drawer's order is the ruling's, not the registry's.
const doorEntry = (id: string, order: number, label: string): RegisteredSidebarNavEntry => ({
  id,
  order,
  moduleId: 'sprint-engine',
  Component: ({ collapsed }) =>
    React.createElement(SidebarNavButton, {
      collapsed,
      label,
      ariaLabel: label,
      tooltip: label,
      icon: React.createElement('svg'),
      onClick: () => {},
    }),
})

// ── The registry says what a view row IS ─────────────────────────────────────
// The shell holds the ORDER; the agent-runtime module holds what its three rows
// are called, what they look like and how the surface lands on each.
const extensions = getRendererHost().getGlobalSurface('extensions')
assert.ok(extensions, 'the always-on core registers the extensions surface as a DOOR')
assert.equal(extensions?.label, 'Plugins', 'named by the module, not by its id')
assert.deepEqual(
  extensions?.views?.map((view) => [view.id, view.label]),
  [
    ['plugins', 'Plugins'],
    ['skills', 'Skills'],
    ['agent-clis', 'Agent CLIs'],
  ],
  'one surface, three drawer rows, each named by the module',
)

// ── The drawer stays put ─────────────────────────────────────────────────────
// A drawer door must not take the sidebar column: the drawer is the navigation
// that reached it, and the host reads this declaration to decide whether to
// offer the context-rail slot at all.
for (const id of ['design', 'extensions']) {
  assert.equal(
    getRendererHost().getGlobalSurface(id)?.railPlacement,
    'inline',
    `the ${id} door renders its rail beside its canvas, so the drawer survives it`,
  )
}
// Automations is not a drawer row, and its own list of automations IS the
// navigation while it is open — so it keeps the swap every door used to make.
assert.equal(
  getRendererHost().getGlobalSurface('automations')?.railPlacement,
  undefined,
  'Automations takes the sidebar column (the default), because it is not a drawer row',
)

// ── The five rows, in the ruled order ────────────────────────────────────────
render([doorEntry('sprints', 900, 'Sprints'), doorEntry('roadmap', 1, 'Roadmap')])
assert.deepEqual(
  rowLabels(),
  ['Sprints', 'Design', 'Plugins', 'Skills', 'Agent CLIs'],
  'the drawer is exactly the ruling’s five rows, in the ruling’s order — an order-1 door that is not one of them does not appear, and an order-900 Sprints still leads',
)
assert.ok(!rowLabels().includes('Automations'), 'Automations stands on the app rail, not in the drawer')
assert.ok(!rowLabels().includes('Reviews'), 'a registered surface the ruling did not list is not a drawer row')

// ── A view row opens its surface latched to that view ────────────────────────
consumePendingExtensionsSurfaceTarget()
act(() => {
  row('Skills')?.click()
})
assert.equal(useWorkspaceStore.getState().activeGlobalSurface, 'extensions', 'a view row opens the DOOR that owns it')
assert.equal(useWorkspaceStore.getState().activeModalSurface, null, 'and nothing floats over it')
assert.equal(
  consumePendingExtensionsSurfaceTarget(),
  'skills',
  'and latches the view first, so a surface that mounts a tick later still lands on the clicked row',
)

act(() => {
  row('Plugins')?.click()
})
assert.equal(consumePendingExtensionsSurfaceTarget(), 'browse', 'Plugins is the MCP-server catalogue')

// ── Exactly the row the surface stands on reads selected ─────────────────────
// The REAL surface, mounted: the selected row is a contract between the surface
// and this column, and hand-publishing the channel would only prove the column
// reads what it is told. Every publish is recorded, because the sequence
// matters as much as the endpoints — a cleanup that fired on each in-surface
// move published `null` before the new view and the lit row blinked.
const publishes: Array<string | null> = []
const stopWatching = subscribeSurfaceViews(() => publishes.push(getSurfaceView('extensions')))
const surfaceHost = dom.window.document.createElement('div')
dom.window.document.body.appendChild(surfaceHost)
const surfaceRoot = createRoot(surfaceHost as unknown as Element)
act(() => {
  row('Skills')?.click()
})
act(() => {
  surfaceRoot.render(React.createElement(ExtensionsGlobalSurface))
})
assert.equal(row('Skills')?.getAttribute('aria-current'), 'true', 'the row the surface is standing on reads selected')
assert.equal(row('Plugins')?.getAttribute('aria-current'), null, 'and its siblings do not — one open surface lights one row')
assert.equal(row('Agent CLIs')?.getAttribute('aria-current'), null)

// Moving WITH THE SURFACE (a live deep-link, the same seam its own rail uses)
// moves the selection, and never through nothing on the way.
act(() => {
  dispatchExtensionsSurfaceTarget('agent-clis')
})
assert.equal(row('Agent CLIs')?.getAttribute('aria-current'), 'true', 'moving the surface moves the selection')
assert.equal(row('Skills')?.getAttribute('aria-current'), null)
assert.ok(
  publishes.length > 0 && !publishes.slice(0, -1).includes(null),
  `an in-surface move never publishes null on the way (saw ${JSON.stringify(publishes)})`,
)

// Closing takes the selection with it: no row may stay lit over a card region
// the surface no longer owns.
act(() => {
  surfaceRoot.unmount()
  useWorkspaceStore.getState().closeGlobalSurface()
})
assert.equal(publishes.at(-1), null, 'the surface publishes null as it leaves')
assert.ok(rows().every((r) => r.getAttribute('aria-current') === null), 'a closed surface lights nothing')
stopWatching()

// ── A whole-surface row still opens plainly ──────────────────────────────────
act(() => {
  row('Design')?.click()
})
assert.equal(useWorkspaceStore.getState().activeGlobalSurface, 'design', 'the Design row opens the design module’s door')
assert.equal(row('Design')?.getAttribute('aria-current'), 'true', 'and reads selected while it is open')
act(() => {
  useWorkspaceStore.getState().closeGlobalSurface()
})

// ── A disabled module takes its row with it ──────────────────────────────────
dom.window.document.body.innerHTML = ''
act(() => {
  useWorkspaceStore.setState((state) => ({
    appSettings: { ...state.appSettings, modules: { ...state.appSettings.modules, design: false } },
  }))
})
// No Sprints door either: the sidebar filters nav entries by enablement before
// they reach the drawer, so a disabled sprint-engine hands over an empty list.
render([])
assert.deepEqual(
  rowLabels(),
  ['Plugins', 'Skills', 'Agent CLIs'],
  'rows for modules that are off are absent rather than dead, and the rest keep their order',
)

console.log('ExtensionsRail.test.tsx: ok')
