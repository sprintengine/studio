import assert from 'node:assert/strict'

import type { OpenAuxWindowInput } from '../../../shared/electron-api'
import type { WorkspaceId } from '../types/workspace'
import { useWorkspaceStore } from '../store/workspaceStore'
import { openGitDiff } from './openGitDiff'
import { test } from 'vitest'

test('openGitDiff', async () => {
  // `openGitDiff` is the one place that answers "where does a diff open" for the
  // Git panel's rows and the File Explorer's "View Git diff" alike. Both branches
  // are asserted here, because the two used to disagree — the panel always opened
  // a pane tab, the explorer always opened the window — and the preference is the
  // only thing that may decide it now.

  type PaneOpenCall = { workspaceId: string; input: unknown }

  const auxCalls: OpenAuxWindowInput[] = []
  const paneCalls: PaneOpenCall[] = []

  const stored: Record<string, string> = {
    // A remembered window placement, so the aux request is asserted to carry the
    // bounds the last diff window was left at rather than opening at default size.
    'sprintengine.auxWindowPlacement.diff': JSON.stringify({ x: 40, y: 60, width: 900, height: 600 }),
  }

  Object.defineProperty(globalThis, 'window', {
    value: {
      localStorage: {
        getItem: (key: string) => stored[key] ?? null,
        setItem: (key: string, value: string) => {
          stored[key] = value
        },
        removeItem: (key: string) => {
          delete stored[key]
        },
      },
      api: {
        openAuxWindow: async (input: OpenAuxWindowInput) => {
          auxCalls.push(input)
          return { ok: true as const, retargeted: false }
        },
      },
    },
    configurable: true,
  })

  // The pane branch is asserted through the store's own action seam: what matters
  // is the request openGitDiff makes of the pane, and workspacePaneSlice.test.ts
  // owns what the pane then does with it.
  useWorkspaceStore.setState({
    openPaneTab: (workspaceId: WorkspaceId, input: unknown) => {
      paneCalls.push({ workspaceId, input })
      return 'tab-diff'
    },
  } as Partial<ReturnType<typeof useWorkspaceStore.getState>>)

  const target = {
    workspaceId: 'ws-1',
    repoRoot: '/repos/app-worktree',
    focusPath: '/repos/app-worktree/src/a.ts',
    scope: 'unstaged' as const,
  }

  // --- the default: the standalone window -----------------------------------
  useWorkspaceStore.getState().setDiffOpensInWindow(true)
  openGitDiff(target)
  assert.equal(auxCalls.length, 1, 'the preference on routes the diff to the aux window')
  assert.equal(paneCalls.length, 0, 'and never also opens the pane tab')
  assert.equal(auxCalls[0].kind, 'diff')
  assert.equal(auxCalls[0].singletonKey, 'diff', 'one diff window at a time — a repeat retargets it')
  assert.deepEqual(auxCalls[0].params, {
    repoRoot: '/repos/app-worktree',
    focusPath: '/repos/app-worktree/src/a.ts',
    scope: 'unstaged',
    // The workspace travels with the request so the window's "Show in the app"
    // knows which pane to hand the diff back to.
    workspaceId: 'ws-1',
  })
  assert.deepEqual(auxCalls[0].bounds, { x: 40, y: 60, width: 900, height: 600 })

  // --- flipped home: the pane's Diff tab ------------------------------------
  useWorkspaceStore.getState().setDiffOpensInWindow(false)
  openGitDiff({ ...target, focusPath: '/repos/app-worktree/src/b.ts', scope: 'staged' })
  assert.equal(auxCalls.length, 1, 'the preference off opens no window at all')
  assert.equal(paneCalls.length, 1)
  assert.equal(paneCalls[0].workspaceId, 'ws-1')
  assert.deepEqual(paneCalls[0].input, {
    kind: 'diff',
    diff: {
      // The caller's repository, carried to the tab: the pane must not re-derive
      // one from the workspace, which is a different repo for a worktree scope.
      repoRoot: '/repos/app-worktree',
      focusPath: '/repos/app-worktree/src/b.ts',
      focusKind: 'staged',
    },
  })

  // The preference is read per call, not captured once at import.
  useWorkspaceStore.getState().setDiffOpensInWindow(true)
  openGitDiff(target)
  assert.equal(auxCalls.length, 2, 'flipping back routes the next diff to the window again')
  assert.equal(paneCalls.length, 1)

  console.log('openGitDiff.test.ts: ok')
})
