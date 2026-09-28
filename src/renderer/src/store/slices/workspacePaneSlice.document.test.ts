import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { Workspace, WorkspacePaneState } from '../../types/workspace'
import {
  createWorkspacePaneSlice,
  normalizeWorkspacePaneState,
  partializeWorkspacePaneState,
} from './workspacePaneSlice'

// A Document tab reads one markdown file — a plan an agent proposed. It is
// always opened ON a file, so a tab without one is not kept, and a file that
// is already up is focused rather than opened twice.

const PLAN = '/Users/dev/Library/Application Support/app/conversation-plans/abc/ship-the-pane-0123456789ab.md'

function carrierWith(paneState?: WorkspacePaneState) {
  const workspace = { id: 'ws-doc', paneState } as unknown as Workspace
  const carrier = { workspaces: [workspace] }
  const slice = createWorkspacePaneSlice((mutator) => mutator(carrier))
  return { slice, pane: () => carrier.workspaces[0].paneState! }
}

test('opening a document shows it in the pane, and opening it again focuses the same tab', () => {
  const { slice, pane } = carrierWith()
  const first = slice.openPaneTab('ws-doc', { kind: 'document', title: 'Ship the pane', document: { path: PLAN } })
  assert.ok(first)
  assert.equal(pane().open, true)
  assert.equal(pane().activeTabId, first)
  assert.deepEqual(pane().tabs[0], { id: first, kind: 'document', title: 'Ship the pane', document: { path: PLAN } })

  const other = slice.openPaneTab('ws-doc', { kind: 'document', title: 'Another', document: { path: '/tmp/b.md' } })
  assert.notEqual(other, first)
  assert.equal(slice.openPaneTab('ws-doc', { kind: 'document', document: { path: PLAN } }), first)
  assert.equal(pane().tabs.length, 2)
  assert.equal(pane().activeTabId, first)
})

test('a document tab is never opened without a file', () => {
  const { slice, pane } = carrierWith()
  assert.equal(slice.openPaneTab('ws-doc', { kind: 'document' }), null)
  assert.equal(pane().tabs.length, 0)
})

test('the normalizer drops a document tab without an absolute path, and a second tab on one file', () => {
  const normalized = normalizeWorkspacePaneState({
    open: true,
    activeTabId: 'dup',
    tabs: [
      { id: 'a', kind: 'document', document: { path: PLAN } },
      { id: 'dup', kind: 'document', document: { path: PLAN } },
      { id: 'rel', kind: 'document', document: { path: 'plans/a.md' } },
      { id: 'none', kind: 'document' },
      { id: 'f', kind: 'files' },
    ],
  })
  assert.deepEqual(
    normalized?.tabs.map((tab) => tab.id),
    ['a', 'f'],
  )
  // The dropped duplicate's focus goes to the tab that holds the same file.
  assert.equal(normalized?.activeTabId, 'a')
})

test('a document tab persists with its file', () => {
  const persisted = partializeWorkspacePaneState({
    open: true,
    activeTabId: 'a',
    tabs: [{ id: 'a', kind: 'document', title: 'Ship the pane', document: { path: PLAN } }],
  })
  assert.deepEqual(persisted?.tabs, [{ id: 'a', kind: 'document', title: 'Ship the pane', document: { path: PLAN } }])
})
