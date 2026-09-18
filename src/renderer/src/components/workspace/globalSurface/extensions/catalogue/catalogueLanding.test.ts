import assert from 'node:assert/strict'

import type { ScanResult, SkillSource } from '../../../../../../../shared/skills'
import type { SkillScanLoad } from '../skills/skillsSurfaceModel'
import {
  landingFromTarget,
  resolveCatalogueLanding,
  targetNamesPlace,
  targetTabId,
  type CatalogueLanding,
} from './catalogueLanding'

// Where a deep link lands (skills-everywhere, 2026-09-10). What the resolver
// owes: wait while a read the answer depends on is still out; open when the
// source and the item are there; and when they are not, say so and stand on
// the nearest thing that exists — never throw, never a blank.

function run(name: string, body: () => void): void {
  try {
    body()
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`not ok - ${name}`)
    throw error
  }
}

const HUB: SkillSource = {
  id: 'github:acme/hub',
  kind: 'github',
  name: 'hub',
  repo: 'acme/hub',
  monogram: 'AH',
  blurb: '',
  commitSha: 'def',
  scannedAt: '',
}
const OTHER: SkillSource = { ...HUB, id: 'github:acme/other', name: 'other', repo: 'acme/other' }

const HUB_SCAN: ScanResult = {
  skills: [],
  groups: [],
  groupingSignal: 'none',
  fileCount: 0,
  commitSha: 'def',
  plugins: [
    {
      id: 'read-one',
      name: 'Read one',
      description: '',
      version: '',
      category: '',
      author: '',
      homepage: '',
      strict: true,
      tags: [],
      keywords: [],
      origin: { kind: 'in-tree', path: 'plugins/read-one' },
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
    },
  ],
}

const hasPlugin = (scan: ScanResult, id: string): boolean => (scan.plugins ?? []).some((plugin) => plugin.id === id)

function resolve(
  landing: CatalogueLanding,
  scans: Record<string, SkillScanLoad>,
  sources: SkillSource[] = [HUB, OTHER],
) {
  return resolveCatalogueLanding({
    landing,
    sourcesLoad: { status: 'ready' },
    sources,
    scans,
    noun: 'plugin',
    has: hasPlugin,
  })
}

// ── From a target ────────────────────────────────────────────────────────────

run('a target’s tab is Installed, the source it names, or nothing', () => {
  assert.equal(targetTabId({ view: 'plugins' }), null)
  assert.equal(targetTabId({ view: 'skills', installed: true }), 'installed')
  assert.equal(targetTabId({ view: 'plugins', sourceId: HUB.id }), HUB.id)
})

run('a landing is the item the view can open; a bare view or Installed asks for none', () => {
  assert.equal(landingFromTarget({ view: 'plugins' }), null)
  assert.equal(landingFromTarget({ view: 'skills', installed: true }), null)
  assert.deepEqual(landingFromTarget({ view: 'plugins', sourceId: HUB.id, pluginId: 'read-one' }), {
    sourceId: HUB.id,
    itemId: 'read-one',
  })
  assert.deepEqual(landingFromTarget({ view: 'skills', sourceId: HUB.id, skillId: 'skills/a' }), {
    sourceId: HUB.id,
    itemId: 'skills/a',
  })
  // The plugin id is the Plugins view's business and the skill id the Skills
  // view's; each view is handed only what it can open.
  assert.deepEqual(landingFromTarget({ view: 'skills', sourceId: HUB.id, pluginId: 'read-one' }), {
    sourceId: HUB.id,
    itemId: null,
  })
  assert.equal(
    landingFromTarget({ view: 'agent-clis', sourceId: HUB.id, pluginId: 'x' }),
    null,
    'Agent CLIs has no source tabs to land on',
  )
})

run('a target names a place when it names a tab, a plugin or a skill — a bare view does not', () => {
  // The search box's query survives a view switch and is cleared by a place.
  assert.equal(targetNamesPlace({ view: 'skills' }), false)
  assert.equal(targetNamesPlace({ view: 'skills', installed: true }), true)
  assert.equal(targetNamesPlace({ view: 'plugins', sourceId: HUB.id }), true)
  assert.equal(targetNamesPlace({ view: 'plugins', pluginId: 'read-one' }), true)
})

// ── Resolving ────────────────────────────────────────────────────────────────

run('it waits while the source list, or the named source’s scan, is still on its way', () => {
  assert.deepEqual(
    resolveCatalogueLanding({
      landing: { sourceId: HUB.id, itemId: 'read-one' },
      sourcesLoad: { status: 'loading' },
      sources: [],
      scans: {},
      noun: 'plugin',
      has: hasPlugin,
    }),
    { status: 'waiting' },
  )
  assert.deepEqual(resolve({ sourceId: HUB.id, itemId: 'read-one' }, {}), { status: 'waiting' }, 'not requested yet')
  assert.deepEqual(resolve({ sourceId: HUB.id, itemId: 'read-one' }, { [HUB.id]: { status: 'loading' } }), {
    status: 'waiting',
  })
})

run('it lands once the scan is in hand and holds the plugin', () => {
  const outcome = resolve({ sourceId: HUB.id, itemId: 'read-one' }, { [HUB.id]: { status: 'ready', scan: HUB_SCAN } })
  assert.deepEqual(outcome, { status: 'landed', source: HUB, itemId: 'read-one' })
})

run('a source alone lands without waiting for any scan', () => {
  assert.deepEqual(resolve({ sourceId: HUB.id, itemId: null }, {}), { status: 'landed', source: HUB, itemId: null })
})

run('a source no longer in the list is a notice, not a throw', () => {
  const outcome = resolve({ sourceId: 'github:gone/gone', itemId: 'read-one' }, {})
  assert.equal(outcome.status, 'missed')
  assert.ok(outcome.status === 'missed' && outcome.notice.includes('read-one came from is not in your list'))
  const bare = resolve({ sourceId: 'github:gone/gone', itemId: null }, {})
  assert.deepEqual(bare, { status: 'missed', notice: 'That source is not in your list any more.' })
})

run('a plugin the scan does not hold, or a scan that failed, is said in the source’s name', () => {
  const missing = resolve({ sourceId: HUB.id, itemId: 'nope' }, { [HUB.id]: { status: 'ready', scan: HUB_SCAN } })
  assert.deepEqual(missing, {
    status: 'missed',
    notice: 'acme/hub no longer lists a plugin called nope. It may have been renamed or removed.',
  })
  const failed = resolve(
    { sourceId: HUB.id, itemId: 'read-one' },
    { [HUB.id]: { status: 'error', message: 'rate limited' } },
  )
  assert.deepEqual(failed, { status: 'missed', notice: 'acme/hub could not be read, so read-one could not be opened.' })
})

run('a source list that could not be read is a notice too', () => {
  const outcome = resolveCatalogueLanding({
    landing: { sourceId: HUB.id, itemId: 'read-one' },
    sourcesLoad: { status: 'error', message: 'disk' },
    sources: [],
    scans: {},
    noun: 'plugin',
    has: hasPlugin,
  })
  assert.deepEqual(outcome, {
    status: 'missed',
    notice: 'Your sources could not be read, so read-one could not be opened.',
  })
})

run('with no source named, the plugin is looked for in the scans already in hand and no read is started', () => {
  const found = resolve({ sourceId: '', itemId: 'read-one' }, { [HUB.id]: { status: 'ready', scan: HUB_SCAN } })
  assert.deepEqual(found, { status: 'landed', source: HUB, itemId: 'read-one' })
  // One scan still loading might hold it: wait for that one, and no longer.
  assert.deepEqual(resolve({ sourceId: '', itemId: 'read-one' }, { [OTHER.id]: { status: 'loading' } }), {
    status: 'waiting',
  })
  // Nothing loading and nothing holding it: a source nobody has opened is NOT
  // read to find out — the same rule the search box keeps.
  assert.deepEqual(resolve({ sourceId: '', itemId: 'read-one' }, {}), {
    status: 'missed',
    notice: 'No source that has been read lists a plugin called read-one.',
  })
  assert.equal(resolve({ sourceId: '', itemId: null }, {}).status, 'missed', 'a link that names nothing opens nothing')
})

console.log('catalogue landing: ok')
