import assert from 'node:assert/strict'

import { gitBadgeMode } from './useGitLineCounts'

// The chrome git button's badge choice (the-diff-an-agent-made /
// git-button-shows-lines). Owner, 2026-09-04: show ±lines, not a file count.

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

run('a clean tree shows no badge at all', () => {
  assert.equal(gitBadgeMode({ hasChanges: false, additions: 0, deletions: 0 }), 'none')
  // Even if a stale count is still in hand from the previous tree.
  assert.equal(gitBadgeMode({ hasChanges: false, additions: 12, deletions: 3 }), 'none')
})

run('a tree with line changes shows the lines', () => {
  assert.equal(gitBadgeMode({ hasChanges: true, additions: 12, deletions: 3 }), 'lines')
  assert.equal(gitBadgeMode({ hasChanges: true, additions: 0, deletions: 4 }), 'lines')
  assert.equal(gitBadgeMode({ hasChanges: true, additions: 4, deletions: 0 }), 'lines')
})

run('untracked-only changes keep the file count rather than going blank', () => {
  // `git diff` cannot see content it has never tracked, so a brand-new file is
  // a change with no ±lines. The button must not read "nothing changed".
  assert.equal(gitBadgeMode({ hasChanges: true, additions: 0, deletions: 0 }), 'files')
})

if (failures > 0) {
  console.error(`useGitLineCounts.test.ts: ${failures} failing`)
  process.exit(1)
}
console.log('useGitLineCounts.test.ts: ok')
