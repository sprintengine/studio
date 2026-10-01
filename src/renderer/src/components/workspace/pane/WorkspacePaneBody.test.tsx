import assert from 'node:assert/strict'

// A closed pane with a floating player: the column is zero wide but stays
// interactive (the player paints outside it and has to be dragged), so it is
// not `inert`, and the docked layers under it need their own mark for the
// idle-animation pause in assets/index.css. The floating layer is on screen
// and must not carry it.
import { JSDOM } from 'jsdom'

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, test, vi } from 'vitest'

import type { WorkspacePaneTab } from '../../../types/workspace'

vi.mock('./FloatingPlayer', () => ({
  FLOATING_PAGE_INSET: 24,
  FloatingPlayerChrome: () => null,
  useFloatRect: (_workspaceId: string, tab: WorkspacePaneTab | null) =>
    tab ? { left: 10, top: 10, width: 320, height: 200 } : null,
}))
vi.mock('./browser/BrowserTab', () => ({ BrowserTab: () => null }))

let dom: JSDOM
let root: Root | null = null
let host: HTMLElement | null = null

beforeAll(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost', pretendToBeVisual: true })
  const anyGlobal = globalThis as unknown as Record<string, unknown>
  anyGlobal.window = dom.window
  anyGlobal.document = dom.window.document
  anyGlobal.navigator = dom.window.navigator
  anyGlobal.HTMLElement = dom.window.HTMLElement
  anyGlobal.Node = dom.window.Node
  anyGlobal.IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(() => {
  if (root) act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
})

const tabs: WorkspacePaneTab[] = [
  // A terminal tab with no terminal renders its unavailable note: a real
  // layer, with nothing lazy under it.
  { id: 'docked', kind: 'terminal' } as WorkspacePaneTab,
  { id: 'player', kind: 'browser', floating: true } as WorkspacePaneTab,
]

async function layers(collapsed: boolean): Promise<Map<string, Element>> {
  const { WorkspacePaneBody } = await import('./WorkspacePaneBody')
  host = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(host)
  root = createRoot(host as unknown as Element)
  act(() => {
    root?.render(
      React.createElement(WorkspacePaneBody, {
        workspaceId: 'ws',
        tabs,
        activeTabId: 'player',
        selectedTabId: 'docked',
        collapsed,
      }),
    )
  })
  return new Map([...host.querySelectorAll('[role="tabpanel"]')].map((layer) => [layer.id, layer] as const))
}

test('a closed pane marks its docked layers still, and leaves the floating player running', async () => {
  const closed = await layers(true)
  assert.equal(closed.get('pane-ws-panel-docked')?.hasAttribute('data-pane-collapsed'), true)
  assert.equal(closed.get('pane-ws-panel-player')?.hasAttribute('data-pane-collapsed'), false)
  assert.equal(closed.get('pane-ws-panel-docked')?.hasAttribute('inert'), false)
})

test('an open pane marks nothing', async () => {
  const open = await layers(false)
  for (const layer of open.values()) assert.equal(layer.hasAttribute('data-pane-collapsed'), false)
})
