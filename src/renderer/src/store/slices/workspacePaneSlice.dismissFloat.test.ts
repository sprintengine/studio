import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { Workspace, WorkspacePaneState } from '../../types/workspace'
import { createWorkspacePaneSlice } from './workspacePaneSlice'

// Closing the floating player: it goes away without docking, the pane stays
// closed, and the tab is the one the pane shows when it next opens.

const WS = 'ws-dismiss-float'

function carrierWith(paneState: WorkspacePaneState) {
  const workspace = { id: WS, paneState } as unknown as Workspace
  const carrier = { workspaces: [workspace] }
  const slice = createWorkspacePaneSlice((mutator) => mutator(carrier))
  return { slice, pane: () => carrier.workspaces[0].paneState! }
}

const FLOATING: WorkspacePaneState = {
  open: false,
  activeTabId: 'term',
  tabs: [
    { id: 'term', kind: 'terminal', terminalId: 'term-1' },
    { id: 'page', kind: 'browser', url: 'http://localhost:5173/', floating: true },
  ],
}

test('closing the player stops it floating and leaves the pane closed', () => {
  const { slice, pane } = carrierWith(structuredClone(FLOATING))
  slice.dismissPaneTabFloat(WS, 'page')
  assert.equal(pane().tabs.find((tab) => tab.id === 'page')?.floating, undefined)
  assert.equal(pane().open, false)
  assert.equal(pane().tabs.length, 2, 'the tab stays in the strip')
})

test('the closed player is the tab the pane opens on next', () => {
  const { slice, pane } = carrierWith(structuredClone(FLOATING))
  slice.dismissPaneTabFloat(WS, 'page')
  assert.equal(pane().activeTabId, 'page')
  slice.setPaneOpen(WS, true)
  assert.equal(pane().activeTabId, 'page')
})

test('closing a tab that is not floating changes nothing', () => {
  const { slice, pane } = carrierWith(structuredClone(FLOATING))
  const before = pane()
  slice.dismissPaneTabFloat(WS, 'term')
  assert.equal(pane(), before)
})

test('floating for an agent and docking again round-trip through the same actions', () => {
  const { slice, pane } = carrierWith({
    open: false,
    activeTabId: 'page',
    tabs: [{ id: 'page', kind: 'browser', url: 'http://localhost:5173/' }],
  })
  slice.setPaneTabFloating(WS, 'page', true)
  assert.equal(pane().tabs[0]?.floating, true)
  assert.equal(pane().open, false)
  slice.setPaneTabFloating(WS, 'page', false)
  assert.equal(pane().tabs[0]?.floating, undefined)
  assert.equal(pane().open, true)
})
