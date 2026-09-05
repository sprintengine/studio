import assert from 'node:assert/strict'

import type { SprintEngineVcsRepo } from './run-types'
import { deriveRepoMergeBlockers } from './repo-merge-blockers'

const tests: Array<{ name: string; body: () => void }> = []
function run(name: string, body: () => void): void {
  tests.push({ name, body })
}

const repo = (id: string, over: Partial<SprintEngineVcsRepo> = {}): SprintEngineVcsRepo => ({
  id,
  root: id === 'primary' ? '.' : id,
  worktreePath: `/wt/${id}`,
  branchName: `sprintengine/${id}`,
  pullRequestUrl: `https://gh/${id}`,
  lastCommitSha: 'abc',
  pullRequestState: 'open',
  ...over,
})

run('merge: consumer blocked by unmerged producer', () => {
  // mobile task depends on a primary task → primary produces, mobile consumes.
  const tasks = [
    { id: 't1', repo: 'primary', dependsOn: [] },
    { id: 't2', repo: 'mobile', dependsOn: ['t1'] },
  ]
  const repos = [repo('primary'), repo('mobile')]
  const { blockedBy } = deriveRepoMergeBlockers(tasks, repos)
  assert.deepEqual(blockedBy.get('mobile'), ['primary'])
  assert.equal(blockedBy.has('primary'), false)
})

run('merge: merged producer stops blocking', () => {
  const tasks = [
    { id: 't1', repo: 'primary', dependsOn: [] },
    { id: 't2', repo: 'mobile', dependsOn: ['t1'] },
  ]
  const repos = [repo('primary', { pullRequestState: 'merged' }), repo('mobile')]
  const { blockedBy } = deriveRepoMergeBlockers(tasks, repos)
  assert.equal(blockedBy.has('mobile'), false)
})

run('merge: a producer that delivered nothing blocks nobody', () => {
  const tasks = [
    { id: 't1', repo: 'primary', dependsOn: [] },
    { id: 't2', repo: 'mobile', dependsOn: ['t1'] },
  ]
  // primary delivered nothing (no PR, no commit) → transparent.
  const repos = [repo('primary', { pullRequestUrl: null, lastCommitSha: null }), repo('mobile')]
  const { blockedBy } = deriveRepoMergeBlockers(tasks, repos)
  assert.equal(blockedBy.has('mobile'), false)
})

run('merge: transitive producers surface through a no-op middle repo', () => {
  // a → b → c dependency chain; b delivered nothing so c must wait on a.
  const tasks = [
    { id: 'ta', repo: 'a', dependsOn: [] },
    { id: 'tb', repo: 'b', dependsOn: ['ta'] },
    { id: 'tc', repo: 'c', dependsOn: ['tb'] },
  ]
  const repos = [repo('a'), repo('b', { pullRequestUrl: null, lastCommitSha: null }), repo('c')]
  const { blockedBy } = deriveRepoMergeBlockers(tasks, repos)
  assert.deepEqual(blockedBy.get('c'), ['a'])
})

let failures = 0
for (const test of tests) {
  try {
    test.body()
    console.log(`ok - ${test.name}`)
  } catch (error) {
    failures += 1
    console.error(`not ok - ${test.name}`)
    console.error(error)
  }
}
if (failures > 0) {
  console.error(`repo-merge-blockers.test.ts: ${failures} failing`)
  process.exit(1)
}
console.log('repo-merge-blockers.test.ts: ok')
