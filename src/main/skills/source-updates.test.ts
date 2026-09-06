// The hourly source update check: one head resolution per repository source,
// drift recorded on the source, and "newly changed" said exactly once.

import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { sourceHasUpdate, type SkillSource } from '../../shared/skills'
import { createSkillSourceStore } from './source-store'
import { createSourceUpdateChecker } from './source-updates'

function source(repo: string, commitSha: string): SkillSource {
  return {
    id: `github:${repo}`,
    kind: 'github',
    name: repo.split('/')[1],
    repo,
    monogram: 'XX',
    blurb: '',
    commitSha,
    scannedAt: '2026-09-05T09:00:00Z',
  }
}

async function main(): Promise<void> {
  const userData = await mkdtemp(join(tmpdir(), 'multicode-source-updates-'))
  const store = createSkillSourceStore(userData)
  await store.putSource(source('anthropics/claude-plugins-official', 'aaa'), null)
  await store.putSource(source('pbakaus/impeccable', 'bbb'), null)
  await store.putSource(source('broken/repo', 'ccc'), null)

  const heads = new Map([
    ['anthropics/claude-plugins-official', 'aaa'],
    ['pbakaus/impeccable', 'bbb2'],
  ])
  const asked: string[] = []
  const checker = createSourceUpdateChecker({
    store,
    resolveToken: async () => '',
    resolveHead: async (candidate) => {
      asked.push(candidate.repo)
      const head = heads.get(candidate.repo)
      if (!head) throw new Error('GitHub replied with HTTP 404.')
      return head
    },
    now: () => new Date('2026-09-05T10:00:00Z'),
  })

  // First check: one source moved, one did not, one could not be asked.
  const first = await checker.check()
  assert.deepEqual(asked, ['anthropics/claude-plugins-official', 'pbakaus/impeccable', 'broken/repo'])
  assert.deepEqual(first.changed, ['github:pbakaus/impeccable'])
  assert.deepEqual(first.newlyChanged, ['github:pbakaus/impeccable'])
  assert.equal(first.failures.length, 1)
  assert.equal(first.failures[0].sourceId, 'github:broken/repo')
  assert.equal(first.sources.length, 2, 'a source that could not be asked is a failure, not a row')

  // The head is written onto the source, so a rail can mark it without a
  // second read, and the built-in sources are never asked.
  const impeccable = await store.getSource('github:pbakaus/impeccable')
  assert.equal(impeccable?.headSha, 'bbb2')
  assert.equal(impeccable?.headCheckedAt, '2026-09-05T10:00:00.000Z')
  assert.equal(sourceHasUpdate(impeccable!), true)
  const official = await store.getSource('github:anthropics/claude-plugins-official')
  assert.equal(official?.headSha, 'aaa')
  assert.equal(sourceHasUpdate(official!), false)

  // Second check, nothing moved further: still changed, not NEWLY changed —
  // the rail keeps its mark and the toast does not fire again.
  const second = await checker.check()
  assert.deepEqual(second.changed, ['github:pbakaus/impeccable'])
  assert.deepEqual(second.newlyChanged, [])

  // The repository moves again: that is new drift, said once more.
  heads.set('pbakaus/impeccable', 'bbb3')
  const third = await checker.check()
  assert.deepEqual(third.newlyChanged, ['github:pbakaus/impeccable'])

  // Concurrent checks share one run.
  const [a, b] = await Promise.all([checker.check(), checker.check()])
  assert.equal(a, b)

  console.log('skills source update tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
