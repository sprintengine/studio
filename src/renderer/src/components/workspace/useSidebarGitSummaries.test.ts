import assert from 'node:assert/strict'

import { sweepEntriesFrom } from './useSidebarGitSummaries'

// The sidebar's git poll (remote-sessions-ux / two-line-session-rows): the
// membership string round-trips ids and paths exactly, and a sweep walks
// folder by folder so main's per-folder fallback share sees one folder's rows
// together (task A of the 2026-09-04 review).

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

run('a sweep is folder-contiguous and id-ordered within a folder', () => {
  const membership = ['w3 /repo/b', 'w1 /repo/a', 'w2 /repo/b', 'w4 /repo/a'].join('\u0000')
  assert.deepEqual(sweepEntriesFrom(membership), [
    { id: 'w1', folderPath: '/repo/a' },
    { id: 'w4', folderPath: '/repo/a' },
    { id: 'w2', folderPath: '/repo/b' },
    { id: 'w3', folderPath: '/repo/b' },
  ])
})

run('paths with spaces round-trip on the first space only', () => {
  const membership = ['w1 /Users/me/My Projects/app'].join('\u0000')
  assert.deepEqual(sweepEntriesFrom(membership), [{ id: 'w1', folderPath: '/Users/me/My Projects/app' }])
})

run('an empty membership sweeps nothing', () => {
  assert.deepEqual(sweepEntriesFrom(''), [])
})

if (failures > 0) {
  console.error(`useSidebarGitSummaries.test.ts: ${failures} failing`)
  process.exit(1)
}
console.log('useSidebarGitSummaries.test.ts: ok')
