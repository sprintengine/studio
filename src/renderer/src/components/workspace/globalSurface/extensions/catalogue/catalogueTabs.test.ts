import assert from 'node:assert/strict'

import {
  OFFICIAL_PLUGINS_SKILL_SOURCE_ID,
  type SkillSource,
} from '../../../../../../../shared/skills'
import type { InstalledExtension } from '../../../../settings/extensionsInstalled'
import {
  APP_CATALOGUE_LABEL,
  catalogueHoldingsLine,
  catalogueStateLine,
  catalogueTabLabel,
  deriveCatalogueTabs,
  INSTALLED_TAB_ID,
  orderCatalogueSources,
  resolveCatalogueTab,
} from './catalogueTabs'
import { groupInstalledBySource, installedRowSourceId } from './installedGroups'

// The tab row is the navigation the source-tabs ruling (2026-09-05) put in
// place of the nested Sources rail, and it inherits the rail's two honesty
// rules: a source is never hidden from a kind it lacks, and a count is never
// spoken while it is unknown.

function run(name: string, body: () => void): void {
  try {
    body()
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`not ok - ${name}`)
    throw error
  }
}

const source = (over: Partial<SkillSource> & { id: string }): SkillSource => ({
  kind: 'github',
  name: '',
  repo: '',
  monogram: '??',
  blurb: '',
  commitSha: '',
  scannedAt: '',
  ...over,
})

const APP = source({ id: 'builtin', kind: 'builtin', name: 'Multicode', monogram: 'MC' })
const CONNECTORS = source({ id: 'connectors', kind: 'connectors', name: 'Connectors' })
const ACME = source({ id: 'github:acme/skills', repo: 'acme/skills' })
const FOLDER = source({ id: 'local:/Users/me/work/skills', kind: 'local', name: 'skills', path: '/Users/me/work/skills' })
const ANTHROPIC = source({
  id: OFFICIAL_PLUGINS_SKILL_SOURCE_ID,
  name: 'Anthropic',
  repo: 'anthropics/claude-plugins-official',
  monogram: 'AN',
})

run('Installed leads, then the app’s own catalogue, then the rest in the order they were added', () => {
  const tabs = deriveCatalogueTabs({
    kind: 'plugins',
    // Deliberately handed in with the app's catalogue LAST: the tab order is
    // the ruling's, not the store's.
    sources: [ACME, CONNECTORS, APP],
    installedCount: 3,
    counts: {},
  })
  assert.deepEqual(
    tabs.map((tab) => tab.id),
    [INSTALLED_TAB_ID, 'builtin', 'github:acme/skills', 'connectors'],
  )
  assert.equal(tabs[0].label, 'Installed')
  assert.equal(tabs[0].count, 3)
  assert.deepEqual(
    orderCatalogueSources([ACME, APP]).map((entry) => entry.id),
    ['builtin', 'github:acme/skills'],
  )
})

// ── The official marketplace: always present, and where Plugins opens ────────

run('the two bundled catalogues lead the row, ours first, then the rest as added', () => {
  const tabs = deriveCatalogueTabs({
    kind: 'plugins',
    // Handed in in the order a store that appended it would give: the row's
    // order is the ruling's, not the store's.
    sources: [ACME, ANTHROPIC, FOLDER, APP],
    installedCount: 0,
    counts: {},
  })
  assert.deepEqual(
    tabs.map((tab) => tab.id),
    [INSTALLED_TAB_ID, 'builtin', OFFICIAL_PLUGINS_SKILL_SOURCE_ID, 'github:acme/skills', FOLDER.id],
    'Installed · SprintEngine Studio · Anthropic · the sources you added, in the order you added them',
  )
})

run('the Plugins catalogue opens on Anthropic, and only Plugins does', () => {
  // It is where the plugins are — 292 against our own catalogue's handful —
  // and our tab is one click away, still first in the row.
  const plugins = deriveCatalogueTabs({ kind: 'plugins', sources: [APP, ANTHROPIC], installedCount: 0, counts: {} })
  assert.equal(resolveCatalogueTab(plugins, null), OFFICIAL_PLUGINS_SKILL_SOURCE_ID)
  assert.equal(
    resolveCatalogueTab(plugins, 'builtin'),
    'builtin',
    'and a tab the person chose still wins over the default',
  )
  const skills = deriveCatalogueTabs({ kind: 'skills', sources: [APP, ANTHROPIC], installedCount: 0, counts: {} })
  assert.equal(resolveCatalogueTab(skills, null), 'builtin', 'Skills is unchanged: our own skills lead it')
  const withoutIt = deriveCatalogueTabs({ kind: 'plugins', sources: [APP, ACME], installedCount: 0, counts: {} })
  assert.equal(resolveCatalogueTab(withoutIt, null), 'builtin', 'a row without it opens on its first source, as before')
})

run('a source that holds two kinds says so in both nouns', () => {
  // "292 listings" was one number over two populations, and a listing is not a
  // noun anybody uses: the owner read anthropics/skills's five plugin bundles
  // as five skills, because four of them are named *-skills.
  assert.equal(
    catalogueHoldingsLine([
      [292, 'plugin', 'plugins'],
      [15, 'MCP server', 'MCP servers'],
    ]),
    '292 plugins · 15 MCP servers',
  )
  assert.equal(catalogueHoldingsLine([[1, 'skill', 'skills']]), '1 skill')
  assert.equal(
    catalogueHoldingsLine([
      [5, 'plugin', 'plugins'],
      [0, 'MCP server', 'MCP servers'],
    ]),
    '5 plugins',
    'a kind the source has none of is left out rather than printed as a zero',
  )
  assert.equal(catalogueHoldingsLine([]), '')
})

run('a source is named by what it is: the product, a repository, a folder', () => {
  assert.equal(catalogueTabLabel(APP), APP_CATALOGUE_LABEL)
  assert.equal(
    catalogueTabLabel(ANTHROPIC),
    'Anthropic',
    'the official marketplace is called by its publisher, not by its path',
  )
  assert.equal(
    catalogueTabLabel({ ...ANTHROPIC, name: 'claude-plugins-official' }),
    'Anthropic',
    'including the copy Sync hands back, which a scan named after the repository it read',
  )
  assert.equal(catalogueTabLabel(ACME), 'acme/skills', 'not "skills" — three repos called skills is unnavigable')
  assert.equal(catalogueTabLabel(FOLDER), 'skills', 'a folder has no repository to name it by')
  assert.equal(catalogueTabLabel(CONNECTORS), 'Connectors')
})

run('a source with none of this kind still gets a tab', () => {
  const tabs = deriveCatalogueTabs({
    kind: 'plugins',
    sources: [APP, ACME],
    installedCount: 0,
    counts: { builtin: { status: 'ready', count: 318 }, 'github:acme/skills': { status: 'ready', count: 0 } },
  })
  assert.equal(tabs.length, 3, 'hiding a source is how a person loses it')
  assert.equal(tabs[2].count, 0)
  assert.equal(catalogueStateLine({ status: 'ready', count: 0 }, 'plugin'), 'No plugins here')
})

run('a loading or unreadable scan carries no count at all, never a zero', () => {
  const tabs = deriveCatalogueTabs({
    kind: 'skills',
    sources: [APP, ACME],
    installedCount: null,
    counts: {
      builtin: { status: 'loading' },
      'github:acme/skills': { status: 'error', message: 'GitHub rate-limited this request.' },
    },
  })
  assert.equal(tabs[0].count, null, 'an installed read still in flight says nothing')
  assert.equal(tabs[1].count, null)
  assert.equal(tabs[2].count, null)
  assert.equal(catalogueStateLine(tabs[1].state, 'skill'), 'Loading…')
  assert.equal(
    catalogueStateLine(tabs[2].state, 'skill'),
    'GitHub rate-limited this request.',
    'the head line carries the real reason, not a generic failure',
  )
})

run('a source the update check has seen move on is marked', () => {
  const tabs = deriveCatalogueTabs({
    kind: 'skills',
    sources: [{ ...ACME, commitSha: 'abc1234', headSha: 'ffffff9' }],
    installedCount: 0,
    counts: {},
  })
  assert.equal(tabs[1].updateAvailable, true)
  assert.equal(tabs[0].updateAvailable, false, 'Installed is not a source and cannot be behind one')
})

run('Agent CLIs list the app’s catalogue alone', () => {
  // A source's scan yields plugins, skills and MCP servers — never a CLI — so
  // every added repository would be a tab that can only ever read "none".
  const tabs = deriveCatalogueTabs({
    kind: 'agent-clis',
    sources: [APP, ACME, FOLDER],
    installedCount: 2,
    counts: { builtin: { status: 'ready', count: 12 } },
  })
  assert.deepEqual(tabs.map((tab) => tab.id), [INSTALLED_TAB_ID, 'builtin'])
})

run('a removed source does not leave the surface on a tab that is gone', () => {
  const tabs = deriveCatalogueTabs({ kind: 'skills', sources: [APP], installedCount: 0, counts: {} })
  assert.equal(resolveCatalogueTab(tabs, 'github:acme/skills'), 'builtin', 'it falls back to the first source')
  assert.equal(resolveCatalogueTab(tabs, INSTALLED_TAB_ID), INSTALLED_TAB_ID, 'a tab that exists is kept')
  assert.equal(resolveCatalogueTab(tabs, null), 'builtin', 'and a cold surface opens on a source, not on Installed')
  const onlyInstalled = deriveCatalogueTabs({ kind: 'skills', sources: [], installedCount: 0, counts: {} })
  assert.equal(resolveCatalogueTab(onlyInstalled, 'builtin'), INSTALLED_TAB_ID)
})

// ── The Installed tab, grouped by where each row came from ───────────────────

const row = (over: Partial<InstalledExtension> & { id: string; kind: InstalledExtension['kind'] }): InstalledExtension => ({
  key: `${over.kind}:${over.id}`,
  name: over.id,
  source: 'Custom',
  chips: [],
  ...over,
})

const record = (over: { sourceId: string; skillDirNames?: string[]; mcpServerIds?: string[] }) => ({
  workspaceRoot: '/ws',
  pluginId: 'p',
  pluginName: 'p',
  marketplaceName: '',
  claudePluginKey: '',
  skillDirNames: over.skillDirNames ?? [],
  mcpServerIds: over.mcpServerIds ?? [],
  commitSha: '',
  installedAt: '',
  sourceId: over.sourceId,
})

run('an install receipt is what attributes a row to a source', () => {
  const records = [record({ sourceId: 'github:acme/skills', skillDirNames: ['tdd'], mcpServerIds: ['acme-mcp'] })]
  assert.equal(installedRowSourceId(row({ id: 'tdd', kind: 'skill' }), records), 'github:acme/skills')
  assert.equal(installedRowSourceId(row({ id: 'acme-mcp', kind: 'mcp' }), records), 'github:acme/skills')
  assert.equal(
    installedRowSourceId(row({ id: 'tdd', kind: 'mcp' }), records),
    null,
    'a skill directory name is not an MCP server id — the kinds do not borrow each other’s receipts',
  )
})

run('rows no receipt claims say only what the inventory knows', () => {
  const groups = groupInstalledBySource({
    rows: [
      row({ id: 'tdd', kind: 'skill' }),
      row({ id: 'shipped', kind: 'skill', source: 'Bundled' }),
      row({ id: 'by-hand', kind: 'mcp', source: 'Custom' }),
    ],
    sources: [APP, ACME],
    records: [record({ sourceId: 'github:acme/skills', skillDirNames: ['tdd'] })],
  })
  assert.deepEqual(
    groups.map((group) => [group.label, group.items.map((item) => item.id)]),
    [
      ['acme/skills', ['tdd']],
      ['Bundled with the app', ['shipped']],
      ['Added on this machine', ['by-hand']],
    ],
    'never a guess about which source a hand-written server came from',
  )
})

run('a source removed since the install still gives its rows a heading', () => {
  const groups = groupInstalledBySource({
    rows: [row({ id: 'tdd', kind: 'skill' })],
    sources: [APP],
    records: [record({ sourceId: 'github:gone/away', skillDirNames: ['tdd'] })],
  })
  assert.deepEqual(
    groups.map((group) => group.label),
    ['From a source that is no longer in your list'],
    'the skill is still installed, so it must not vanish with the source',
  )
})

run('a source with nothing installed from it gets no heading', () => {
  const groups = groupInstalledBySource({ rows: [], sources: [APP, ACME], records: [] })
  assert.deepEqual(groups, [], 'a heading with nothing under it says a source is installed when it is not')
})

console.log('catalogue tabs: ok')
