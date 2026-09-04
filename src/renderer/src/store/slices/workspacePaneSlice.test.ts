import assert from 'node:assert/strict'

import type { Workspace, WorkspacePaneState } from '../../types/workspace'
import {
  createWorkspacePaneSlice,
  normalizeWorkspacePaneState,
  paneStateFromLegacyLayout,
  partializeWorkspacePaneState,
} from './workspacePaneSlice'

function run(name: string, body: () => void): void {
  try {
    body()
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`not ok - ${name}`)
    throw error
  }
}

const WS = 'ws-pane'

function carrierWith(paneState?: WorkspacePaneState) {
  const workspace = { id: WS, paneState } as unknown as Workspace
  const carrier = { workspaces: [workspace] }
  const slice = createWorkspacePaneSlice((mutator) => mutator(carrier))
  return { carrier, slice, pane: () => carrier.workspaces[0].paneState! }
}

// --- the normalizer -------------------------------------------------------

run('an unknown kind, a duplicate id and a second singleton are dropped, not fatal', () => {
  const normalized = normalizeWorkspacePaneState({
    open: true,
    activeTabId: 'gone',
    tabs: [
      { id: 'a', kind: 'files' },
      { id: 'a', kind: 'git' },
      { id: 'b', kind: 'files' },
      { id: 'c', kind: 'nonsense' },
      { id: 'd', kind: 'terminal' },
      { id: 'e', kind: 'terminal', terminalId: 't-1' },
      { id: 'f', kind: 'browser', url: 'http://localhost:5173', faviconUrl: 'data:image/png;base64,AAAA' },
    ],
  })
  assert.deepEqual(normalized, {
    open: true,
    activeTabId: 'a',
    tabs: [
      { id: 'a', kind: 'files' },
      { id: 'e', kind: 'terminal', terminalId: 't-1' },
      { id: 'f', kind: 'browser', url: 'http://localhost:5173', faviconUrl: 'data:image/png;base64,AAAA' },
    ],
  })
  assert.equal(normalizeWorkspacePaneState(undefined), undefined)
  assert.equal(normalizeWorkspacePaneState('nope'), undefined)
})

run('partialize keeps the record but drops the favicon cache', () => {
  const persisted = partializeWorkspacePaneState({
    open: false,
    activeTabId: 'f',
    tabs: [{ id: 'f', kind: 'browser', url: 'http://localhost:5173', faviconUrl: 'data:image/png;base64,AAAA' }],
  })
  assert.deepEqual(persisted, {
    open: false,
    activeTabId: 'f',
    tabs: [{ id: 'f', kind: 'browser', url: 'http://localhost:5173' }],
  })
})

// --- the v73 seed from a rail layout --------------------------------------

run('a layout with Files and Git docked comes back as an open pane with both tabs', () => {
  const seeded = paneStateFromLegacyLayout({
    layout: {
      type: 'row',
      children: [
        { type: 'tabset', children: [{ type: 'tab', component: 'explorer' }, { type: 'tab', component: 'git' }] },
        { type: 'tabset', children: [{ type: 'tab', component: 'agent' }] },
      ],
    },
  })
  assert.ok(seeded)
  assert.equal(seeded.open, true)
  assert.deepEqual(seeded.tabs.map((tab) => tab.kind), ['files', 'git'])
  assert.equal(seeded.activeTabId, seeded.tabs[0].id)
  assert.equal(
    paneStateFromLegacyLayout({ layout: { type: 'row', children: [{ type: 'tabset', children: [{ type: 'tab', component: 'agent' }] }] } }),
    undefined,
    'a layout without either surface seeds nothing',
  )
})

// --- the actions ------------------------------------------------------------

run('openPaneTab opens the pane, activates the tab, and reuses a singleton', () => {
  const { slice, pane } = carrierWith()
  const files = slice.openPaneTab(WS, { kind: 'files' })
  assert.ok(files)
  assert.equal(pane().open, true)
  assert.equal(pane().activeTabId, files)
  const again = slice.openPaneTab(WS, { kind: 'files' })
  assert.equal(again, files, 'Files opens once')
  assert.equal(pane().tabs.length, 1)
  const term1 = slice.openPaneTab(WS, { kind: 'terminal' })
  const term2 = slice.openPaneTab(WS, { kind: 'terminal' })
  assert.notEqual(term1, term2, 'terminals open many')
  assert.ok(pane().tabs.find((tab) => tab.id === term1)?.terminalId, 'a terminal tab mints its pty id')
  assert.equal(pane().activeTabId, term2)
  assert.equal(slice.openPaneTab('missing', { kind: 'files' }), null)
})

run('a background open neither activates nor opens the pane', () => {
  const { slice, pane } = carrierWith({ open: false, activeTabId: null, tabs: [] })
  const id = slice.openPaneTab(WS, { kind: 'browser', url: 'http://localhost:3000', activate: false })
  assert.equal(pane().open, false)
  assert.equal(pane().activeTabId, id, 'the first tab still becomes the remembered active one')
  const second = slice.openPaneTab(WS, { kind: 'browser', activate: false })
  assert.notEqual(pane().activeTabId, second)
})

run('closing the active tab moves to the right neighbour, then the left', () => {
  const { slice, pane } = carrierWith()
  const a = slice.openPaneTab(WS, { kind: 'files' })!
  const b = slice.openPaneTab(WS, { kind: 'git' })!
  const c = slice.openPaneTab(WS, { kind: 'terminal' })!
  slice.setActivePaneTab(WS, b)
  slice.closePaneTab(WS, b)
  assert.equal(pane().activeTabId, c, 'the right neighbour takes over')
  slice.closePaneTab(WS, c)
  assert.equal(pane().activeTabId, a, 'then the left one')
  slice.closePaneTab(WS, a)
  assert.equal(pane().activeTabId, null)
  assert.equal(pane().open, true, 'an emptied pane stays open on its launcher')
})

run('togglePaneKind: absent opens, behind brings forward, showing closes (and the pane when empty)', () => {
  const { slice, pane } = carrierWith()
  assert.equal(slice.togglePaneKind(WS, 'git'), true)
  const git = pane().activeTabId!
  assert.equal(slice.togglePaneKind(WS, 'files'), true)
  assert.notEqual(pane().activeTabId, git)
  assert.equal(slice.togglePaneKind(WS, 'git'), true, 'Git was behind Files: brought forward')
  assert.equal(pane().activeTabId, git)
  assert.equal(pane().tabs.length, 2)
  assert.equal(slice.togglePaneKind(WS, 'git'), false, 'Git was showing: closed')
  assert.equal(pane().tabs.length, 1)
  assert.equal(pane().open, true)
  assert.equal(slice.togglePaneKind(WS, 'files'), false)
  assert.equal(pane().open, false, 'closing the last tab through a toggle closes the pane too')
  slice.setPaneOpen(WS, true)
  assert.equal(pane().open, true)
})

run('updatePaneTab patches a tab and re-normalizes it', () => {
  const { slice, pane } = carrierWith()
  const id = slice.openPaneTab(WS, { kind: 'browser', url: 'http://localhost:5173' })!
  slice.updatePaneTab(WS, id, { title: 'Chat', faviconUrl: 'data:image/png;base64,AAAA' })
  assert.deepEqual(pane().tabs[0], {
    id,
    kind: 'browser',
    url: 'http://localhost:5173',
    title: 'Chat',
    faviconUrl: 'data:image/png;base64,AAAA',
  })
  slice.updatePaneTab(WS, id, { faviconUrl: 'https://not-a-data-url' })
  assert.equal(pane().tabs[0].faviconUrl, undefined, 'a non-data favicon is refused')
})

console.log('workspacePaneSlice tests passed')
