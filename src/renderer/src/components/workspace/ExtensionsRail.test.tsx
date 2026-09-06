import assert from 'node:assert/strict'

// The sidebar's Extensions section (app shell, 2026-09-05): one list of
// every door and modal surface the modules registered, in registry order, with
// the same row for both. This renders the real surface against the real host
// because the contract is the WIRING — a registered surface becomes a row, the
// row opens it on the local store, and the row reads selected while it is
// open — and none of that shows in a unit test of the registry alone.
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

// ── A modal surface becomes a row that opens it ───────────────────────────────
const host = getRendererHost()
let onOpenCalls = 0
if (!host.getModalSurface('compass-test')) {
  host.hostFor('design').registerModalSurface({
    id: 'compass-test',
    order: 5,
    label: 'Compass',
    Icon: ({ className }: { className?: string }) => React.createElement('svg', { className }),
    // A plain open runs onOpen first — the seam the Plugins surface uses to
    // discard a stale deep-link latch.
    onOpen: () => {
      onOpenCalls += 1
    },
    Component: () => null,
  })
}

// A surface that stands on the app rail (RAIL_SURFACE_IDS) is not an
// extension to the person and is not offered here a second time.
if (!host.getModalSurface('automations')) {
  host.hostFor('design').registerModalSurface({
    id: 'automations',
    order: 1,
    label: 'Automations',
    Icon: ({ className }: { className?: string }) => React.createElement('svg', { className }),
    Component: () => null,
  })
}

render([])
assert.ok(!rowLabels().includes('Automations'), 'a rail-level surface (Automations) is left out of the Extensions list')
const compass = rows().find((row) => row.textContent?.includes('Compass'))
assert.ok(compass, 'a registered modal surface renders as a row of the Extensions list')
assert.equal(compass?.getAttribute('aria-current'), null, 'the row reads unselected while its modal is closed')
act(() => {
  compass?.click()
})
assert.equal(useWorkspaceStore.getState().activeModalSurface, 'compass-test', 'clicking the row opens its modal on the local store')
assert.equal(onOpenCalls, 1, 'a plain row open ran the surface’s onOpen hook first')
assert.equal(
  rows().find((row) => row.textContent?.includes('Compass'))?.getAttribute('aria-current'),
  'true',
  'the row reads selected while its modal is open',
)
act(() => {
  useWorkspaceStore.getState().closeModalSurface()
})

dom.window.document.body.innerHTML = ''

// ── Doors and modals interleave by their declared order ──────────────────────
// A door entry at order 1 sorts before the order-5 modal; one at order 50
// sorts after it. The list is one list — a module places its surface by order
// alone, whichever registry it used.
const doorEntry = (id: string, order: number, label: string): RegisteredSidebarNavEntry => ({
  id,
  order,
  moduleId: 'design',
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
render([doorEntry('late-door', 50, 'Late door'), doorEntry('early-door', 1, 'Early door')])
const labels = rowLabels()
assert.ok(labels.indexOf('Early door') < labels.indexOf('Compass'), 'an order-1 door sorts before the order-5 modal')
assert.ok(labels.indexOf('Compass') < labels.indexOf('Late door'), 'the order-5 modal sorts before an order-50 door')

console.log('ExtensionsRail.test.tsx: ok')
