import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  OFFICIAL_PLUGINS_SKILL_SOURCE_ID,
  sourceHasUpdate,
  OFFICIAL_PLUGINS_SKILL_SOURCE_NAME,
  STUDIO_SKILL_SOURCE_ID,
  STUDIO_SKILL_SOURCE_NAME,
  STUDIO_SKILL_SOURCE_REPO,
  type ScanResult,
  type SkillSource,
} from '../../shared/skills'
import {
  createSkillSourceStore,
  isRemovableSkillSource,
  parseSkillSourceState,
  type SkillSourceLog,
} from './source-store'

/** Every line the store wrote, for the cases that are about the log itself. */
function recorder(): { log: SkillSourceLog; lines: { event: string; detail: Record<string, unknown> }[] } {
  const lines: { event: string; detail: Record<string, unknown> }[] = []
  return { lines, log: (event, detail) => lines.push({ event, detail }) }
}

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
      [STUDIO_SKILL_SOURCE_ID, OFFICIAL_PLUGINS_SKILL_SOURCE_ID, FOLDER.id],
      'the folder is in the list beside the ones the app always has',
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
      }),
    )
    assert.deepEqual(
      state.sources.map((source) => source.id),
      [FOLDER.id],
    )
    assert.deepEqual(Object.keys(state.scans), [FOLDER.id])
  })

  await run('a folder with no path is not a folder source', async () => {
    const state = parseSkillSourceState(JSON.stringify({ sources: [{ ...FOLDER, path: '' }], scans: {} }))
    assert.deepEqual(state.sources, [], 'a path is the only identity it has')
  })

  await run('the official marketplace is always present, and keeps what a scan of it wrote', async () => {
    // It is a repository like any the user adds — read over the network, at a
    // commit — and differs only in that it is present before anyone adds it and
    // cannot be taken away (official-plugins ruling, 2026-09-06). So the scan
    // cached beside it, and the commit that scan was taken at, have to survive
    // the trip to disk: a store that dropped them would refetch 292 plugins on
    // every launch and could never say an update was available.
    const dir = mkdtempSync(join(tmpdir(), 'multicode-source-store-'))
    const store = createSkillSourceStore(dir)
    const fresh = await store.getSource(OFFICIAL_PLUGINS_SKILL_SOURCE_ID)
    assert.equal(fresh?.kind, 'github', 'a fresh profile has it without anyone adding it')
    assert.equal(fresh?.repo, 'anthropics/claude-plugins-official')
    assert.equal(fresh?.commitSha, '', 'and it claims no commit until something reads it')

    // What a scan writes back: `scanGithubSource` names a source after its
    // repository, which is NOT what this source is called.
    await store.putSource(
      {
        ...(fresh as SkillSource),
        name: 'claude-plugins-official',
        blurb: '292 plugins from anthropics/claude-plugins-official.',
        commitSha: '85cce03',
        scannedAt: '2026-09-06T09:00:00.000Z',
        headSha: '85cce03',
      },
      scanOf('plugins/frontend-design/skills/frontend-design'),
    )

    const reopened = createSkillSourceStore(dir)
    const listed = await reopened.listSources()
    assert.deepEqual(
      listed.map((source) => source.id),
      [STUDIO_SKILL_SOURCE_ID, OFFICIAL_PLUGINS_SKILL_SOURCE_ID],
      'it is listed once, not once as itself and once as the copy its scan wrote',
    )
    const reread = await reopened.getSource(OFFICIAL_PLUGINS_SKILL_SOURCE_ID)
    assert.equal(reread?.commitSha, '85cce03', 'the commit survives')
    assert.equal(reread?.headSha, '85cce03')
    assert.equal(
      reread?.name,
      OFFICIAL_PLUGINS_SKILL_SOURCE_NAME,
      'but this build names it, not a scan that ran months ago',
    )
    assert.equal((await reopened.getScan(OFFICIAL_PLUGINS_SKILL_SOURCE_ID))?.skills.length, 1)

    assert.equal(isRemovableSkillSource(OFFICIAL_PLUGINS_SKILL_SOURCE_ID), false)
    assert.equal(await reopened.removeSource(OFFICIAL_PLUGINS_SKILL_SOURCE_ID), false)
    assert.equal(
      (await reopened.getScan(OFFICIAL_PLUGINS_SKILL_SOURCE_ID))?.skills.length,
      1,
      'and a refused removal leaves its scan alone',
    )
  })

  await run('a stored record that does not match the always-present source is not trusted', async () => {
    // `isPersistableSource` validates an id, a name and a kind, and nothing
    // else, so everything `withPersistedScanState` copies arrives as `unknown`
    // wearing a type. A record filed under the always-present id with another
    // kind — a hand edit, or a store written by a build that put a different
    // source there — used to pass its fields straight through, and a
    // `commitSha` of undefined reaches a plugin's "Open on GitHub" as
    // `/tree/undefined/…`.
    const wrongKind = parseSkillSourceState(
      JSON.stringify({
        sources: [{ id: OFFICIAL_PLUGINS_SKILL_SOURCE_ID, kind: 'local', name: 'x', path: '/tmp/x' }],
        scans: {},
      }),
    )
    assert.deepEqual(wrongKind.sources, [], 'a kind that is not the always-present source’s is not that source')

    const dir = mkdtempSync(join(tmpdir(), 'multicode-source-store-'))
    writeFileSync(
      join(dir, 'skill-sources.json'),
      JSON.stringify({
        // A github record under the right id, but with the two scan fields
        // missing altogether.
        sources: [
          {
            id: OFFICIAL_PLUGINS_SKILL_SOURCE_ID,
            kind: 'github',
            name: 'x',
            repo: 'anthropics/claude-plugins-official',
          },
        ],
        scans: {},
      }),
    )
    const store = createSkillSourceStore(dir)
    const read = await store.getSource(OFFICIAL_PLUGINS_SKILL_SOURCE_ID)
    assert.equal(read?.commitSha, '', 'a missing commit reads as none, never as undefined')
    assert.equal(read?.scannedAt, '')
    assert.equal('headSha' in (read ?? {}), false, 'and a head nobody resolved is absent rather than undefined')
    assert.equal(sourceHasUpdate(read as SkillSource), false)
  })

  await run('the retired Connectors source cannot come back from a stored profile', async () => {
    // The frozen-snapshots retirement (2026-09-06) removed the `connectors`
    // source and its kind. A profile written by an older build still holds the
    // record, and reading it back would put a tab on screen backed by a scan
    // root this build no longer resolves — `isPersistableSource` accepts only
    // `github` and `local`, which is what makes "a profile that held Connectors
    // simply stops listing it" true rather than merely intended.
    const state = parseSkillSourceState(
      JSON.stringify({
        sources: [{ id: 'connectors', kind: 'connectors', name: 'Connectors', repo: '' }],
        scans: { connectors: scanOf('stale') },
        adoptedLegacyPacks: true,
      }),
    )
    assert.deepEqual(state.sources, [])
    assert.deepEqual(Object.keys(state.scans), [], 'and its cached scan goes with it')
  })

  await run('our own marketplace is a repository, first in the row, and not removable', async () => {
    // The studio-marketplace ruling (2026-09-06): the app's own catalogue used
    // to be a folder scan with no commit and nothing to persist. It is now the
    // repository we publish, so its scan and its commit have to survive to
    // disk exactly like Anthropic's — otherwise every launch refetches it and
    // no check could ever say an update was available.
    const dir = mkdtempSync(join(tmpdir(), 'multicode-skill-sources-'))
    const store = createSkillSourceStore(dir)
    const listed = await store.listSources()
    assert.equal(listed[0]?.id, STUDIO_SKILL_SOURCE_ID, 'ours leads the row')
    assert.equal(listed[0]?.kind, 'github')
    assert.equal(listed[0]?.repo, STUDIO_SKILL_SOURCE_REPO)
    assert.equal(listed[0]?.name, STUDIO_SKILL_SOURCE_NAME)
    assert.equal(isRemovableSkillSource(STUDIO_SKILL_SOURCE_ID), false)
    assert.equal(await store.removeSource(STUDIO_SKILL_SOURCE_ID), false)

    await store.putSource(
      {
        ...(listed[0] as SkillSource),
        name: 'studio-releases',
        commitSha: 'abc123',
        scannedAt: '2026-09-06T00:00:00.000Z',
      },
      scanOf('one'),
    )
    const again = (await store.listSources())[0]
    assert.equal(again?.commitSha, 'abc123', 'the scan state survives')
    assert.equal(again?.name, STUDIO_SKILL_SOURCE_NAME, "but the name a scan wrote never overrules this build's")
    assert.equal((await store.getScan(STUDIO_SKILL_SOURCE_ID))?.skills[0]?.id, 'one', 'and so does the scan beside it')
  })

  await run('a seed cached as though it were a scan loses the flag on the way out', async () => {
    // The bundled seed is never written here (index.ts hands it straight to
    // the surface), and if one ever were, wearing `bundled` on the way back
    // out would make every later cache read claim the network was away.
    const state = parseSkillSourceState(
      JSON.stringify({
        sources: [{ id: STUDIO_SKILL_SOURCE_ID, kind: 'github', name: 'x', repo: STUDIO_SKILL_SOURCE_REPO }],
        scans: { [STUDIO_SKILL_SOURCE_ID]: { ...scanOf('seeded'), bundled: true } },
      }),
    )
    assert.equal('bundled' in state.scans[STUDIO_SKILL_SOURCE_ID], false)
  })

  await run('every dropped source says which one and why', async () => {
    // Silence is what made the vanishing unexplainable: a source that failed
    // this filter left no trace anywhere, so nobody could tell a drop from a
    // write that never happened.
    const { log, lines } = recorder()
    parseSkillSourceState(
      JSON.stringify({
        sources: [
          FOLDER,
          { ...REPO, id: 'github:acme/other', kind: 'future' },
          { ...FOLDER, id: 'local:/tmp/x', path: '' },
        ],
        scans: { 'github:acme/other': scanOf('nope'), [FOLDER.id]: { skills: 'not an array' } },
      }),
      log,
    )
    assert.deepEqual(
      lines.filter((line) => line.event === 'source-dropped').map((line) => line.detail),
      [
        { id: 'github:acme/other', reason: 'unknown-kind:future' },
        { id: 'local:/tmp/x', reason: 'folder-source-without-a-path' },
      ],
      'both drops are named, with the reason',
    )
    assert.deepEqual(
      lines.filter((line) => line.event === 'scan-dropped').map((line) => line.detail),
      [
        { id: 'github:acme/other', reason: 'no-source-in-list' },
        { id: FOLDER.id, reason: 'malformed' },
      ],
      'and so is every scan that goes with them',
    )
  })

  await run('a write says what it wrote and what it removed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'multicode-source-store-'))
    const { log, lines } = recorder()
    const store = createSkillSourceStore(dir, { log })
    await store.putSource(REPO, scanOf('research'))
    await store.putSource(REPO, scanOf('research'))
    await store.removeSource(REPO.id)
    await store.removeSource(REPO.id)
    assert.deepEqual(
      lines.filter((line) => line.event.startsWith('source-')).map((line) => line.detail.outcome),
      ['added', 'updated', 'removed', 'not-in-list'],
    )
  })

  await run('a store that cannot be read is never overwritten as though it were empty', async () => {
    // THE drop path. The old read swallowed every error — a permission error, a
    // busy volume, EMFILE under load — and handed back an empty state, which
    // the very next write then persisted over a list of real sources. One
    // transient failure, every added source gone, and nothing said.
    if (typeof process.getuid === 'function' && process.getuid() === 0) return
    const dir = mkdtempSync(join(tmpdir(), 'multicode-source-store-'))
    const store = createSkillSourceStore(dir, { log: () => {} })
    await store.putSource(REPO, scanOf('research'))
    await store.putSource(FOLDER, scanOf('tdd'))

    const path = join(dir, 'skill-sources.json')
    chmodSync(path, 0o000)
    await assert.rejects(
      store.putSource({ ...REPO, id: 'github:acme/second' }, scanOf('second')),
      'the write fails loudly instead of quietly rebuilding the file from nothing',
    )
    chmodSync(path, 0o600)

    const reopened = createSkillSourceStore(dir, { log: () => {} })
    const listed = (await reopened.listSources()).map((source) => source.id)
    assert.ok(listed.includes(REPO.id) && listed.includes(FOLDER.id), 'both sources are still there')
  })

  await run('bytes that are not JSON are kept aside rather than written over', async () => {
    // The one case that must not block forever: a store nobody can parse would
    // otherwise refuse every add for the life of the install. The bytes are
    // kept, so whatever was in them can still be recovered by hand.
    const dir = mkdtempSync(join(tmpdir(), 'multicode-source-store-'))
    writeFileSync(join(dir, 'skill-sources.json'), '{"sources":[{"id":"github:acme/skills"')
    const { log, lines } = recorder()
    const store = createSkillSourceStore(dir, { log })
    await store.putSource(REPO, scanOf('research'))
    assert.equal((await createSkillSourceStore(dir, { log: () => {} }).getSource(REPO.id))?.repo, 'acme/skills')
    assert.ok(
      readdirSync(dir).some((name) => name.includes('corrupt-')),
      'the unreadable bytes are kept beside the store',
    )
    assert.ok(lines.some((line) => line.event === 'store-quarantined'))
  })

  console.log('skill source store: ok')
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
