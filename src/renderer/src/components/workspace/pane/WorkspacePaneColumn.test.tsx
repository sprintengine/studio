import assert from 'node:assert/strict'

// The pane column while the New chat door is up.
//
// The door belongs to no workspace yet — the chat it starts lands in a
// workspace of its own — so the pane of whichever workspace was showing when
// it opened must not stand beside it. The column collapses as if that pane
// were closed, and keeps the pane mounted so cancelling the door shows it as
// it was. The pane itself is stubbed: what is under test is the column.
import { JSDOM } from 'jsdom'

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, test, vi } from 'vitest'

import type { Workspace } from '../../../types/workspace'

vi.mock('./WorkspacePane', () => ({
  default: ({ workspaceId }: { workspaceId: string }) => React.createElement('div', { 'data-pane-stub': workspaceId }),
}))

const WS = 'ws-pane-column'

let dom: JSDOM
let root: Root | null = null
let host: HTMLElement | null = null

beforeAll(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost', pretendToBeVisual: true })
  const anyGlobal = globalThis as unknown as Record<string, unknown>
  const domWindow = dom.window as unknown as Record<string, unknown>
  anyGlobal.window = domWindow
  anyGlobal.document = dom.window.document
  anyGlobal.navigator = dom.window.navigator
  anyGlobal.HTMLElement = dom.window.HTMLElement
  anyGlobal.Node = dom.window.Node
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
  // Every bridge call answers with nothing; a subscription (`on…`) hands back
  // a no-op unsubscribe.
  domWindow.api = new Proxy({ platform: 'darwin' } as Record<string, unknown>, {
    get: (target, key: string) => {
      if (key in target) return target[key]
      return key.startsWith('on') ? () => () => undefined : () => Promise.resolve(undefined)
    },
  })
})

afterEach(() => {
  if (root) act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
})

async function renderColumn(suppressed: boolean): Promise<HTMLElement> {
  const { useWorkspaceStore } = await import('../../../store/workspaceStore')
  useWorkspaceStore.setState({
    workspaces: [
      {
        id: WS,
        name: 'Previous chat',
        folderPath: '/Users/dev/app',
        agents: {},
        paneState: { open: true, activeTabId: 't1', tabs: [{ id: 't1', kind: 'canvas' }] },
      } as unknown as Workspace,
    ],
    workspacePaneMaximised: false,
  })
  const { WorkspacePaneColumn } = await import('./WorkspacePaneColumn')
  host = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(host)
  root = createRoot(host as unknown as Element)
  act(() => {
    root?.render(
      React.createElement(WorkspacePaneColumn, { activeWorkspaceId: WS, renderedWorkspaceIds: [WS], suppressed }),
    )
  })
  return host
}

function column(container: HTMLElement): HTMLElement {
  const element = container.querySelector<HTMLElement>('[aria-label="Workspace pane"]')
  assert.ok(element, 'the column renders')
  return element
}

test('an open pane shows beside its workspace', async () => {
  const container = await renderColumn(false)
  assert.equal(column(container).getAttribute('aria-hidden'), null, 'the column is shown')
})

test('the New chat door collapses the pane of the workspace behind it, and keeps it mounted', async () => {
  const container = await renderColumn(true)
  assert.equal(column(container).getAttribute('aria-hidden'), 'true', 'the column collapses behind the door')
  assert.ok(container.querySelector(`[data-pane-stub="${WS}"]`), 'the pane stays mounted for when the door closes')
})
