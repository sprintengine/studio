import assert from 'node:assert/strict'

import { checkoutPathFor, sweepEntriesFrom } from './useSidebarGitSummaries'

// The sidebar's git poll (the-diff-an-agent-made / branch-scoped-row-diff): the
// membership string round-trips ids and CHECKOUT paths exactly, and a sweep
// walks checkout by checkout so main's per-checkout share sees the rows that
// resolve to one checkout together.

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

run('a sweep is checkout-contiguous and id-ordered within a checkout', () => {
  const membership = ['w3 /repo/b', 'w1 /repo/a', 'w2 /repo/b', 'w4 /repo/a'].join('\u0000')
  assert.deepEqual(sweepEntriesFrom(membership), [
    { id: 'w1', checkoutPath: '/repo/a' },
    { id: 'w4', checkoutPath: '/repo/a' },
    { id: 'w2', checkoutPath: '/repo/b' },
    { id: 'w3', checkoutPath: '/repo/b' },
  ])
})

run('a worktree row sweeps under its worktree, not its folder', () => {
  const membership = ['w1 /repo/main', 'w2 /repo/.worktrees/feat'].join('\u0000')
  assert.deepEqual(sweepEntriesFrom(membership), [
    { id: 'w2', checkoutPath: '/repo/.worktrees/feat' },
    { id: 'w1', checkoutPath: '/repo/main' },
  ])
})

run('paths with spaces round-trip on the first space only', () => {
  const membership = ['w1 /Users/me/My Projects/app'].join('\u0000')
  assert.deepEqual(sweepEntriesFrom(membership), [
    { id: 'w1', checkoutPath: '/Users/me/My Projects/app' },
  ])
})

run('checkoutPathFor resolves the checkout the agents actually work in', () => {
  // A plain workspace reports on its folder.
  assert.equal(checkoutPathFor({ id: 'w1', folderPath: '/repo' } as never), '/repo')
  // A worktree-BACKED workspace already has folderPath pointing at the worktree
  // (see WorkspaceWorktree in types/workspace.ts), so the two agree — asserted so
  // a future change to that contract fails here rather than silently reporting
  // the parent checkout's branch.
  assert.equal(
    checkoutPathFor({
      id: 'w2',
      folderPath: '/repo/.worktrees/feat',
      worktree: { branch: 'feat' },
    } as never),
    '/repo/.worktrees/feat'
  )
  // A sprint run is the case where they genuinely differ: the run's worktree is
  // declared relative to the workspace folder.
  assert.equal(
    checkoutPathFor({
      id: 'w3',
      folderPath: '/repo',
      sprintEngineState: {
        vcs: { mode: 'run_worktree', worktreePath: '.worktrees/run-7', branchName: 'run-7' },
      },
    } as never),
    '/repo/.worktrees/run-7'
  )
  assert.equal(checkoutPathFor({ id: 'w4', folderPath: null } as never), null)
})

run('an empty membership sweeps nothing', () => {
  assert.deepEqual(sweepEntriesFrom(''), [])
})

if (failures > 0) {
  console.error(`useSidebarGitSummaries.test.ts: ${failures} failing`)
  process.exit(1)
}
console.log('useSidebarGitSummaries.test.ts: ok')
