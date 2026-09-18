import assert from 'node:assert/strict'

import type { InstalledPluginRecord } from '../../../../../../../shared/electron-api'
import {
  describePluginComponents,
  emptyPluginComponents,
  unreadPluginReason,
  type ScanResult,
  type ScannedPlugin,
  type ScannedSkill,
  type SkillSource,
} from '../../../../../../../shared/skills'
import {
  countPluginUpdates,
  derivePluginInstallAvailability,
  derivePluginInstallState,
  derivePluginRows,
  describeInstallPlan,
  findInstalledRecord,
  findPlugin,
  pluginExternalUrl,
  summarizePluginInstall,
} from './pluginsSurfaceModel'

function run(name: string, body: () => void): void {
  try {
    body()
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`not ok - ${name}`)
    throw error
  }
}

const SOURCE: SkillSource = {
  id: 'github:anthropics/claude-plugins-official',
  kind: 'github',
  name: 'claude-plugins-official',
  repo: 'anthropics/claude-plugins-official',
  monogram: 'AC',
  blurb: '',
  commitSha: '85cce0381e7860082641b59d961a2b8c368b8b79',
  scannedAt: '2026-09-05T09:00:00Z',
}

function skill(id: string): ScannedSkill {
  return {
    id,
    name: id.split('/').pop() ?? id,
    description: '',
    group: '',
    files: [],
    allowedTools: [],
    hasExecutables: false,
  }
}

function plugin(id: string, over: Partial<ScannedPlugin> = {}): ScannedPlugin {
  return {
    id,
    name: id,
    description: `${id} does a thing`,
    version: '',
    category: '',
    author: 'Anthropic',
    homepage: '',
    origin: { kind: 'in-tree', path: `plugins/${id}` },
    strict: true,
    tags: [],
    keywords: [],
    componentsKnown: true,
    components: emptyPluginComponents(),
    ...over,
  }
}

function scanOf(plugins: ScannedPlugin[], over: Partial<ScanResult> = {}): ScanResult {
  return {
    skills: [],
    groups: [],
    groupingSignal: 'none',
    fileCount: 0,
    commitSha: SOURCE.commitSha,
    shape: 'claude-marketplace',
    marketplaceName: 'claude-plugins-official',
    plugins,
    mcpServers: [],
    ...over,
  }
}

function record(over: Partial<InstalledPluginRecord> = {}): InstalledPluginRecord {
  return {
    workspaceRoot: '/ws',
    sourceId: SOURCE.id,
    pluginId: 'code-review',
    pluginName: 'code-review',
    marketplaceName: 'claude-plugins-official',
    claudePluginKey: 'code-review@claude-plugins-official',
    skillDirNames: [],
    mcpServerIds: [],
    commitSha: SOURCE.commitSha,
    installedAt: '2026-09-05T09:30:00Z',
    ...over,
  }
}

run('rows say what a plugin ships, and unread linked plugins say so', () => {
  const rows = derivePluginRows({
    source: SOURCE,
    scan: scanOf([
      plugin('frontend-design', {
        components: { ...emptyPluginComponents(), skills: [skill('plugins/frontend-design/skills/frontend-design')] },
      }),
      plugin('security-guidance', {
        components: { ...emptyPluginComponents(), hooks: [{ event: 'Stop', matcher: '', command: 'x' }] },
      }),
      plugin('42crunch', {
        origin: {
          kind: 'linked',
          repo: '42Crunch-AI/claude-plugins',
          ref: 'v1',
          sha: 'abc',
          path: 'plugins/x',
          url: 'https://github.com/42Crunch-AI/claude-plugins.git',
        },
        componentsKnown: false,
      }),
    ]),
    installed: [],
    query: '',
  })
  assert.deepEqual(
    rows.map((row) => row.components),
    ['1 skill', '1 hook', 'Read when opened'],
  )
  assert.deepEqual(
    rows.map((row) => row.hasHooks),
    [false, true, false],
  )
  assert.deepEqual(
    rows.map((row) => row.linked),
    [false, false, true],
  )
  assert.ok(rows.every((row) => row.install.kind === 'not-installed'))

  const filtered = derivePluginRows({
    source: SOURCE,
    scan: scanOf([plugin('alpha'), plugin('beta')]),
    installed: [],
    query: 'BET',
  })
  assert.deepEqual(
    filtered.map((row) => row.pluginId),
    ['beta'],
  )
})

run('installed state comes from our receipt, or from a hand-enabled Claude key', () => {
  const p = plugin('code-review')
  assert.equal(
    derivePluginInstallState([], SOURCE.id, p, 'claude-plugins-official', SOURCE.commitSha).kind,
    'not-installed',
  )
  assert.equal(
    derivePluginInstallState([record()], SOURCE.id, p, 'claude-plugins-official', SOURCE.commitSha).kind,
    'installed',
  )
  // The source moved on since the install: an update, from our own receipt only.
  assert.equal(
    derivePluginInstallState([record()], SOURCE.id, p, 'claude-plugins-official', 'ffffff').kind,
    'update-available',
  )
  // Enabled by hand in .claude/settings.json: installed, never "update available".
  const foreign = record({ sourceId: '', commitSha: '', installedAt: '' })
  assert.equal(derivePluginInstallState([foreign], SOURCE.id, p, 'claude-plugins-official', 'ffffff').kind, 'installed')
  // A receipt from another source for a same-named plugin is not this one.
  const elsewhere = record({ sourceId: 'github:o/r', claudePluginKey: 'code-review@other' })
  assert.equal(
    derivePluginInstallState([elsewhere], SOURCE.id, p, 'claude-plugins-official', SOURCE.commitSha).kind,
    'not-installed',
  )
})

run('a plugin the marketplace renamed is still the one you installed', () => {
  // `anthropics/claude-plugins-official` renamed `adlc` to `agentforce-adlc`,
  // and records its old names in the manifest's top-level `renames`. A receipt
  // written before the rename names the plugin by the old name; without the map
  // the row reads "not installed" and installing again duplicates it
  // (official-plugins ruling, 2026-09-06).
  const scan = scanOf([plugin('agentforce-adlc')], { pluginRenames: { adlc: 'agentforce-adlc' } })
  const before = record({ pluginId: 'adlc', pluginName: 'adlc', claudePluginKey: 'adlc@claude-plugins-official' })
  const rows = derivePluginRows({ source: SOURCE, scan, installed: [before], query: '' })
  assert.equal(rows[0].install.kind, 'installed')
  assert.equal(findPlugin(scan, 'adlc')?.id, 'agentforce-adlc', 'and the old name opens the plugin it became')
  assert.equal(findPlugin(scan, 'agentforce-adlc')?.id, 'agentforce-adlc')

  // A hand-enabled Claude key written under the old name resolves too.
  const handEnabled = record({
    sourceId: '',
    commitSha: '',
    pluginId: 'adlc',
    claudePluginKey: 'adlc@claude-plugins-official',
  })
  assert.equal(
    derivePluginRows({ source: SOURCE, scan, installed: [handEnabled], query: '' })[0].install.kind,
    'installed',
  )

  // Without the map, nothing is guessed: two plugins with unrelated names stay
  // unrelated.
  const unmapped = scanOf([plugin('agentforce-adlc')])
  assert.equal(
    derivePluginRows({ source: SOURCE, scan: unmapped, installed: [before], query: '' })[0].install.kind,
    'not-installed',
  )
})

run('an exact id beats an alias, whichever receipt comes first', () => {
  // Both names installed, and the alias receipt written first. Matching on
  // "is this record any of my names" hands the same receipt to both rows, and
  // uninstalling one then deletes the other's.
  const aliasFirst = [
    record({ pluginId: 'adlc', pluginName: 'adlc', claudePluginKey: 'adlc@claude-plugins-official' }),
    record({
      pluginId: 'agentforce-adlc',
      pluginName: 'agentforce-adlc',
      claudePluginKey: 'agentforce-adlc@claude-plugins-official',
    }),
  ]
  const found = findInstalledRecord(aliasFirst, SOURCE.id, { id: 'agentforce-adlc' }, 'claude-plugins-official', [
    'agentforce-adlc',
    'adlc',
  ])
  assert.equal(found?.pluginId, 'agentforce-adlc', 'its own receipt, not the one that happens to be first')

  // The alias is still the fallback when the plugin has no receipt of its own.
  const aliasOnly = [record({ pluginId: 'adlc', pluginName: 'adlc', claudePluginKey: 'adlc@claude-plugins-official' })]
  assert.equal(
    findInstalledRecord(aliasOnly, SOURCE.id, { id: 'agentforce-adlc' }, 'claude-plugins-official', [
      'agentforce-adlc',
      'adlc',
    ])?.pluginId,
    'adlc',
  )

  // The same order rule for a hand-enabled Claude key.
  const keys = [
    record({ sourceId: '', commitSha: '', pluginId: 'adlc', claudePluginKey: 'adlc@claude-plugins-official' }),
    record({
      sourceId: '',
      commitSha: '',
      pluginId: 'agentforce-adlc',
      claudePluginKey: 'agentforce-adlc@claude-plugins-official',
    }),
  ]
  assert.equal(
    findInstalledRecord(keys, SOURCE.id, { id: 'agentforce-adlc' }, 'claude-plugins-official', [
      'agentforce-adlc',
      'adlc',
    ])?.claudePluginKey,
    'agentforce-adlc@claude-plugins-official',
  )
})

run('a plugin past the scan’s limit says so, rather than promising a read', () => {
  // An in-tree plugin the scan skipped has no repository to fetch: opening it
  // reads nothing. Saying "Read when opened" sent a person to a button that
  // could not work, and left Install refusing with no reason given.
  const overCap = plugin('p999', { componentsKnown: false })
  assert.equal(unreadPluginReason(overCap), 'over-scan-limit')
  assert.equal(describePluginComponents(overCap), 'Not read by this scan')

  const linked = plugin('42crunch', {
    componentsKnown: false,
    origin: { kind: 'linked', repo: 'o/r', ref: '', sha: 'abc', path: '', url: 'https://github.com/o/r' },
  })
  assert.equal(unreadPluginReason(linked), 'unopened')
  assert.equal(
    describePluginComponents(linked),
    'Read when opened',
    'a linked plugin still promises the read it can do',
  )
  assert.equal(unreadPluginReason(plugin('read')), 'read')
})

run('the install plan says per harness what will land, before it does', () => {
  const p = plugin('security-guidance', {
    components: {
      ...emptyPluginComponents(),
      skills: [skill('plugins/security-guidance/skills/review')],
      hooks: [{ event: 'Stop', matcher: '', command: 'x' }],
      mcpServers: [],
    },
  })
  const plan = describeInstallPlan({
    plugin: p,
    marketplaceName: 'claude-plugins-official',
    marketplaceRepo: SOURCE.repo,
    harnesses: ['claude', 'codex', 'agents'],
  })
  assert.equal(plan.length, 3)
  // Claude Code is copied for like every other harness. A one-item install
  // does not write enabledPlugins, so the row no longer names a settings key.
  assert.match(plan[0].line, /Skills you install are copied into \.claude\/skills/)
  assert.match(plan[0].line, /Its hooks are not installed/)
  assert.equal(/settings\.json/.test(plan[0].line), false, 'a catalogue install does not enable the whole plugin')
  assert.equal(/Enabled as/.test(plan[0].line), false, 'nothing claims Claude Code loads it itself')
  assert.match(plan[1].line, /Skills you install are copied into \.codex\/skills/)
  assert.match(plan[1].line, /hooks have no equivalent here/)
  assert.equal(/settings\.json/.test(plan[1].line), false, 'the key is Claude Code\u2019s row alone')
  assert.equal(plan[2].label, 'Shared agents directory')

  // No marketplace: the copy is the same.
  const noMarket = describeInstallPlan({
    plugin: p,
    marketplaceName: '',
    marketplaceRepo: SOURCE.repo,
    harnesses: ['claude'],
  })
  assert.match(noMarket[0].line, /copied into \.claude\/skills/)
  assert.equal(/settings\.json/.test(noMarket[0].line), false)

  // Claude Code with nothing to copy says so.
  const claudeNothing = describeInstallPlan({
    plugin: plugin('h', {
      components: { ...emptyPluginComponents(), hooks: [{ event: 'Stop', matcher: '', command: 'x' }] },
    }),
    marketplaceName: 'claude-plugins-official',
    marketplaceRepo: SOURCE.repo,
    harnesses: ['claude'],
  })
  assert.match(claudeNothing[0].line, /Nothing is copied\. Its hooks are not installed/)
  assert.equal(/settings\.json/.test(claudeNothing[0].line), false)
  const hooksOnly = describeInstallPlan({
    plugin: plugin('h', {
      components: { ...emptyPluginComponents(), hooks: [{ event: 'Stop', matcher: '', command: 'x' }] },
    }),
    marketplaceName: '',
    marketplaceRepo: '',
    harnesses: ['codex'],
  })
  assert.match(hooksOnly[0].line, /Nothing to install\. Its hooks are Claude Code-format/)
  // An LSP-only plugin — the shape twelve of the official marketplace's plugins
  // take — says why there is nothing for this harness rather than going blank.
  const lspOnly = describeInstallPlan({
    plugin: plugin('clangd-lsp', {
      components: {
        ...emptyPluginComponents(),
        lspServers: [
          {
            id: 'clangd',
            command: 'clangd',
            args: ['--background-index'],
            extensionToLanguage: { '.c': 'c' },
            startupTimeout: 0,
            declaredIn: '.claude-plugin/marketplace.json',
            declaredBy: 'clangd-lsp',
          },
        ],
      },
    }),
    marketplaceName: '',
    marketplaceRepo: '',
    harnesses: ['codex'],
  })
  assert.match(lspOnly[0].line, /Nothing to install\. Its LSP servers are Claude Code-format/)
  const unread = describeInstallPlan({
    plugin: plugin('u', { componentsKnown: false }),
    marketplaceName: 'm',
    marketplaceRepo: 'o/r',
    harnesses: ['claude'],
  })
  assert.match(unread[0].line, /Known once the plugin has been read/)
})

run('install availability states its reason instead of doing nothing', () => {
  const hooked = plugin('h', {
    components: { ...emptyPluginComponents(), hooks: [{ event: 'Stop', matcher: '', command: 'x' }] },
  })
  assert.match(derivePluginInstallAvailability(null, hooked, ['claude']).reason ?? '', /Open a workspace/)
  assert.match(derivePluginInstallAvailability('/ws', hooked, []).reason ?? '', /No agent CLI/)
  assert.equal(derivePluginInstallAvailability('/ws', hooked, ['claude']).enabled, true)
  assert.equal(derivePluginInstallAvailability('/ws', plugin('p'), ['claude']).enabled, true)
  assert.equal(
    derivePluginInstallAvailability('/ws', plugin('u', { componentsKnown: false }), ['claude']).enabled,
    false,
  )
})

run('what an install did is one line in the installer’s words', () => {
  assert.equal(
    summarizePluginInstall({
      harnesses: [
        { harness: 'claude', mode: 'skills', skillDirNames: ['review', 'audit'] },
        { harness: 'codex', mode: 'skills', skillDirNames: ['review', 'audit'] },
        { harness: 'agents', mode: 'skills', skillDirNames: ['review', 'audit'] },
      ],
      mcpServers: [{}],
      warnings: [],
    }),
    'Installed: 2 skills copied for Claude Code, Codex, Shared agents directory; 1 MCP server added.',
  )
  assert.equal(summarizePluginInstall({ harnesses: [], mcpServers: [], warnings: ['x failed'] }), 'Installed. x failed')
})

run('a plugin opens where a person can read it', () => {
  assert.equal(pluginExternalUrl(plugin('a', { homepage: 'https://example.com' }), SOURCE), 'https://example.com')
  assert.equal(
    pluginExternalUrl(plugin('a'), SOURCE),
    `https://github.com/anthropics/claude-plugins-official/tree/${SOURCE.commitSha}/plugins/a`,
  )
  assert.equal(
    pluginExternalUrl(
      plugin('a', {
        origin: { kind: 'linked', repo: 'o/r', ref: '', sha: '', path: '', url: 'https://github.com/o/r.git' },
      }),
      SOURCE,
    ),
    'https://github.com/o/r.git',
  )
})

// ── The number a source's tab wears ─────────────────────────────────────────
//
// Same derivation the rows use, so the tab and the list beneath it cannot
// disagree — and unfiltered by the search box, because the count is about the
// source rather than about what is currently typed.

run('a source counts the plugins installed at a commit it has moved past', () => {
  const scan = scanOf([plugin('code-review'), plugin('frontend-design'), plugin('security-guidance')], {
    commitSha: 'ffffff',
  })
  const source = { ...SOURCE, commitSha: 'ffffff' }
  const installed = [
    // Behind: installed at the source's old commit.
    record({ pluginId: 'code-review', claudePluginKey: 'code-review@claude-plugins-official' }),
    // Current: installed at the commit the source pins now.
    record({
      pluginId: 'frontend-design',
      claudePluginKey: 'frontend-design@claude-plugins-official',
      commitSha: 'ffffff',
    }),
  ]
  assert.equal(countPluginUpdates({ source, scan, installed }), 1)
  assert.equal(
    countPluginUpdates({ source, scan, installed: [] }),
    0,
    'nothing installed, nothing to update — not-installed is not an update',
  )
})

run('the count ignores the search box', () => {
  const scan = scanOf([plugin('code-review')], { commitSha: 'ffffff' })
  const source = { ...SOURCE, commitSha: 'ffffff' }
  const installed = [record({ pluginId: 'code-review' })]
  assert.equal(countPluginUpdates({ source, scan, installed }), 1)
  assert.equal(
    derivePluginRows({ source, scan, installed, query: 'zzz' }).length,
    0,
    'the rows narrow as you type, and the tab above them does not',
  )
})

run('a version bump of an installed skill pack is an available update, never applied silently', () => {
  const studio: SkillSource = {
    ...SOURCE,
    id: 'github:sprintengine/studio-releases',
    repo: 'sprintengine/studio-releases',
    commitSha: 'newcommit',
  }
  const installed = record({
    sourceId: studio.id,
    pluginId: 'studio-skills',
    pluginName: 'studio-skills',
    marketplaceName: 'sprintengine-studio',
    claudePluginKey: 'studio-skills@sprintengine-studio',
    skillDirNames: ['architect'],
    commitSha: 'oldcommit',
  })
  assert.equal(
    derivePluginInstallState([installed], studio.id, plugin('studio-skills'), 'sprintengine-studio', studio.commitSha)
      .kind,
    'update-available',
  )
  assert.equal(
    derivePluginInstallState([installed], studio.id, plugin('studio-skills'), 'sprintengine-studio', 'oldcommit').kind,
    'installed',
    'the same commit is not an update, and no file is rewritten until the person accepts',
  )
})

console.log('plugins surface model: ok')
