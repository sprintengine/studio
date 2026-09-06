import assert from 'node:assert/strict'

// The Extensions drawer (Extensions drawer ruling, 2026-09-05): FIVE rows in a
// fixed order — Sprints · Design · Plugins · Skills · Agent CLIs — where the
// last three are three views of the ONE `extensions` surface. This renders the
// real drawer against the real module registry because the contract is the
// WIRING: the ruling's order survives whatever `order` the modules declared, a
// view row opens its surface latched to that view, exactly the row the surface
// is standing on reads selected, and a disabled module's row is simply absent.
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
import { publishModalSurfaceView } from './modalSurfaceView'
import { consumePendingExtensionsSurfaceTarget } from './globalSurface/extensions/extensionsSurfaceTarget'

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
const extensions = getRendererHost().getModalSurface('extensions')
assert.ok(extensions, 'the always-on core registers the extensions surface')
assert.deepEqual(
  extensions?.views?.map((view) => [view.id, view.label]),
  [
    ['plugins', 'Plugins'],
    ['skills', 'Skills'],
    ['agent-clis', 'Agent CLIs'],
  ],
  'one surface, three drawer rows, each named by the module',
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
assert.equal(useWorkspaceStore.getState().activeModalSurface, 'extensions', 'a view row opens the surface that owns it')
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
// The surface publishes its view (modalSurfaceView), so the drawer follows it
// even when the person moved with the surface's own rail rather than a row.
act(() => {
  publishModalSurfaceView('extensions', 'skills')
})
assert.equal(row('Skills')?.getAttribute('aria-current'), 'true', 'the row the surface is standing on reads selected')
assert.equal(row('Plugins')?.getAttribute('aria-current'), null, 'and its siblings do not — one open surface lights one row')
assert.equal(row('Agent CLIs')?.getAttribute('aria-current'), null)

act(() => {
  publishModalSurfaceView('extensions', 'agent-clis')
})
assert.equal(row('Agent CLIs')?.getAttribute('aria-current'), 'true', 'moving the surface moves the selection')
assert.equal(row('Skills')?.getAttribute('aria-current'), null)

act(() => {
  useWorkspaceStore.getState().closeModalSurface()
  publishModalSurfaceView('extensions', null)
})
assert.ok(rows().every((r) => r.getAttribute('aria-current') === null), 'a closed surface lights nothing')

// ── A whole-surface row still opens plainly ──────────────────────────────────
act(() => {
  row('Design')?.click()
})
assert.equal(useWorkspaceStore.getState().activeModalSurface, 'design', 'the Design row opens the design module’s surface')
assert.equal(row('Design')?.getAttribute('aria-current'), 'true', 'and reads selected while it is open')
act(() => {
  useWorkspaceStore.getState().closeModalSurface()
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
