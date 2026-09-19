import assert from 'node:assert/strict'

import {
  branchItemsFrom,
  revsForSelection,
  sameSelection,
  scopeNote,
  selectedEntry,
  stripEntriesFrom,
} from './branchSteps'
import type { BranchStepsSnapshot } from '../../../../shared/electron-api'
import { test } from 'vitest'

test('branchSteps', async () => {
  // The step strip's rules (the-diff-an-agent-made / changed-files-and-commit-steps),
  // tested without Monaco, a repo, or a render.

  let failures = 0
  function run(name: string, fn: () => void): void {
    try {
      fn()
      console.log(`ok - ${name}`)
    } catch (error) {
      failures += 1
      console.error(`not ok - ${name}`)
      console.error(error)
    }
  }

  function step(hash: string, subject: string, isMerge = false) {
    return { hash, shortHash: hash.slice(0, 6), subject, authoredAt: 1, isMerge }
  }

  function snapshot(patch: Partial<BranchStepsSnapshot> = {}): BranchStepsSnapshot {
    return {
      branch: 'feat',
      baseOid: 'base000',
      scope: 'branch',
      steps: [step('aaaaaa1', 'first'), step('bbbbbb2', 'second')],
      hasUncommitted: false,
      ...patch,
    }
  }

  run('the strip is span, then the tail, then commits oldest first', () => {
    const entries = stripEntriesFrom(snapshot({ hasUncommitted: true }))
    assert.deepEqual(
      entries.map((entry) => entry.key),
      ['span', 'uncommitted', 'aaaaaa1', 'bbbbbb2'],
    )
    assert.equal(entries[0].label, 'All commits 2')
  })

  run('with no commits the span is still the one entry, and is operable', () => {
    const entries = stripEntriesFrom(snapshot({ steps: [], hasUncommitted: false }))
    assert.deepEqual(
      entries.map((entry) => entry.key),
      ['span'],
    )
    assert.equal(entries[0].label, 'All changes', 'not "All commits 0"')
  })

  run('an empty commit subject falls back to the hash rather than a blank chip', () => {
    const entries = stripEntriesFrom(snapshot({ steps: [step('cccccc3', '   ')] }))
    assert.equal(entries[1].label, 'cccccc')
  })

  run('a merge step is flagged so the strip can label it', () => {
    const entries = stripEntriesFrom(snapshot({ steps: [step('ddddd44', 'Merge main', true)] }))
    assert.equal(entries[1].isMerge, true)
  })

  run('a null snapshot yields a usable strip rather than nothing', () => {
    assert.deepEqual(
      stripEntriesFrom(null).map((entry) => entry.key),
      ['span'],
    )
  })

  // The case a rebase creates: the hash a person had selected stops existing.
  run('a selection whose commit is gone falls back to the span', () => {
    const entries = stripEntriesFrom(snapshot())
    const resolved = selectedEntry(entries, { kind: 'commit', hash: 'rebased-away' })
    assert.deepEqual(resolved.selection, { kind: 'span' })
  })

  run('a selection that still exists is kept', () => {
    const entries = stripEntriesFrom(snapshot())
    const resolved = selectedEntry(entries, { kind: 'commit', hash: 'bbbbbb2' })
    assert.deepEqual(resolved.selection, { kind: 'commit', hash: 'bbbbbb2' })
  })

  run('sameSelection distinguishes commits but not kinds alone', () => {
    assert.equal(sameSelection({ kind: 'span' }, { kind: 'span' }), true)
    assert.equal(sameSelection({ kind: 'span' }, { kind: 'uncommitted' }), false)
    assert.equal(sameSelection({ kind: 'commit', hash: 'a' }, { kind: 'commit', hash: 'b' }), false)
  })

  run('a commit reads against its parent — which is empty for a root commit', () => {
    assert.deepEqual(revsForSelection({ kind: 'commit', hash: 'abc' }, snapshot()), {
      originalRev: 'abc^',
      modifiedRev: 'abc',
    })
  })

  run('the span reads from the merge-base, and from HEAD when there is none', () => {
    assert.deepEqual(revsForSelection({ kind: 'span' }, snapshot()), {
      originalRev: 'base000',
      modifiedRev: 'worktree',
    })
    assert.deepEqual(revsForSelection({ kind: 'span' }, snapshot({ baseOid: null })), {
      originalRev: 'HEAD',
      modifiedRev: 'worktree',
    })
  })

  run('the uncommitted tail is HEAD against the working tree', () => {
    assert.deepEqual(revsForSelection({ kind: 'uncommitted' }, snapshot()), {
      originalRev: 'HEAD',
      modifiedRev: 'worktree',
    })
  })

  run('an addition has no original side and a deletion has no modified side', () => {
    const items = branchItemsFrom(
      {
        files: [
          { path: 'added.ts', status: 'new', additions: 3, deletions: 0 },
          { path: 'gone.ts', status: 'deleted', additions: 0, deletions: 9 },
          { path: 'edited.ts', status: 'modified', additions: 1, deletions: 1 },
        ],
        additions: 4,
        deletions: 10,
      },
      { kind: 'commit', hash: 'abc' },
      snapshot(),
      '/repo',
    )
    assert.equal(items[0].originalRev, null, 'never asks git for an object it knows is absent')
    assert.equal(items[0].modifiedRev, 'abc')
    assert.equal(items[1].originalRev, 'abc^')
    assert.equal(items[1].modifiedRev, null)
    assert.equal(items[2].originalRev, 'abc^')
    assert.equal(items[2].modifiedRev, 'abc')
    assert.equal(items[0].path, '/repo/added.ts', 'absolute for the worktree reader')
    assert.equal(items[0].relativePath, 'added.ts', 'repo-relative for git')
    assert.equal(items[0].kind, 'branch')
  })

  run('no diff yields no items rather than a broken list', () => {
    assert.deepEqual(branchItemsFrom(null, { kind: 'span' }, snapshot(), '/repo'), [])
  })

  run('the scope note claims only what the checkout supports', () => {
    assert.equal(scopeNote(snapshot({ scope: 'worktree' })), null, 'nothing to qualify')
    const shared = scopeNote(snapshot({ scope: 'branch', branch: 'feat/x' }))
    assert.match(String(shared), /shares its checkout/)
    assert.match(String(shared), /feat\/x/)
    const folder = scopeNote(snapshot({ scope: 'folder', branch: 'main' }))
    assert.match(String(folder), /Working on main/)
    assert.match(String(folder), /not this chat’s work alone/)
    assert.equal(scopeNote(null), null)
  })

  if (failures > 0) {
    console.error(`branchSteps.test.ts: ${failures} failing`)
    process.exit(1)
  }
  console.log('branchSteps.test.ts: ok')
})
