import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { Workspace, WorkspacePaneState } from '../../types/workspace'
import { createWorkspacePaneSlice, normalizeWorkspacePaneState } from './workspacePaneSlice'

// A Diff tab carries the diff tour its viewer has open and an agent's waiting
// offer. Everything else that opens a diff retargets the same tab, and none of
// those writers knows about tours — so neither may lose them.

function carrierWith(paneState: WorkspacePaneState) {
  const workspace = { id: 'ws-tour', paneState } as unknown as Workspace
  const carrier = { workspaces: [workspace] }
  const slice = createWorkspacePaneSlice((mutator) => mutator(carrier))
  return { slice, tab: () => carrier.workspaces[0].paneState!.tabs[0] }
}

test('retargeting a Diff tab keeps the tour it has open and a waiting offer', () => {
  const { slice, tab } = carrierWith({
    open: true,
    activeTabId: 'd1',
    tabs: [
      {
        id: 'd1',
        kind: 'diff',
        diff: { focusPath: null, focusKind: null, tour: { id: 'tour-1', playing: true }, tourOffer: 'tour-2' },
      },
    ],
  })
  slice.openPaneTab('ws-tour', { kind: 'diff', diff: { focusPath: '/Users/dev/app/src/a.ts', focusKind: 'unstaged' } })
  assert.equal(tab().diff?.focusPath, '/Users/dev/app/src/a.ts')
  assert.deepEqual(tab().diff?.tour, { id: 'tour-1', playing: true })
  assert.equal(tab().diff?.tourOffer, 'tour-2')
})

test('the normalizer keeps tour fields and drops malformed ones', () => {
  const normalized = normalizeWorkspacePaneState({
    open: true,
    activeTabId: 'd1',
    tabs: [
      {
        id: 'd1',
        kind: 'diff',
        diff: { focusPath: null, focusKind: null, tour: { id: 'tour-1', playing: true }, tourOffer: 'tour-2' },
      },
      { id: 'd2', kind: 'diff', diff: { focusPath: null, focusKind: null, tour: 'nope', tourOffer: 3 } },
    ],
  } as unknown as WorkspacePaneState)
  assert.ok(normalized)
  assert.deepEqual(normalized.tabs[0].diff?.tour, { id: 'tour-1', playing: true })
  assert.equal(normalized.tabs[0].diff?.tourOffer, 'tour-2')
})
