import assert from 'node:assert/strict'

// The app rail (app shell, 2026-09-05, glyphs-only ruling): a fixed
// column of named glyphs. The contract is the WIRING — a section glyph selects
// its section, a promoted surface glyph opens its surface and reads pressed
// while it floats, and no glyph spells its name as row text.
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
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { RegisteredModalSurface } from '../../modules/renderer-host'
import { APP_RAIL_WIDTH, AppRail, RAIL_SURFACE_IDS, TRAFFIC_LIGHT_RESERVE, isRailSurface, railSurfacesOf } from './AppRail'

const surface = (id: string, label: string, order: number): RegisteredModalSurface => ({
  id,
  moduleId: 'design',
  order,
  label,
  Icon: ({ className }: { className?: string }) => React.createElement('svg', { className }),
  Component: () => null,
})

// ── The pure picks ────────────────────────────────────────────────────────────
assert.deepEqual([...RAIL_SURFACE_IDS], ['automations', 'extensions'], 'Automations then Plugins stand on the rail')
assert.ok(isRailSurface('automations') && !isRailSurface('reviews'))
{
  // Rail order, not registry order; a surface the host filtered out is absent.
  const picked = railSurfacesOf([surface('reviews', 'Reviews', 1), surface('extensions', 'Plugins', 10), surface('automations', 'Automations', 20)])
  assert.deepEqual(picked.map((s) => s.id), ['automations', 'extensions'])
  assert.deepEqual(railSurfacesOf([surface('extensions', 'Plugins', 10)]).map((s) => s.id), ['extensions'])
}
assert.ok(APP_RAIL_WIDTH < TRAFFIC_LIGHT_RESERVE, 'the rail is narrower than the traffic lights, so the sidebar chrome insets for the rest')

// ── The rendered rail ─────────────────────────────────────────────────────────
const selected: string[] = []
const opened: string[] = []
function render(section: 'home' | 'extensions', activeModalSurface: string | null) {
  const host = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(host)
  const root = createRoot(host as unknown as Element)
  act(() => {
    root.render(
      React.createElement(AppRail, {
        section,
        onSelectSection: (next) => selected.push(next),
        surfaces: [surface('automations', 'Automations', 20), surface('extensions', 'Plugins', 10)],
        activeModalSurface,
        onOpenSurface: (s) => opened.push(s.id),
      }),
    )
  })
  return host
}
const buttons = () => [...dom.window.document.querySelectorAll('nav[aria-label="App rail"] button')] as HTMLElement[]

render('home', null)
assert.deepEqual(
  buttons().map((b) => b.getAttribute('aria-label')),
  ['Home', 'Automations', 'Plugins', 'Extensions'],
  'four named glyphs, Home first and Extensions last, the promoted surfaces between',
)
assert.ok(buttons().every((b) => (b.textContent ?? '').trim() === ''), 'a glyph spells no caption: its name is the tooltip and the accessible name')
assert.equal(buttons()[0]?.getAttribute('aria-current'), 'page', 'the showing section reads current')
assert.equal(buttons()[3]?.getAttribute('aria-current'), null)
assert.equal(buttons()[1]?.getAttribute('aria-pressed'), 'false', 'a surface glyph reads unpressed while its surface is closed')

act(() => { buttons()[3]?.click() })
assert.deepEqual(selected, ['extensions'], 'the Extensions glyph selects its section (the host opens the marketplace with it)')
act(() => { buttons()[1]?.click() })
assert.deepEqual(opened, ['automations'], 'a surface glyph opens its surface')

dom.window.document.body.innerHTML = ''
render('extensions', 'extensions')
assert.equal(buttons()[3]?.getAttribute('aria-current'), 'page')
assert.equal(buttons()[2]?.getAttribute('aria-pressed'), 'true', 'Plugins reads pressed while its surface floats')

console.log('AppRail.test.tsx: ok')
