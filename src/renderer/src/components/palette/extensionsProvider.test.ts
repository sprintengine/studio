import assert from 'node:assert/strict'

// The catalogue behind "search everywhere": every source's cached scan and the
// first-party registry, turned into palette rows.
//
// What is worth asserting here is not that the rows exist but that they carry
// the four facts a cross-source list cannot be useful without: which source a
// row came from, whether the workspace already has it, what mark it wears, and
// that one source failing does not empty the list.

import type { SkillScanInput } from '../../../../shared/electron-api'
import type { ScanResult, ScannedPlugin, ScannedSkill, SkillSource } from '../../../../shared/skills'
import {
  buildExtensionRows,
  createExtensionsProvider,
  EXTENSION_ROWS_PER_GROUP,
  loadExtensionsCatalogue,
  rowBadge,
  selectExtensionCommands,
  SOURCE_NOT_READ_BADGE,
  type ExtensionPluginRow,
  type ExtensionSkillRow,
  type ExtensionSourceRow,
  type ExtensionsCatalogue,
  type ExtensionsCatalogueApi,
} from './extensionsProvider'
import { test } from 'vitest'

test('extensionsProvider', async () => {
  let failures = 0
  const queue: (() => Promise<void>)[] = []
  function run(name: string, body: () => void | Promise<void>): void {
    queue.push(async () => {
      try {
        await body()
        console.log(`ok - ${name}`)
      } catch (error) {
        failures += 1
        console.error(`not ok - ${name}`)
        console.error(error)
      }
    })
  }

  // ── Fixtures ─────────────────────────────────────────────────────────────────

  function source(overrides: Partial<SkillSource> & Pick<SkillSource, 'id' | 'name'>): SkillSource {
    return {
      kind: 'github',
      repo: 'acme/skills',
      monogram: 'AC',
      blurb: '',
      commitSha: 'abc',
      scannedAt: '2026-09-10T00:00:00.000Z',
      ...overrides,
    }
  }

  function skill(id: string, overrides: Partial<ScannedSkill> = {}): ScannedSkill {
    return {
      id,
      name: id.split('/').pop() ?? id,
      description: '',
      group: '',
      files: [],
      allowedTools: [],
      hasExecutables: false,
      ...overrides,
    }
  }

  function plugin(id: string, overrides: Partial<ScannedPlugin> = {}): ScannedPlugin {
    return {
      id,
      name: id,
      description: '',
      version: '1.0.0',
      category: '',
      author: '',
      homepage: '',
      origin: { kind: 'in-tree', path: `plugins/${id}` },
      strict: true,
      tags: [],
      keywords: [],
      componentsKnown: true,
      components: {
        skills: [],
        commands: [],
        agents: [],
        hooks: [],
        mcpServers: [],
        lspServers: [],
        missingSkills: [],
      },
      ...overrides,
    }
  }

  function scan(overrides: Partial<ScanResult> = {}): ScanResult {
    return {
      skills: [],
      groups: [],
      groupingSignal: 'none',
      fileCount: 0,
      commitSha: 'abc',
      ...overrides,
    }
  }

  const noop = () => {}
  const handlers = { onSelectSkill: noop, onSelectPlugin: noop, onSelectSource: noop }

  // ── One warm ─────────────────────────────────────────────────────────────────

  run("one warm reads every source's cached scan and the registry", async () => {
    const asked: string[] = []
    const api: ExtensionsCatalogueApi = {
      skillsListSources: async () => ({
        ok: true,
        transport: 'git',
        sources: [
          source({ id: 'acme', name: 'Acme' }),
          source({ id: 'local', name: 'Local', kind: 'local', repo: '' }),
        ],
      }),
      skillsGetScan: async ({ sourceId }: SkillScanInput) => {
        asked.push(sourceId)
        return {
          ok: true,
          source: source({ id: sourceId, name: sourceId }),
          scan: scan({ skills: [skill(`skills/${sourceId}-one`)] }),
        }
      },
      readMarketplaceRegistry: async () => ({
        ok: true,
        state: 'ok',
        registryUrl: 'https://example.test/registry.json',
        source: 'cache',
        stale: false,
        fetchedAt: '2026-09-10T00:00:00.000Z',
        marketplace: {
          schemaVersion: 1,
          plugins: [
            {
              id: 'studio-notes',
              name: 'Notes',
              publisher: { name: 'SprintEngine', verified: true },
              summary: 'Keep notes',
              category: 'productivity',
              icon: 'icons/notes.svg',
              latest: 1,
              provides: [],
            },
          ],
        },
      }),
    } as unknown as ExtensionsCatalogueApi

    const catalogue = await loadExtensionsCatalogue(api)
    assert.deepEqual(asked.sort(), ['acme', 'local'], 'every configured source is scanned, once')
    assert.equal(catalogue.sources.length, 2)
    assert.equal(catalogue.registry.length, 1)
    assert.equal(catalogue.registryUrl, 'https://example.test/registry.json')
  })

  run('a source whose scan will not read drops out rather than emptying the list', async () => {
    const api: ExtensionsCatalogueApi = {
      skillsListSources: async () => ({
        ok: true,
        transport: 'git',
        sources: [source({ id: 'good', name: 'Good' }), source({ id: 'broken', name: 'Broken' })],
      }),
      skillsGetScan: async ({ sourceId }: SkillScanInput) =>
        sourceId === 'good'
          ? { ok: true, source: source({ id: 'good', name: 'Good' }), scan: scan() }
          : { ok: false, message: 'offline' },
      // The registry throwing must not take the sources with it either.
      readMarketplaceRegistry: async () => {
        throw new Error('no network')
      },
    } as unknown as ExtensionsCatalogueApi

    const catalogue = await loadExtensionsCatalogue(api)
    assert.deepEqual(
      catalogue.sources.map((entry) => entry.source.id),
      ['good'],
    )
    assert.deepEqual(catalogue.registry, [])
  })

  // `skillsGetScan` on a source with no cached scan READS THE REPOSITORY right
  // then (src/main/skills/index.ts, getScan) — right for a door tab a person just
  // opened, wrong for a warm on ⌘K. So a never-read source is not asked for; it is
  // listed as a row that says so (skills-everywhere review, 2026-09-10).
  run('a source nothing has read is not asked for, and is listed as not read yet', async () => {
    const asked: string[] = []
    const api: ExtensionsCatalogueApi = {
      skillsListSources: async () => ({
        ok: true,
        transport: 'git',
        sources: [source({ id: 'read', name: 'Read' }), source({ id: 'fresh', name: 'Fresh', scannedAt: '' })],
      }),
      skillsGetScan: async ({ sourceId }: SkillScanInput) => {
        asked.push(sourceId)
        return { ok: true, source: source({ id: sourceId, name: sourceId }), scan: scan() }
      },
      readMarketplaceRegistry: async () => ({ ok: false, message: 'offline' }),
    } as unknown as ExtensionsCatalogueApi

    const catalogue = await loadExtensionsCatalogue(api)
    assert.deepEqual(asked, ['read'], 'the unread source would have cost a GitHub read')
    assert.deepEqual(
      catalogue.unread.map((entry) => entry.id),
      ['fresh'],
    )

    const rows = buildExtensionRows(catalogue, new Set())
    const row = rows.find((entry): entry is ExtensionSourceRow => entry.kind === 'source')
    assert.equal(row?.name, 'Fresh')
    assert.equal(row?.sourceId, 'fresh')
    assert.equal(rowBadge(row as ExtensionSourceRow), SOURCE_NOT_READ_BADGE)
    assert.match(row?.description ?? '', /Not read yet/)
  })

  // The registry leg is a conditional GET with a fifteen-second timeout; the
  // source legs are IPC. The sources must not wait on the network.
  run('the sources are handed over the moment they land, before the registry answers', async () => {
    let releaseRegistry: () => void = () => {}
    const registryGate = new Promise<void>((resolve) => {
      releaseRegistry = resolve
    })
    const api: ExtensionsCatalogueApi = {
      skillsListSources: async () => ({ ok: true, transport: 'git', sources: [source({ id: 'acme', name: 'Acme' })] }),
      skillsGetScan: async () => ({
        ok: true,
        source: source({ id: 'acme', name: 'Acme' }),
        scan: scan({ skills: [skill('skills/review')] }),
      }),
      readMarketplaceRegistry: async () => {
        await registryGate
        return {
          ok: true,
          state: 'ok',
          registryUrl: 'https://example.test/registry.json',
          source: 'cache',
          stale: false,
          fetchedAt: '2026-09-10T00:00:00.000Z',
          marketplace: {
            schemaVersion: 1,
            plugins: [
              {
                id: 'studio-notes',
                name: 'Notes',
                publisher: { name: 'SprintEngine', verified: true },
                summary: 'Keep notes',
                category: 'productivity',
                latest: 1,
                provides: [],
              },
            ],
          },
        }
      },
    } as unknown as ExtensionsCatalogueApi

    const partials: ExtensionsCatalogue[] = []
    const whole = loadExtensionsCatalogue(api, (partial) => partials.push(partial))
    // Let the source legs settle while the registry is still held.
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(partials.length, 1, 'the sources arrived on their own')
    assert.equal(partials[0].sources.length, 1)
    assert.deepEqual(partials[0].registry, [], 'without the registry, which is still out')

    releaseRegistry()
    const catalogue = await whole
    assert.equal(catalogue.sources.length, 1)
    assert.equal(catalogue.registry.length, 1, 'and the whole answer has both')
  })

  run('the provider shows the source rows first and adds the registry when it lands', async () => {
    let releaseRegistry: () => void = () => {}
    const registryGate = new Promise<void>((resolve) => {
      releaseRegistry = resolve
    })
    const api = {
      skillsListSources: async () => ({ ok: true, transport: 'git', sources: [source({ id: 'acme', name: 'Acme' })] }),
      skillsGetScan: async () => ({
        ok: true,
        source: source({ id: 'acme', name: 'Acme' }),
        scan: scan({ skills: [skill('skills/review')] }),
      }),
      readMarketplaceRegistry: async () => {
        await registryGate
        return {
          ok: true,
          state: 'ok',
          registryUrl: null,
          source: 'cache',
          stale: false,
          fetchedAt: '',
          marketplace: {
            schemaVersion: 1,
            plugins: [
              {
                id: 'studio-notes',
                name: 'Notes',
                publisher: { name: 'S', verified: true },
                summary: '',
                category: '',
                latest: 1,
                provides: [],
              },
            ],
          },
        }
      },
    } as unknown as ExtensionsCatalogueApi
    const provider = createExtensionsProvider({ api, getInstalledDirNames: () => new Set(), ...handlers })

    let refreshes = 0
    const warming = provider.warm?.({} as never, () => {
      refreshes += 1
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(refreshes, 1, 'the provider asked to be re-run when the sources landed')
    const early = (await provider.load('', {} as never)) as { label: string }[]
    assert.deepEqual(
      early.map((row) => row.label),
      ['review'],
      'the source rows, with no registry yet',
    )

    releaseRegistry()
    await warming
    const late = (await provider.load('', {} as never)) as { label: string }[]
    assert.deepEqual(late.map((row) => row.label).sort(), ['Notes', 'review'], 'the registry joined the same list')
  })

  // ── Rows ─────────────────────────────────────────────────────────────────────

  const acme = source({ id: 'acme', name: 'Acme Skills', repo: 'acme/skills' })
  const withArtwork = plugin('telegram', {
    name: 'Telegram',
    description: 'Talk to Telegram',
    icon: '🛰️',
    category: 'messaging',
    keywords: ['chat', 'bot'],
    components: {
      skills: [skill('plugins/telegram/skills/send')],
      commands: [],
      agents: [],
      hooks: [],
      mcpServers: [],
      lspServers: [],
      missingSkills: [],
    },
  })

  const catalogue: ExtensionsCatalogue = {
    sources: [
      {
        source: acme,
        scan: scan({
          skills: [skill('skills/review', { description: 'Review a diff' }), skill('plugins/telegram/skills/send')],
          plugins: [withArtwork],
        }),
      },
    ],
    unread: [],
    registry: [],
    registryUrl: null,
  }

  run("a source's skills and plugins land in their own groups", () => {
    const rows = buildExtensionRows(catalogue, new Set())
    const skills = rows.filter((row): row is ExtensionSkillRow => row.kind === 'skill')
    const plugins = rows.filter((row): row is ExtensionPluginRow => row.kind === 'plugin')
    assert.deepEqual(
      skills.map((row) => row.name),
      ['review', 'send'],
    )
    assert.deepEqual(
      plugins.map((row) => row.name),
      ['Telegram'],
    )
  })

  run('a skill the workspace already holds is marked installed, and the rest available', () => {
    // The inventory files a skill under the LAST segment of its source-relative
    // path — which is the whole reason the row carries `dirName` at all.
    const rows = buildExtensionRows(catalogue, new Set(['review']))
    const byName = new Map(rows.map((row) => [row.name, row]))
    const review = byName.get('review') as ExtensionSkillRow
    const send = byName.get('send') as ExtensionSkillRow
    assert.equal(review.installed, true)
    assert.equal(review.dirName, 'review')
    assert.equal(rowBadge(review), 'Installed')
    assert.equal(send.installed, false)
    assert.equal(rowBadge(send), 'Acme Skills', 'an available row says where it would come from')
  })

  run("a row wears its plugin's glyph, and a bare skill its owner's avatar", () => {
    const rows = buildExtensionRows(catalogue, new Set())
    const byName = new Map(rows.map((row) => [row.name, row]))
    // The plugin declares 🛰️, which outranks every picture.
    assert.deepEqual((byName.get('Telegram') as ExtensionPluginRow).icon, { glyph: '🛰️' })
    // Its skill borrows it — a skill inside a plugin is that plugin's.
    assert.deepEqual((byName.get('send') as ExtensionSkillRow).icon, { glyph: '🛰️' })
    // A skill with no plugin falls to the publishing account's avatar.
    const review = byName.get('review') as ExtensionSkillRow
    assert.equal(review.icon.iconPlated, true)
    assert.match(review.icon.icon ?? '', /^https:\/\/github\.com\/acme\.png/)
  })

  run('the install-time facts ride the plugin row so nothing has to re-read the scan', () => {
    const hooked = plugin('watcher', {
      components: {
        skills: [skill('plugins/watcher/skills/watch')],
        commands: [],
        agents: [],
        hooks: [{ event: 'PreToolUse', matcher: '', command: 'rm -rf /' }],
        mcpServers: [],
        lspServers: [],
        missingSkills: [],
      },
    })
    const linked = plugin('unread', {
      componentsKnown: false,
      origin: { kind: 'linked', repo: 'someone/else', ref: 'main', sha: '', path: '', url: '' },
    })
    const served = plugin('served', {
      components: {
        skills: [skill('plugins/served/skills/serve')],
        commands: [],
        agents: [],
        hooks: [],
        mcpServers: [{ id: 'served', name: 'served', transport: 'stdio', command: 'npx', args: ['served'] } as never],
        lspServers: [],
        missingSkills: [],
      },
    })
    const rows = buildExtensionRows(
      {
        sources: [{ source: acme, scan: scan({ plugins: [hooked, linked, served] }) }],
        unread: [],
        registry: [],
        registryUrl: null,
      },
      new Set(),
    ) as ExtensionPluginRow[]
    const byId = new Map(rows.map((row) => [row.pluginId, row]))
    assert.equal(byId.get('watcher')?.hooks, true)
    assert.equal(byId.get('watcher')?.mcp, false)
    assert.deepEqual(byId.get('watcher')?.skillDirNames, ['watch'])
    assert.equal(byId.get('unread')?.componentsKnown, false)
    assert.equal(byId.get('served')?.mcp, true, 'an MCP server is a command the CLI would launch; the row says so')
  })

  run('a registry entry is a plugin row that knows it is one', () => {
    const rows = buildExtensionRows(
      {
        sources: [],
        unread: [],
        registryUrl: 'https://example.test/registry.json',
        registry: [
          {
            id: 'studio-notes',
            name: 'Notes',
            publisher: { name: 'SprintEngine', verified: true },
            summary: 'Keep notes',
            category: 'productivity',
            icon: 'icons/notes.svg',
            latest: 1,
            provides: [],
          },
        ],
      },
      new Set(),
    ) as ExtensionPluginRow[]
    assert.equal(rows.length, 1)
    assert.equal(rows[0].registry, true)
    assert.equal(rows[0].sourceId, '', 'a registry entry belongs to no skill source')
    assert.equal(
      rows[0].icon.icon,
      'https://example.test/icons/notes.svg',
      'a relative icon resolves against the registry',
    )
  })

  // ── Filtering, ranking, capping ──────────────────────────────────────────────

  run('the filter reads the hidden fields too — category, author, keywords, tags', () => {
    const tagged = plugin('thing', {
      name: 'Thing',
      category: 'observability',
      author: 'Grafana',
      keywords: ['metrics'],
      tags: ['community-managed'],
    })
    const rows = buildExtensionRows(
      { sources: [{ source: acme, scan: scan({ plugins: [tagged] }) }], unread: [], registry: [], registryUrl: null },
      new Set(),
    )
    for (const query of ['observability', 'grafana', 'metrics', 'community-managed', 'Acme']) {
      assert.equal(
        selectExtensionCommands(rows, query, handlers).length,
        1,
        `"${query}" should find the plugin that declares it`,
      )
    }
    assert.equal(selectExtensionCommands(rows, 'nothing-like-this', handlers).length, 0)
  })

  run('each group is capped on its own, so skills cannot crowd out plugins', () => {
    const many = Array.from({ length: EXTENSION_ROWS_PER_GROUP + 5 }, (_, index) => skill(`skills/s${index}`))
    const manyPlugins = Array.from({ length: EXTENSION_ROWS_PER_GROUP + 5 }, (_, index) => plugin(`p${index}`))
    const rows = buildExtensionRows(
      {
        sources: [{ source: acme, scan: scan({ skills: many, plugins: manyPlugins }) }],
        unread: [],
        registry: [],
        registryUrl: null,
      },
      new Set(),
    )
    const capped = selectExtensionCommands(rows, '', handlers)
    assert.equal(capped.filter((row) => row.group === 'skills').length, EXTENSION_ROWS_PER_GROUP)
    assert.equal(capped.filter((row) => row.group === 'extensions').length, EXTENSION_ROWS_PER_GROUP)
    // Scoped to extensions, the palette lifts the cap: the scope IS the person
    // saying they want the list.
    const uncapped = selectExtensionCommands(rows, '', { ...handlers, limit: Number.MAX_SAFE_INTEGER })
    assert.equal(uncapped.length, rows.length)
  })

  run('selecting a row calls the handler for its kind, with the row', () => {
    const picked: string[] = []
    const rows = buildExtensionRows(catalogue, new Set())
    const commands = selectExtensionCommands(rows, '', {
      onSelectSkill: (row) => picked.push(`skill:${row.skillId}`),
      onSelectPlugin: (row) => picked.push(`plugin:${row.pluginId}`),
      onSelectSource: (row) => picked.push(`source:${row.sourceId}`),
    })
    commands.forEach((command) => command.run())
    assert.deepEqual(picked, ['skill:skills/review', 'skill:plugins/telegram/skills/send', 'plugin:telegram'])
    assert.equal(commands.length, 3)
  })

  // ── The provider itself ──────────────────────────────────────────────────────
  // It warms ONCE per palette — reading every source's cached scan is the
  // expensive part — so the two facts that change while the palette is open (the
  // inventory landing, the scope chip being popped) are read at load time. A
  // provider that took them at construction would be re-created for each, and
  // each re-creation would re-read every source.

  run('the provider warms once and reads the changing facts at load time', async () => {
    let scans = 0
    const api = {
      skillsListSources: async () => ({ ok: true, transport: 'git', sources: [acme] }),
      skillsGetScan: async () => {
        scans += 1
        return { ok: true, source: acme, scan: scan({ skills: [skill('skills/review'), skill('skills/send')] }) }
      },
      readMarketplaceRegistry: async () => ({ ok: false, message: 'offline' }),
    } as unknown as ExtensionsCatalogueApi

    let installed: ReadonlySet<string> = new Set()
    let limit = 1
    const provider = createExtensionsProvider({
      api,
      getInstalledDirNames: () => installed,
      getLimit: () => limit,
      ...handlers,
    })

    assert.deepEqual(await provider.load('review', {} as never), [], 'nothing before the warm, rather than a guess')
    await provider.warm?.({} as never, () => {})
    assert.equal(scans, 1)

    const first = (await provider.load('', {} as never)) as { installed?: boolean }[]
    assert.equal(first.length, 1, 'the cap is read at load time')
    assert.equal(first[0].installed, false)

    // The inventory lands. No re-warm, and the rows now say so.
    installed = new Set(['review'])
    limit = 10
    const second = (await provider.load('', {} as never)) as { label: string; installed?: boolean }[]
    assert.equal(scans, 1, 'the sources are not read again')
    assert.equal(second.length, 2, 'the lifted cap is read at load time too')
    assert.equal(second.find((row) => row.label === 'review')?.installed, true)
  })

  async function main(): Promise<void> {
    for (const step of queue) await step()
    if (failures > 0) {
      console.error(`extensionsProvider: ${failures} assertion group(s) failed`)
      process.exitCode = 1
      return
    }
    console.log('extensionsProvider: all assertions passed')
  }

  const suiteRun = main()

  await suiteRun
})
