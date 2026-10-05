import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { Workspace, WorkspacePaneState } from '../../types/workspace'
import {
  createWorkspacePaneSlice,
  normalizeWorkspacePaneState,
  partializeWorkspacePaneState,
} from './workspacePaneSlice'

// A pane tab popped out into a window of its own: the mark the pane keeps on
// it, where the pane's own view goes when a tab leaves, how tabs come back, and
// that none of it outlives the session.

const WS = 'ws-pop-out'

function carrierWith(paneState: WorkspacePaneState) {
  const workspace = { id: WS, paneState } as unknown as Workspace
  const carrier = { workspaces: [workspace] }
  const slice = createWorkspacePaneSlice((mutator) => mutator(carrier))
  return { slice, pane: () => carrier.workspaces[0].paneState! }
}

const THREE_TABS: WorkspacePaneState = {
  open: true,
  activeTabId: 'b',
  tabs: [
    { id: 'a', kind: 'files' },
    { id: 'b', kind: 'terminal', terminalId: 'term-b' },
    { id: 'c', kind: 'git' },
  ],
}

test('popping out the tab on screen marks it and shows its right-hand neighbour', () => {
  const { slice, pane } = carrierWith(structuredClone(THREE_TABS))
  slice.popOutPaneTabs(WS, ['b'], 'pop-1')
  assert.equal(pane().tabs.find((tab) => tab.id === 'b')?.poppedOut, 'pop-1')
  assert.equal(pane().tabs.length, 3, 'the tab stays in the strip')
  assert.equal(pane().activeTabId, 'c')
  assert.equal(pane().open, true)
})

test('popping out every tab closes the pane and leaves the one in front selected', () => {
  const { slice, pane } = carrierWith(structuredClone(THREE_TABS))
  slice.popOutPaneTabs(WS, ['a', 'b', 'c'], 'pop-1')
  assert.deepEqual(
    pane().tabs.map((tab) => tab.poppedOut),
    ['pop-1', 'pop-1', 'pop-1'],
  )
  assert.equal(pane().open, false, 'the workspace gets its width back')
  assert.equal(pane().activeTabId, 'b', 'reopened, the pane shows the placeholder for it')
})

test('popping out a tab leaves the selection alone unless the tab on screen is among those going', () => {
  const { slice, pane } = carrierWith(structuredClone(THREE_TABS))
  slice.popOutPaneTabs(WS, ['a'], 'pop-1')
  assert.equal(pane().activeTabId, 'b', 'a tab off screen leaving moves nothing')
  // The person selects the placeholder of a tab already out; a tab opened from
  // its window then joins it. The placeholder stays in front.
  slice.setActivePaneTab(WS, 'a')
  slice.popOutPaneTabs(WS, ['c'], 'pop-1')
  assert.equal(pane().activeTabId, 'a')
  assert.equal(pane().open, true)
})

test('a tab already in one window is not taken by another, and a malformed id marks nothing', () => {
  const { slice, pane } = carrierWith(structuredClone(THREE_TABS))
  slice.popOutPaneTabs(WS, ['a'], 'pop-1')
  slice.popOutPaneTabs(WS, ['a', 'c'], 'pop-2')
  assert.equal(pane().tabs.find((tab) => tab.id === 'a')?.poppedOut, 'pop-1')
  assert.equal(pane().tabs.find((tab) => tab.id === 'c')?.poppedOut, 'pop-2')
  slice.popOutPaneTabs(WS, ['b'], '../not an id')
  assert.equal(pane().tabs.find((tab) => tab.id === 'b')?.poppedOut, undefined)
})

test('a floating player popped out stops floating, and a popped-out tab cannot float', () => {
  const { slice, pane } = carrierWith({
    open: false,
    activeTabId: 'p',
    tabs: [{ id: 'p', kind: 'browser', url: 'http://localhost:5173', floating: true }],
  })
  slice.popOutPaneTabs(WS, ['p'], 'pop-1')
  assert.equal(pane().tabs[0].floating, undefined)
  slice.setPaneTabFloating(WS, 'p', true)
  assert.equal(pane().tabs[0].floating, undefined)
})

test('bringing one tab back docks only that tab and opens the pane on it; closing the window docks the rest', () => {
  const { slice, pane } = carrierWith(structuredClone(THREE_TABS))
  slice.popOutPaneTabs(WS, ['a', 'b', 'c'], 'pop-1')
  slice.dockPaneTabs(WS, 'pop-1', { tabIds: ['c'], activeTabId: 'c' })
  assert.deepEqual(
    pane().tabs.map((tab) => tab.poppedOut ?? null),
    ['pop-1', 'pop-1', null],
  )
  assert.equal(pane().open, true)
  assert.equal(pane().activeTabId, 'c')

  slice.dockPaneTabs(WS, 'pop-1', { activeTabId: 'a' })
  assert.deepEqual(
    pane().tabs.map((tab) => tab.poppedOut ?? null),
    [null, null, null],
  )
  assert.equal(pane().activeTabId, 'a', 'the pane lands on the tab the window had in front')
  // Docked back, never closed: the terminal tab keeps its pty id.
  assert.equal(pane().tabs.find((tab) => tab.id === 'b')?.terminalId, 'term-b')
})

test("docking names one window's tabs and leaves another window's alone", () => {
  const { slice, pane } = carrierWith(structuredClone(THREE_TABS))
  slice.popOutPaneTabs(WS, ['a'], 'pop-1')
  slice.popOutPaneTabs(WS, ['c'], 'pop-2')
  slice.dockPaneTabs(WS, 'pop-1')
  assert.equal(pane().tabs.find((tab) => tab.id === 'a')?.poppedOut, undefined)
  assert.equal(pane().tabs.find((tab) => tab.id === 'c')?.poppedOut, 'pop-2')
})

test('the mark survives every pane write but never a persist', () => {
  const marked: WorkspacePaneState = {
    open: true,
    activeTabId: 'a',
    tabs: [
      { id: 'a', kind: 'files', poppedOut: 'pop-1' },
      { id: 'b', kind: 'browser', url: 'http://localhost:5173', poppedOut: 'pop-1' },
    ],
  }
  assert.deepEqual(
    normalizeWorkspacePaneState(marked)?.tabs.map((tab) => tab.poppedOut),
    ['pop-1', 'pop-1'],
    'the normalizer every write runs keeps it',
  )
  const persisted = partializeWorkspacePaneState(marked)
  assert.deepEqual(persisted?.tabs, [
    { id: 'a', kind: 'files' },
    { id: 'b', kind: 'browser', url: 'http://localhost:5173' },
  ])
  assert.equal(
    normalizeWorkspacePaneState({ ...marked, tabs: [{ id: 'a', kind: 'files', poppedOut: 'x y' }] })?.tabs[0].poppedOut,
    undefined,
    'a mark no window could have is dropped',
  )
})
