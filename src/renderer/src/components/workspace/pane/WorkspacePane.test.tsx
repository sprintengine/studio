import assert from 'node:assert/strict'

// The workspace pane's strip and the width a new tab arrives at.
//
// Two rules live here. A new Canvas tab opens docked, like every other kind
// (owner ruling 2026-09-22): it used to maximise the pane, which read as the
// pane opening full screen by default. And a maximised pane shows one
// close-pane control, not two: the strip sits directly under the
// WorkspaceHeader then, whose pane switch is the same control one row up, and
// the header keeps the window's caption corner (paneStripOwnsCaptionCorner).
//
// The tab bodies are stubbed. What is under test is the strip and the store
// calls it makes, not the editors a tab mounts.
import { JSDOM } from 'jsdom'

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, test, vi } from 'vitest'

import type { Workspace, WorkspacePaneState } from '../../../types/workspace'

vi.mock('./WorkspacePaneBody', () => ({
  WorkspacePaneBody: () => null,
}))

const WS = 'ws-pane-strip'

let dom: JSDOM
let root: Root | null = null
let host: HTMLElement | null = null

beforeAll(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  })
  const anyGlobal = globalThis as unknown as Record<string, unknown>
  const domWindow = dom.window as unknown as Record<string, unknown>
  anyGlobal.window = domWindow
  anyGlobal.document = dom.window.document
  anyGlobal.navigator = dom.window.navigator
  anyGlobal.HTMLElement = dom.window.HTMLElement
  anyGlobal.HTMLButtonElement = dom.window.HTMLButtonElement
  anyGlobal.Node = dom.window.Node
  anyGlobal.MouseEvent = dom.window.MouseEvent
  anyGlobal.KeyboardEvent = dom.window.KeyboardEvent
  anyGlobal.CustomEvent = dom.window.CustomEvent
  anyGlobal.getComputedStyle = dom.window.getComputedStyle
  anyGlobal.localStorage = dom.window.localStorage
  anyGlobal.IS_REACT_ACT_ENVIRONMENT = true
  class FakeResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  anyGlobal.ResizeObserver = FakeResizeObserver
  domWindow.ResizeObserver = FakeResizeObserver
  dom.window.matchMedia = ((q: string) => ({
    matches: false,
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  })) as unknown as typeof dom.window.matchMedia
  // win32: the platform whose caption buttons float over the top-right corner.
  // Every bridge call the pane makes answers with nothing.
  domWindow.api = new Proxy({ platform: 'win32' } as Record<string, unknown>, {
    get: (target, key: string) => (key in target ? target[key] : () => Promise.resolve(undefined)),
  })
})

afterEach(() => {
  if (root) act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
})

async function renderPane(paneState: WorkspacePaneState, maximised: boolean): Promise<HTMLElement> {
  const { useWorkspaceStore } = await import('../../../store/workspaceStore')
  useWorkspaceStore.setState({
    workspaces: [
      { id: WS, name: 'Strip', folderPath: '/Users/dev/strip', agents: {}, paneState } as unknown as Workspace,
    ],
    workspacePaneMaximised: maximised,
  })
  const { default: WorkspacePane } = await import('./WorkspacePane')
  host = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(host)
  root = createRoot(host as unknown as Element)
  act(() => {
    root?.render(React.createElement(WorkspacePane, { workspaceId: WS, active: true }))
  })
  return host
}

function button(container: HTMLElement, name: string): HTMLButtonElement | null {
  return (
    [...container.querySelectorAll('button')].find(
      (candidate) => candidate.getAttribute('aria-label') === name || candidate.textContent?.trim().startsWith(name),
    ) ?? null
  )
}

// The strip's trailing caption reserve: the one aria-hidden spacer with an
// inline width, rendered only while the strip owns the caption corner.
function captionReserveWidth(container: HTMLElement): number {
  const spacer = [...container.querySelectorAll<HTMLElement>('div[aria-hidden="true"]')].find(
    (element) => element.style.width !== '',
  )
  return spacer ? Number.parseFloat(spacer.style.width) : 0
}

test('a new Canvas tab opened from the launcher opens docked', async () => {
  const container = await renderPane({ open: true, activeTabId: null, tabs: [] }, false)
  const canvasCard = button(container, 'Canvas')
  assert.ok(canvasCard, 'the empty pane offers a Canvas card')
  act(() => canvasCard.click())

  const { useWorkspaceStore } = await import('../../../store/workspaceStore')
  const state = useWorkspaceStore.getState()
  const pane = state.workspaces.find((workspace) => workspace.id === WS)?.paneState
  assert.equal(pane?.tabs.filter((tab) => tab.kind === 'canvas').length, 1, 'the click made a Canvas tab')
  assert.equal(state.workspacePaneMaximised, false, 'a new Canvas tab leaves the pane docked')
})

test('a docked strip keeps its close-pane control and reserves the caption corner', async () => {
  const container = await renderPane({ open: true, activeTabId: 't1', tabs: [{ id: 't1', kind: 'files' }] }, false)
  assert.ok(button(container, 'Close pane'), 'docked, the strip closes the pane itself')
  assert.ok(button(container, 'Maximise pane'))
  assert.equal(captionReserveWidth(container), 120, 'docked, the strip owns the caption corner on win32')
})

test('a maximised strip shows one close-pane control and leaves the corner to the header', async () => {
  const container = await renderPane({ open: true, activeTabId: 't1', tabs: [{ id: 't1', kind: 'files' }] }, true)
  // A boolean, not the element: a failing assertion that has to print a JSDOM
  // node walks the whole document and runs the worker out of memory.
  assert.equal(button(container, 'Close pane') !== null, false, 'the header pane switch above is the one control')
  assert.ok(button(container, 'Restore pane'), 'restore stays in the strip beside "+"')
  assert.equal(captionReserveWidth(container), 0, 'maximised, the strip sits below the caption buttons')
})

test('exactly one strip owns the caption corner', async () => {
  const { paneStripOwnsCaptionCorner } = await import('../WindowControls')
  assert.equal(paneStripOwnsCaptionCorner({ open: true, maximised: false }), true, 'docked pane: its strip')
  assert.equal(paneStripOwnsCaptionCorner({ open: true, maximised: true }), false, 'maximised pane: the header')
  assert.equal(paneStripOwnsCaptionCorner({ open: false, maximised: false }), false, 'closed pane: the header')
  assert.equal(paneStripOwnsCaptionCorner({ open: false, maximised: true }), false, 'closed pane: the header')
})
