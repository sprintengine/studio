// The skills service reads every repository through ONE injected reader, and
// the git transport spends no budget (git-transport ruling, owner 2026-09-08).
//
// Two things are pinned here, both at the service's own seam rather than at the
// scanner below it:
//
//   1. Nothing under `src/main/skills/index.ts` reaches past the reader to
//      GitHub's REST API. The `github` options handed in carry a fetcher that
//      throws, so a single call that slipped back to `github-tree.ts` fails the
//      suite instead of quietly working on a machine with network.
//   2. A marketplace linking more repositories than the anonymous API budget
//      (20) is read WHOLE over git, and the same marketplace over the API
//      fallback still stops at twenty with the rest stated as `pending:
//      'budget'`. That is the defect the ruling was written for: 190 of the
//      official marketplace's 239 plugins sat unread after a Sync.

import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { scanPlugins, summariseLinkedPlugins, type ScanResult, type SkillSource } from '../../shared/skills'
import { createSkillsService, type SkillsServiceDeps } from './index'
import type { SkillRepoReader } from './repo-reader'
import { MAX_LINKED_REPOSITORY_READS_ANONYMOUS } from './scan-plugins'
import { SKILL_MARKETPLACE_MANIFEST_PATH, type SkillTreeEntry } from './scan'
import type { SkillSourceStore } from './source-store'
import { test } from 'vitest'

test('repo-transport', async () => {
  const MARKETPLACE_REPO = 'acme/marketplace'
  const MARKETPLACE_ID = `github:${MARKETPLACE_REPO}`
  const COMMIT = 'a'.repeat(40)
  /** More than the anonymous API budget of 20, which is the whole point. */
  const LINKED_PLUGINS = 25

  const MANIFEST = JSON.stringify({
    name: 'acme',
    plugins: Array.from({ length: LINKED_PLUGINS }, (_, index) => ({
      name: `linked-${index}`,
      source: { source: 'github', repo: `acme/plugin-${index}`, sha: String(index).padStart(40, '0') },
    })),
  })

  const MARKETPLACE_TREE: SkillTreeEntry[] = [
    { path: '.claude-plugin', mode: '040000', type: 'tree', sha: 't' },
    { path: SKILL_MARKETPLACE_MANIFEST_PATH, mode: '100644', type: 'blob', sha: 'm' },
  ]

  const LINKED_TREE: SkillTreeEntry[] = [
    { path: 'skills', mode: '040000', type: 'tree', sha: 't' },
    { path: 'skills/demo', mode: '040000', type: 'tree', sha: 't' },
    { path: 'skills/demo/SKILL.md', mode: '100644', type: 'blob', sha: 's', size: 12 },
  ]

  /** Every repository this test knows, in memory, counting what it was asked. */
  type FakeReader = SkillRepoReader & { trees: string[]; commits: string[] }

  function fakeReader(): FakeReader {
    const trees: string[] = []
    const commits: string[] = []
    return {
      trees,
      commits,
      resolveCommit: async (repo, ref) => {
        commits.push(`${repo}#${ref}`)
        return repo === MARKETPLACE_REPO ? COMMIT : '0'.repeat(40)
      },
      readTree: async (repo, sha) => {
        trees.push(`${repo}@${sha}`)
        return repo === MARKETPLACE_REPO ? MARKETPLACE_TREE : LINKED_TREE
      },
      readFile: async (repo, _sha, path) => {
        if (repo === MARKETPLACE_REPO && path === SKILL_MARKETPLACE_MANIFEST_PATH) {
          return Buffer.from(MANIFEST, 'utf8')
        }
        // Null is "this repository does not hold that path", which is an answer
        // rather than a failure — the same thing the git reader means by it.
        return null
      },
    }
  }

  function memoryStore(): SkillSourceStore {
    const sources = new Map<string, SkillSource>()
    const scans = new Map<string, ScanResult>()
    return {
      listSources: async () => [...sources.values()],
      getSource: async (id) => sources.get(id) ?? null,
      putSource: async (source, scan) => {
        sources.set(source.id, source)
        if (scan) scans.set(source.id, scan)
      },
      removeSource: async (id) => sources.delete(id),
      getScan: async (id) => scans.get(id) ?? null,
    }
  }

  /** Deps every case shares: no token, no seed on disk, and an API that throws. */
  async function serviceWith(extra: Partial<SkillsServiceDeps>): Promise<ReturnType<typeof createSkillsService>> {
    const userData = await mkdtemp(join(tmpdir(), 'sprintengine-repo-transport-'))
    return createSkillsService(
      userData,
      {
        resolveToken: async () => '',
        listHarnesses: async () => ['claude'],
        studioMarketplaceSeedRoot: () => null,
        github: {
          fetcher: () => {
            throw new Error('the skills service reached GitHub instead of its reader')
          },
        },
        ...extra,
      },
      memoryStore(),
    )
  }

  async function everyLinkedPluginIsReadOverGit(): Promise<void> {
    const reader = fakeReader()
    const service = await serviceWith({ repoReader: reader })

    const listed = await service.listSources()
    assert.equal(listed.ok, true)
    if (!listed.ok) return
    assert.equal(listed.transport, 'git', 'a reader was injected, so the transport is git')
    assert.equal(listed.gitInstalled ?? true, true)

    const added = await service.addSource({ repo: MARKETPLACE_REPO })
    assert.equal(added.ok, true, added.ok ? '' : added.message)
    if (!added.ok) return

    assert.deepEqual(reader.commits, [`${MARKETPLACE_REPO}#`], 'the source resolved through the reader')
    assert.equal(
      reader.trees.length,
      LINKED_PLUGINS + 1,
      'the marketplace, then one listing per linked repository — none of them skipped',
    )
    assert.deepEqual(summariseLinkedPlugins(added.scan), {
      total: LINKED_PLUGINS,
      read: LINKED_PLUGINS,
      pending: 0,
      unreadable: 0,
      pendingReasons: { budget: 0, rateLimited: 0, offline: 0 },
    })
    assert.ok(
      LINKED_PLUGINS > MAX_LINKED_REPOSITORY_READS_ANONYMOUS,
      'the marketplace has to out-number the anonymous budget for this to prove anything',
    )

    // Sync reads through the same reader. The linked plugins are pinned and
    // already cached, so it costs one listing — the marketplace's own.
    reader.trees.length = 0
    reader.commits.length = 0
    // No workspace: sources are app-level, so a Sync with none refreshes the
    // list and copies nothing.
    const synced = await service.syncSource({ sourceId: MARKETPLACE_ID, workspaceRoot: '' })
    assert.equal(synced.ok, true, synced.ok ? '' : synced.message)
    if (!synced.ok) return
    assert.deepEqual(reader.commits, [`${MARKETPLACE_REPO}#`], 'Sync asked the reader for the head')
    assert.deepEqual(reader.trees, [`${MARKETPLACE_REPO}@${COMMIT}`], 'and re-read only what could have moved')
    assert.equal(
      summariseLinkedPlugins(synced.scan).read,
      LINKED_PLUGINS,
      'every linked plugin survives the sync as read',
    )
    assert.equal(scanPlugins(synced.scan).length, LINKED_PLUGINS)
  }

  async function theApiFallbackStillSpendsItsBudget(): Promise<void> {
    // The same reader, declared as the API transport: this is the machine with no
    // git, where a tree listing IS a REST request and the budget is what keeps a
    // scan from spending the whole unauthenticated hour.
    const reader = fakeReader()
    const service = await serviceWith({ repoReader: reader, repoTransport: 'api', gitInstalled: false })

    const listed = await service.listSources()
    assert.equal(listed.ok && listed.transport, 'api')
    assert.equal(listed.ok && listed.gitInstalled, false, 'and the copy can say "install git" rather than name a token')

    const added = await service.addSource({ repo: MARKETPLACE_REPO })
    assert.equal(added.ok, true, added.ok ? '' : added.message)
    if (!added.ok) return
    assert.equal(
      reader.trees.length,
      MAX_LINKED_REPOSITORY_READS_ANONYMOUS + 1,
      'twenty linked repositories and the marketplace, and not one more',
    )
    assert.deepEqual(summariseLinkedPlugins(added.scan), {
      total: LINKED_PLUGINS,
      read: MAX_LINKED_REPOSITORY_READS_ANONYMOUS,
      pending: LINKED_PLUGINS - MAX_LINKED_REPOSITORY_READS_ANONYMOUS,
      unreadable: 0,
      pendingReasons: {
        budget: LINKED_PLUGINS - MAX_LINKED_REPOSITORY_READS_ANONYMOUS,
        rateLimited: 0,
        offline: 0,
      },
    })
  }

  async function withNoReaderTheTransportIsTheApi(): Promise<void> {
    const service = await serviceWith({})
    const listed = await service.listSources()
    assert.equal(listed.ok && listed.transport, 'api', 'no reader, no git: the fallback, and it says so')
  }

  async function main(): Promise<void> {
    await everyLinkedPluginIsReadOverGit()
    await theApiFallbackStillSpendsItsBudget()
    await withNoReaderTheTransportIsTheApi()
    console.log('skills repo transport tests passed')
  }

  const suiteRun = main().catch((error) => {
    console.error(error)
    process.exit(1)
  })

  await suiteRun
})
