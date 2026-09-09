// A source you add is still there next launch — proved through the SERVICE, on
// a real store, over a real directory.
//
// The store's own round trip was already covered (source-store.test.ts) and it
// passed, yet a person added `github:anthropics/skills` in the Extensions door
// and later found it gone. So this walks the whole path the door walks: the
// service adds a source, a SECOND service over the same userData directory —
// which is what the next launch is — lists it, and the sequence that runs
// unattended in between (the hourly update check, which writes every
// always-present source back) does not take it with it.
//
// The reader is a fake and the GitHub fetcher throws, so nothing here touches
// the network; what is under test is persistence, not scanning.

import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  OFFICIAL_PLUGINS_SKILL_SOURCE_ID,
  OFFICIAL_PLUGINS_SKILL_SOURCE_REPO,
  STUDIO_SKILL_SOURCE_ID,
} from '../../shared/skills'
import { createSkillsService, type SkillsService, type SkillsServiceDeps } from './index'
import type { SkillRepoReader } from './repo-reader'
import type { SkillTreeEntry } from './scan'

const ADDED_REPO = 'anthropics/skills'
const ADDED_ID = `github:${ADDED_REPO}`
const COMMIT = 'a'.repeat(40)
const MOVED_COMMIT = 'b'.repeat(40)

const SKILLS_TREE: SkillTreeEntry[] = [
  { path: 'skills', mode: '040000', type: 'tree', sha: 't' },
  { path: 'skills/pdf', mode: '040000', type: 'tree', sha: 't' },
  { path: 'skills/pdf/SKILL.md', mode: '100644', type: 'blob', sha: 's', size: 64 },
]

function run(name: string, body: () => Promise<void>): Promise<void> {
  return body().then(
    () => console.log(`ok - ${name}`),
    (error) => {
      console.error(`not ok - ${name}`)
      throw error
    },
  )
}

/** Every repository this test knows, answering the same small tree. */
function fakeReader(head: () => string): SkillRepoReader {
  return {
    resolveCommit: async () => head(),
    readTree: async () => SKILLS_TREE,
    readFile: async (_repo, _sha, path) =>
      path.endsWith('SKILL.md')
        ? Buffer.from('---\nname: pdf\ndescription: Fill in a PDF form\n---\n', 'utf8')
        : null,
  }
}

/** A service over a userData directory, with the REAL store — the point of the test. */
function serviceOver(userData: string, extra: Partial<SkillsServiceDeps> = {}): SkillsService {
  return createSkillsService(userData, {
    resolveToken: async () => '',
    listHarnesses: async () => ['claude'],
    studioMarketplaceSeedRoot: () => null,
    github: {
      fetcher: () => {
        throw new Error('this test reached GitHub instead of its reader')
      },
    },
    repoReader: fakeReader(() => COMMIT),
    ...extra,
  })
}

async function main(): Promise<void> {
  await run('a source added through the service is there for the next launch, with its scan', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'multicode-source-persistence-'))
    const added = await serviceOver(userData).addSource({ repo: ADDED_REPO })
    assert.equal(added.ok, true, added.ok ? '' : added.message)
    if (!added.ok) return
    assert.equal(added.source.id, ADDED_ID)
    assert.equal(added.mergedIntoBuiltin, undefined, 'a repository nobody ships is an ordinary add')

    // A second service over the same directory is the next launch: nothing is
    // carried in memory between them.
    const next = serviceOver(userData)
    const listed = await next.listSources()
    assert.equal(listed.ok, true)
    if (!listed.ok) return
    assert.ok(
      listed.sources.some((source) => source.id === ADDED_ID),
      'the source a person added is in the list',
    )
    const scan = await next.getScan({ sourceId: ADDED_ID })
    assert.equal(scan.ok, true, scan.ok ? '' : scan.message)
    if (!scan.ok) return
    assert.equal(scan.scan.skills.length, 1, 'and the scan cached beside it comes back')
    assert.equal(scan.source.commitSha, COMMIT, 'at the commit it was read at')
  })

  await run('an update check writes the built-in tabs back without taking the added source with it', async () => {
    // The unattended sequence between "I added it" and "it is gone": the hourly
    // check resolves every repository's head and calls `putSource` for each,
    // including the two always-present ones. If any of those writes rebuilt the
    // file from a partial state, this is where a person's source would go.
    const userData = await mkdtemp(join(tmpdir(), 'multicode-source-persistence-'))
    let head = COMMIT
    const service = serviceOver(userData, { repoReader: fakeReader(() => head) })
    const added = await service.addSource({ repo: ADDED_REPO })
    assert.equal(added.ok, true, added.ok ? '' : added.message)

    // The always-present tabs get read too, which is what puts THEIR records in
    // the same file as the added source.
    assert.equal((await service.getScan({ sourceId: OFFICIAL_PLUGINS_SKILL_SOURCE_ID })).ok, true)
    assert.equal((await service.getScan({ sourceId: STUDIO_SKILL_SOURCE_ID })).ok, true)

    head = MOVED_COMMIT
    const check = await service.checkSourceUpdates()
    assert.deepEqual(check.failures, [])
    assert.ok(check.changed.includes(ADDED_ID), 'the added source is behind its head')

    const next = serviceOver(userData)
    const listed = await next.listSources()
    assert.equal(listed.ok, true)
    if (!listed.ok) return
    assert.deepEqual(
      listed.sources.map((source) => source.id),
      [STUDIO_SKILL_SOURCE_ID, OFFICIAL_PLUGINS_SKILL_SOURCE_ID, ADDED_ID],
      'every source survives the check, and none is duplicated',
    )
    const scan = await next.getScan({ sourceId: ADDED_ID })
    assert.equal(scan.ok, true, 'with its scan intact')
  })

  await run('pasting a repository the studio always has merges into that tab and says so', async () => {
    // `anthropics/claude-plugins-official` is the Anthropic tab. Pasting it
    // reported a flat success and put nothing in the list, because the store
    // keeps one record per id — so the person went looking for a source that
    // was never going to appear.
    const userData = await mkdtemp(join(tmpdir(), 'multicode-source-persistence-'))
    const service = serviceOver(userData)
    const result = await service.addSource({ repo: OFFICIAL_PLUGINS_SKILL_SOURCE_REPO, replace: true })
    assert.equal(result.ok, true, result.ok ? '' : result.message)
    if (!result.ok) return
    assert.equal(result.mergedIntoBuiltin, true, 'the result says where the paste landed')
    assert.equal(result.source.id, OFFICIAL_PLUGINS_SKILL_SOURCE_ID)

    const listed = await serviceOver(userData).listSources()
    assert.equal(listed.ok, true)
    if (!listed.ok) return
    assert.deepEqual(
      listed.sources.map((source) => source.id),
      [STUDIO_SKILL_SOURCE_ID, OFFICIAL_PLUGINS_SKILL_SOURCE_ID],
      'no duplicate row, one tab',
    )
    assert.equal(listed.sources[1]?.commitSha, COMMIT, 'and the tab keeps the read the paste paid for')
  })

  await run('the same paste without replace is a merge too, not a refusal', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'multicode-source-persistence-'))
    const result = await serviceOver(userData).addSource({ repo: OFFICIAL_PLUGINS_SKILL_SOURCE_REPO })
    assert.equal(result.ok, true, result.ok ? '' : result.message)
    assert.equal(result.ok && result.mergedIntoBuiltin, true)
  })

  await run('adding a repository twice without replace is still refused', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'multicode-source-persistence-'))
    const service = serviceOver(userData)
    assert.equal((await service.addSource({ repo: ADDED_REPO })).ok, true)
    const again = await service.addSource({ repo: ADDED_REPO })
    assert.equal(again.ok, false, 'a source already in the list is reported, not silently re-added')
  })

  console.log('skill source persistence: ok')
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
