import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ScanResult, SkillSource } from '../../shared/skills'
import { createSkillSourceStore, parseSkillSourceState } from './source-store'

// What the store owes: a source a person added survives the write→read round
// trip, and the scan cached beside it never outlives it.
//
// The kind check in `isPersistableSource` is the sharp edge. It is the last
// thing between a source and the disk, and a kind it does not name is dropped
// on the very NEXT read — which is what happened to the folder sources the
// source-tabs ruling added (2026-09-05): `addLocalSource` reported success, the
// surface opened the tab, and the source was gone by the time anything read the
// list again, leaving its scan behind as an orphan that every later write
// persisted afresh.

function run(name: string, body: () => Promise<void> | void): Promise<void> | void {
  const done = (): void => console.log(`ok - ${name}`)
  try {
    const result = body()
    if (result instanceof Promise) {
      return result.then(done, (error) => {
        console.error(`not ok - ${name}`)
        throw error
      })
    }
    done()
  } catch (error) {
    console.error(`not ok - ${name}`)
    throw error
  }
}

const scanOf = (skillId: string): ScanResult => ({
  skills: [
    {
      id: skillId,
      name: skillId,
      description: '',
      group: '',
      files: [{ path: 'SKILL.md', size: 10, blobSha: '', isEntry: true }],
      allowedTools: [],
      hasExecutables: false,
    },
  ],
  groups: [],
  groupingSignal: 'none',
  fileCount: 1,
  commitSha: '',
})

const FOLDER: SkillSource = {
  id: 'local:/Users/me/work/skills',
  kind: 'local',
  name: 'skills',
  repo: '',
  path: '/Users/me/work/skills',
  monogram: 'SK',
  blurb: '/Users/me/work/skills',
  commitSha: '',
  scannedAt: '2026-09-05T12:00:00.000Z',
}

const REPO: SkillSource = {
  id: 'github:acme/skills',
  kind: 'github',
  name: 'skills',
  repo: 'acme/skills',
  monogram: 'AS',
  blurb: '',
  commitSha: 'abc1234',
  scannedAt: '2026-09-05T12:00:00.000Z',
}

async function main(): Promise<void> {
  await run('a folder source survives the write and the read that follows it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'multicode-source-store-'))
    const store = createSkillSourceStore(dir)
    await store.putSource(FOLDER, scanOf('tdd'))

    // A second store over the same directory is the next read: nothing is kept
    // in memory between them, which is exactly the trip the folder failed.
    const reopened = createSkillSourceStore(dir)
    const listed = await reopened.listSources()
    assert.deepEqual(
      listed.map((source) => source.id),
      ['builtin', 'connectors', FOLDER.id],
      'the folder is in the list beside the two the app always has',
    )
    const found = await reopened.getSource(FOLDER.id)
    assert.ok(found, 'and it can be opened by id')
    assert.equal(found?.kind, 'local')
    assert.equal(found?.path, FOLDER.path, 'the path is its whole identity, so it has to come back')
    const scan = await reopened.getScan(FOLDER.id)
    assert.equal(scan?.skills.length, 1, 'and the scan cached beside it comes back too')
  })

  await run('a repository source still round-trips', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'multicode-source-store-'))
    const store = createSkillSourceStore(dir)
    await store.putSource(REPO, scanOf('research'))
    const reopened = createSkillSourceStore(dir)
    assert.equal((await reopened.getSource(REPO.id))?.repo, 'acme/skills')
  })

  await run('a removed source takes its scan with it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'multicode-source-store-'))
    const store = createSkillSourceStore(dir)
    await store.putSource(FOLDER, scanOf('tdd'))
    await store.removeSource(FOLDER.id)
    const reopened = createSkillSourceStore(dir)
    assert.equal(await reopened.getScan(FOLDER.id), null)
    const raw = JSON.parse(readFileSync(join(dir, 'skill-sources.json'), 'utf8')) as {
      scans: Record<string, unknown>
    }
    assert.deepEqual(Object.keys(raw.scans), [], 'and leaves nothing on disk to grow')
  })

  await run('a scan naming a source the read dropped is pruned, never re-persisted', async () => {
    // A source of a kind this build does not know — a store written by a newer
    // one, or a hand-edit. It is dropped, and its scan must not survive it: an
    // orphan scan is a cache of a source nobody can open, and every later write
    // would copy it forward.
    const state = parseSkillSourceState(
      JSON.stringify({
        sources: [FOLDER, { ...REPO, id: 'future:thing', kind: 'future' }],
        scans: {
          [FOLDER.id]: scanOf('tdd'),
          'future:thing': scanOf('nope'),
          'github:gone/away': scanOf('gone'),
        },
        adoptedLegacyPacks: false,
      }),
    )
    assert.deepEqual(state.sources.map((source) => source.id), [FOLDER.id])
    assert.deepEqual(Object.keys(state.scans), [FOLDER.id])
  })

  await run('a folder with no path is not a folder source', async () => {
    const state = parseSkillSourceState(
      JSON.stringify({ sources: [{ ...FOLDER, path: '' }], scans: {}, adoptedLegacyPacks: false }),
    )
    assert.deepEqual(state.sources, [], 'a path is the only identity it has')
  })

  console.log('skill source store: ok')
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
