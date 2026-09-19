import assert from 'node:assert/strict'

import { applyChangelistHunks, changelistHunkTargets, type ChangelistHunkApi } from './changelistHunks'
import type { Changelist } from '../../../../../shared/git/changelists'
import type { GitFileHunksResult, GitHunkRef, GitHunkView } from '../../../../../shared/git/hunks'
import { test } from 'vitest'

test('changelistHunks', async () => {
  // Staging a changelist's hunks (agent changelists, Wave 3).
  //
  // The one thing that must be true here: a guest list's tick never puts another
  // list's lines in the index. Everything below is a way of asking that — which
  // hunks are chosen, which side of the index they are taken from, and what
  // happens when one of them cannot be found any more.

  const LISTS: Changelist[] = [
    { id: 'default', name: 'Changes', paths: ['src/a.ts'], active: true },
    {
      id: 'agent:nadia',
      name: 'Nadia',
      paths: [],
      // Nadia wrote lines 10–12 of a file whose home is Changes.
      spans: { 'src/a.ts': [{ start: 10, lines: 3 }] },
      active: false,
      owner: { kind: 'agent', agentId: 'nadia', name: 'Nadia' },
    },
  ]

  function hunk(over: Partial<GitHunkView> & { newStart: number; newLines: number }): GitHunkView {
    return {
      index: 0,
      scope: over.included ? 'staged' : 'unstaged',
      oldStart: over.newStart,
      oldLines: over.newLines,
      fingerprint: `@${over.newStart}`,
      included: false,
      ...over,
    }
  }

  // Nadia's three lines, and two hunks that are nobody's spans — so the remainder
  // rule hands them to the file's home list, Changes.
  const NADIA_HUNK = hunk({ newStart: 10, newLines: 3, index: 1, fingerprint: 'nadia' })
  const HOME_HUNK = hunk({ newStart: 50, newLines: 2, index: 2, fingerprint: 'home' })
  const NADIA_STAGED = hunk({ newStart: 10, newLines: 3, index: 0, fingerprint: 'nadia-in', included: true })

  type Call = { kind: 'stage' | 'unstage'; ref: GitHunkRef }

  function fakeApi(
    hunks: GitHunkView[],
    over: Partial<ChangelistHunkApi> = {},
  ): { api: ChangelistHunkApi; calls: Call[]; reads: Array<[string, string]> } {
    const calls: Call[] = []
    const reads: Array<[string, string]> = []
    const api: ChangelistHunkApi = {
      getGitFileHunks: async (_repoRoot, filePath, scope) => {
        reads.push([filePath, scope])
        return { ok: true, scope, hunks, summary: null, unsupported: null } satisfies GitFileHunksResult
      },
      stageGitHunk: async (ref) => {
        calls.push({ kind: 'stage', ref })
        return { ok: true, stdout: '', stderr: '', message: null }
      },
      unstageGitHunk: async (ref) => {
        calls.push({ kind: 'unstage', ref })
        return { ok: true, stdout: '', stderr: '', message: null }
      },
      ...over,
    }
    return { api, calls, reads }
  }

  const TARGET = { path: '/repo/src/a.ts', relativePath: 'src/a.ts', changelistId: 'agent:nadia' }

  // One `async main`, because the runner bundles to CJS and a top-level await
  // is not a thing there. Every block below is one question.
  async function main(): Promise<void> {
    // ── staging takes this list's hunks, and only the ones not already in ────────
    {
      const { api, calls, reads } = fakeApi([NADIA_HUNK, HOME_HUNK, NADIA_STAGED])
      const outcome = await applyChangelistHunks({
        repoRoot: '/repo',
        changelists: LISTS,
        targets: [TARGET],
        intent: 'stage',
        api,
      })
      assert.deepEqual(outcome, { ok: true, attempted: 1, applied: 1, message: null })
      assert.equal(calls.length, 1, 'one hunk, not the whole file')
      assert.equal(calls[0].kind, 'stage')
      assert.equal(calls[0].ref.fingerprint, 'nadia', 'the hunk Nadia’s spans cover')
      assert.equal(calls[0].ref.scope, 'unstaged', 'staged as a patch of the diff it lives in')
      assert.equal(calls[0].ref.index, 1, 'the index travels as a HINT beside the fingerprint')
      assert.equal(calls[0].ref.filePath, '/repo/src/a.ts')
      assert.deepEqual(reads, [['/repo/src/a.ts', 'unstaged']], 'one read per file')
    }

    // ── unstaging is the same question about the other side of the index ─────────
    {
      const { api, calls, reads } = fakeApi([NADIA_HUNK, HOME_HUNK, NADIA_STAGED])
      const outcome = await applyChangelistHunks({
        repoRoot: '/repo',
        changelists: LISTS,
        targets: [TARGET],
        intent: 'unstage',
        api,
      })
      assert.equal(outcome.applied, 1)
      assert.equal(calls[0].kind, 'unstage')
      assert.equal(calls[0].ref.fingerprint, 'nadia-in', 'the one that IS in the index')
      assert.equal(calls[0].ref.scope, 'staged')
      assert.deepEqual(reads, [['/repo/src/a.ts', 'staged']])
    }

    // ── the home list's own tick takes the remainder, never the guest's lines ────
    {
      const { api, calls } = fakeApi([NADIA_HUNK, HOME_HUNK])
      await applyChangelistHunks({
        repoRoot: '/repo',
        changelists: LISTS,
        targets: [{ ...TARGET, changelistId: 'default' }],
        intent: 'stage',
        api,
      })
      assert.deepEqual(
        calls.map((call) => call.ref.fingerprint),
        ['home'],
        'the remainder rule gives Changes the hunk nobody claimed, and only that one',
      )
    }

    // ── a hunk that would not stage does not cost the others theirs ──────────────
    {
      const both: Changelist[] = [
        { id: 'default', name: 'Changes', paths: ['src/a.ts'], active: true },
        {
          id: 'agent:nadia',
          name: 'Nadia',
          paths: [],
          spans: {
            'src/a.ts': [
              { start: 10, lines: 3 },
              { start: 50, lines: 2 },
            ],
          },
          active: false,
          owner: { kind: 'agent', agentId: 'nadia', name: 'Nadia' },
        },
      ]
      let seen = 0
      const { api, calls } = fakeApi([NADIA_HUNK, HOME_HUNK], {
        stageGitHunk: async () => {
          seen += 1
          return seen === 1
            ? { ok: false, stdout: '', stderr: '', message: 'hunk is gone' }
            : { ok: true, stdout: '', stderr: '', message: null }
        },
      })
      const outcome = await applyChangelistHunks({
        repoRoot: '/repo',
        changelists: both,
        targets: [TARGET],
        intent: 'stage',
        api,
      })
      assert.equal(calls.length, 0, 'the override replaced the recorder; the counts are what is read')
      assert.deepEqual(outcome, { ok: false, attempted: 2, applied: 1, message: 'hunk is gone' })
    }

    // ── a file whose diff cannot be read is named, and the next file still runs ──
    {
      const { api, calls } = fakeApi([NADIA_HUNK], {
        getGitFileHunks: async (_root, filePath) =>
          filePath.endsWith('b.ts')
            ? ({ ok: false, message: 'not a git repository' } satisfies GitFileHunksResult)
            : ({
                ok: true,
                scope: 'unstaged',
                hunks: [NADIA_HUNK],
                summary: null,
                unsupported: null,
              } satisfies GitFileHunksResult),
      })
      const outcome = await applyChangelistHunks({
        repoRoot: '/repo',
        changelists: LISTS,
        targets: [{ path: '/repo/src/b.ts', relativePath: 'src/b.ts', changelistId: 'agent:nadia' }, TARGET],
        intent: 'stage',
        api,
      })
      assert.equal(outcome.ok, false)
      assert.match(outcome.message ?? '', /src\/b\.ts: not a git repository/)
      assert.equal(outcome.applied, 1, 'the readable file was still staged')
      assert.equal(calls.length, 1)
    }

    // ── a binary or untracked file has no hunks to divide, and says so ───────────
    {
      const { api, calls } = fakeApi([], {
        getGitFileHunks: async () =>
          ({
            ok: true,
            scope: 'unstaged',
            hunks: [],
            summary: null,
            unsupported: 'binary',
          }) satisfies GitFileHunksResult,
      })
      const outcome = await applyChangelistHunks({
        repoRoot: '/repo',
        changelists: LISTS,
        targets: [TARGET],
        intent: 'stage',
        api,
      })
      assert.equal(outcome.ok, false)
      assert.match(outcome.message ?? '', /binary/)
      assert.equal(calls.length, 0)
    }

    // ── which rows go down this path at all ──────────────────────────────────────
    {
      const rows = [
        { path: '/repo/src/a.ts', relativePath: 'src/a.ts' },
        { path: '/repo/src/a.ts', relativePath: 'src/a.ts', partial: true, changelistId: 'agent:nadia' },
        { path: '/repo/src/a.ts', relativePath: 'src/a.ts', partial: true, changelistId: 'agent:nadia' },
        { path: '/repo/src/a.ts', relativePath: 'src/a.ts', partial: true, changelistId: 'agent:otto' },
        // A guest row with no list is not a guest row; it would stage nothing.
        { path: '/repo/src/c.ts', relativePath: 'src/c.ts', partial: true },
      ]
      assert.deepEqual(
        changelistHunkTargets(rows).map((target) => target.changelistId),
        ['agent:nadia', 'agent:otto'],
        'whole-file rows stay out of the hunk loop, and one file per list is read once',
      )
    }
  }

  const suiteRun = main().then(() => {
    console.log('ok - a changelist stages its own hunks and nobody else’s')
  })

  await suiteRun
})
