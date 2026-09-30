// A source on a company's self-hosted GitHub.
//
// The repository is named `host/owner/name` everywhere below the parser — the
// source's `repo`, its id, every reader call — and github.com keeps the
// `owner/name` it always had, so nothing written before other hosts existed
// changes meaning. Pinned here at the service's own seam:
//
//   1. what a person can paste, and what each shape becomes;
//   2. a marketplace on that host is read through the reader with its host,
//      and may link plugins on the same host — nowhere else but github.com;
//   3. with no git on the machine, the API fallback refuses by name rather
//      than asking github.com about a repository it has never had.

import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { scanPlugins, type ScanResult, type SkillSource } from '../../shared/skills'
import { parseSkillRepoRef, skillRepoName } from './github-tree'
import { createSkillsService, type SkillsServiceDeps } from './index'
import { claudeMarketplaceSource } from './install-plugin'
import type { SkillRepoReader } from './repo-reader'
import { SKILL_MARKETPLACE_MANIFEST_PATH, type SkillTreeEntry } from './scan'
import { githubRepoFromUrl } from './scan-plugins'
import type { SkillSourceStore } from './source-store'
import { test } from 'vitest'

test('other-host sources', async () => {
  const HOST = 'ghe.example.com'
  const MARKETPLACE_REPO = `${HOST}/acme/marketplace`
  const COMMIT = 'a'.repeat(40)

  function pastedShapes(): void {
    const cases: Array<[string, ReturnType<typeof parseSkillRepoRef>]> = [
      ['https://ghe.example.com/acme/skills', { owner: 'acme', repo: 'skills', ref: '', host: HOST }],
      ['https://GHE.example.com/acme/skills.git', { owner: 'acme', repo: 'skills', ref: '', host: HOST }],
      [
        'https://ghe.example.com/acme/skills/tree/release',
        { owner: 'acme', repo: 'skills', ref: 'release', host: HOST },
      ],
      ['git@ghe.example.com:acme/skills.git', { owner: 'acme', repo: 'skills', ref: '', host: HOST }],
      ['ghe.example.com/acme/skills', { owner: 'acme', repo: 'skills', ref: '', host: HOST }],
      // github.com in any of its spellings is still github.com, with no host.
      ['https://github.com/acme/skills', { owner: 'acme', repo: 'skills', ref: '' }],
      ['https://www.github.com/acme/skills', { owner: 'acme', repo: 'skills', ref: '' }],
      ['git@github.com:acme/skills.git', { owner: 'acme', repo: 'skills', ref: '' }],
      ['acme/skills', { owner: 'acme', repo: 'skills', ref: '' }],
    ]
    for (const [input, expected] of cases) {
      assert.deepEqual(parseSkillRepoRef(input), expected, input)
    }
    // A stray third segment is not a host just because there are three.
    assert.equal(parseSkillRepoRef('acme/skills/extra'), null)
    assert.equal(parseSkillRepoRef('http://ghe.example.com/acme/skills'), null)
    assert.equal(skillRepoName({ owner: 'acme', repo: 'skills', ref: '', host: HOST }), `${HOST}/acme/skills`)
    assert.equal(skillRepoName({ owner: 'acme', repo: 'skills', ref: '' }), 'acme/skills')
  }

  function linkedHosts(): void {
    assert.equal(githubRepoFromUrl('https://ghe.example.com/acme/p.git', HOST), `${HOST}/acme/p`)
    assert.equal(githubRepoFromUrl('https://github.com/acme/p.git', HOST), 'acme/p')
    assert.equal(githubRepoFromUrl('https://other.example.com/acme/p.git', HOST), '', 'only the same host')
    assert.equal(githubRepoFromUrl('https://ghe.example.com/acme/p.git'), '', 'and only for a marketplace there')
    assert.equal(githubRepoFromUrl('http://ghe.example.com/acme/p.git', HOST), '', 'over https')
  }

  function claudeCodeIsToldTheHost(): void {
    // Claude Code's `github` source is github.com; any other host is a git URL.
    assert.deepEqual(claudeMarketplaceSource('acme/marketplace'), { source: 'github', repo: 'acme/marketplace' })
    assert.deepEqual(claudeMarketplaceSource(`${HOST}/acme/marketplace`), {
      source: 'git',
      url: `https://${HOST}/acme/marketplace.git`,
    })
  }

  const MANIFEST = JSON.stringify({
    name: 'acme-internal',
    plugins: [
      { name: 'same-host', source: { source: 'url', url: `https://${HOST}/acme/plugin.git` } },
      { name: 'on-github', source: { source: 'github', repo: 'acme/public-plugin' } },
      { name: 'elsewhere', source: { source: 'url', url: 'https://other.example.com/acme/plugin.git' } },
      // A server that runs out of the plugin's own directory: installing it
      // lists and copies the plugin's files from the marketplace repository.
      { name: 'runner', source: './plugins/runner' },
    ],
  })

  const MARKETPLACE_FILES: Record<string, string> = {
    [SKILL_MARKETPLACE_MANIFEST_PATH]: MANIFEST,
    'plugins/runner/.claude-plugin/plugin.json': JSON.stringify({ name: 'runner' }),
    'plugins/runner/.mcp.json': JSON.stringify({
      mcpServers: { run: { command: '${CLAUDE_PLUGIN_ROOT}/bin/run' } },
    }),
    'plugins/runner/bin/run': '#!/bin/sh\n',
  }
  const MARKETPLACE_TREE: SkillTreeEntry[] = [
    { path: '.claude-plugin', mode: '040000', type: 'tree', sha: 't' },
    { path: 'plugins', mode: '040000', type: 'tree', sha: 't' },
    { path: 'plugins/runner', mode: '040000', type: 'tree', sha: 't' },
    { path: 'plugins/runner/.claude-plugin', mode: '040000', type: 'tree', sha: 't' },
    { path: 'plugins/runner/bin', mode: '040000', type: 'tree', sha: 't' },
    ...Object.keys(MARKETPLACE_FILES).map((path) => ({ path, mode: '100644', type: 'blob', sha: 'b' })),
  ]
  const PLUGIN_TREE: SkillTreeEntry[] = [
    { path: 'skills', mode: '040000', type: 'tree', sha: 't' },
    { path: 'skills/demo', mode: '040000', type: 'tree', sha: 't' },
    { path: 'skills/demo/SKILL.md', mode: '100644', type: 'blob', sha: 's' },
  ]

  function fakeReader(): SkillRepoReader & { asked: string[] } {
    const asked: string[] = []
    return {
      asked,
      resolveCommit: async (repo) => {
        asked.push(repo)
        return repo === MARKETPLACE_REPO ? COMMIT : '0'.repeat(40)
      },
      readTree: async (repo) => {
        asked.push(repo)
        return repo === MARKETPLACE_REPO ? MARKETPLACE_TREE : PLUGIN_TREE
      },
      readFile: async (repo, _sha, path) =>
        repo === MARKETPLACE_REPO && path in MARKETPLACE_FILES ? Buffer.from(MARKETPLACE_FILES[path], 'utf8') : null,
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

  async function serviceWith(extra: Partial<SkillsServiceDeps>): Promise<ReturnType<typeof createSkillsService>> {
    const userData = await mkdtemp(join(tmpdir(), 'sprintengine-other-host-'))
    return createSkillsService(
      userData,
      {
        resolveToken: async () => 'ghp_githubDotComOnly',
        listHarnesses: async () => ['claude'],
        studioMarketplaceSeedRoot: () => null,
        ...extra,
      },
      memoryStore(),
    )
  }

  async function aMarketplaceOnAnotherHostIsReadThere(): Promise<void> {
    const reader = fakeReader()
    const service = await serviceWith({
      repoReader: reader,
      github: {
        fetcher: () => {
          throw new Error('the skills service reached GitHub instead of its reader')
        },
      },
    })
    const added = await service.addSource({ repo: `https://${HOST}/acme/marketplace` })
    assert.equal(added.ok, true, added.ok ? '' : added.message)
    if (!added.ok) return
    assert.equal(added.source.id, `github:${MARKETPLACE_REPO}`)
    assert.equal(added.source.repo, MARKETPLACE_REPO)
    assert.equal(added.source.name, 'marketplace')

    const plugins = new Map(scanPlugins(added.scan).map((plugin) => [plugin.id, plugin]))
    const sameHost = plugins.get('same-host')
    assert.ok(sameHost?.origin.kind === 'linked')
    assert.equal(sameHost.origin.repo, `${HOST}/acme/plugin`)
    assert.equal(sameHost.componentsKnown, true, 'and it was read')
    assert.ok(reader.asked.includes(`${HOST}/acme/plugin`), 'through the reader, on its host')
    assert.ok(reader.asked.includes('acme/public-plugin'), 'a github entry is still github.com')
    const elsewhere = plugins.get('elsewhere')
    assert.equal(elsewhere?.readState?.status, 'unreadable', 'a third host is never contacted')
    assert.ok(!reader.asked.some((repo) => repo.includes('other.example.com')))

    // Adding it again by another spelling is the same source.
    const again = await service.addSource({ repo: `git@${HOST}:acme/marketplace.git`, replace: false })
    assert.equal(again.ok, false)
    if (!again.ok) assert.match(again.message, /ghe\.example\.com\/acme\/marketplace is already one of your sources/)

    // And a Sync re-reads it from what was stored.
    const synced = await service.syncSource({ sourceId: added.source.id, workspaceRoot: '' })
    assert.equal(synced.ok, true, synced.ok ? '' : synced.message)

    // A plugin whose server runs from its own files installs from it too.
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-other-host-ws-'))
    const installed = await service.installPlugin({ sourceId: added.source.id, pluginId: 'runner', workspaceRoot })
    assert.equal(installed.ok, true, installed.ok ? '' : installed.message)
    assert.ok(reader.asked.filter((repo) => repo === MARKETPLACE_REPO).length > 2, "the plugin's files were listed")
  }

  async function withoutGitTheApiFallbackSaysSo(): Promise<void> {
    const requested: string[] = []
    const service = await serviceWith({
      github: {
        fetcher: async (url) => {
          requested.push(url)
          throw new Error('no request should be made')
        },
      },
    })
    const added = await service.addSource({ repo: `https://${HOST}/acme/marketplace` })
    assert.equal(added.ok, false)
    if (!added.ok) assert.match(added.message, /needs git/)
    assert.deepEqual(requested, [], 'github.com was never asked about it, and never sent its token')
  }

  pastedShapes()
  linkedHosts()
  claudeCodeIsToldTheHost()
  await aMarketplaceOnAnotherHostIsReadThere()
  await withoutGitTheApiFallbackSaysSo()
})
