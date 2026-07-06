import assert from 'node:assert/strict'
import type { SprintEngineModelCatalogEntry } from '../types/workspace'
import { getAvailableModelCatalogEntries, normalizeSprintEngineModelCatalog } from './modelCatalog'

function run(name: string, body: () => void): void {
  try {
    body()
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`not ok - ${name}`)
    throw error
  }
}

// A fully-specified valid entry to mutate per-case; keeps each test focused on
// the one field it exercises.
function entry(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    cli: 'claude-code',
    model: 'claude-opus-4-8',
    offeredByDefault: true,
    intelligence: 9,
    frontendDesign: 8,
    mobile: 6,
    speed: 4,
    cost: 5,
    ...overrides,
  }
}

run('non-array input normalizes to []', () => {
  assert.deepEqual(normalizeSprintEngineModelCatalog(undefined), [])
  assert.deepEqual(normalizeSprintEngineModelCatalog(null), [])
  assert.deepEqual(normalizeSprintEngineModelCatalog({}), [])
  assert.deepEqual(normalizeSprintEngineModelCatalog('nope'), [])
})

run('drops entries with empty or non-string cli', () => {
  const out = normalizeSprintEngineModelCatalog([
    entry({ cli: '' }),
    entry({ cli: '   ', model: 'a' }),
    entry({ cli: 42, model: 'b' }),
    entry({ cli: null, model: 'c' }),
    null,
    'garbage',
    entry({ cli: 'zai', model: 'glm-5.2' }),
  ])
  assert.equal(out.length, 1)
  assert.equal(out[0].cli, 'zai')
})

run('trims cli and model', () => {
  const [e] = normalizeSprintEngineModelCatalog([entry({ cli: '  claude-code  ', model: '  m1  ' })])
  assert.equal(e.cli, 'claude-code')
  assert.equal(e.model, 'm1')
})

run('offeredByDefault: missing => true, present coerced to boolean', () => {
  const [missing] = normalizeSprintEngineModelCatalog([entry({ offeredByDefault: undefined })])
  assert.equal(missing.offeredByDefault, true)
  const [explicitFalse] = normalizeSprintEngineModelCatalog([entry({ offeredByDefault: false, model: 'x' })])
  assert.equal(explicitFalse.offeredByDefault, false)
  const [truthy] = normalizeSprintEngineModelCatalog([entry({ offeredByDefault: 1, model: 'y' })])
  assert.equal(truthy.offeredByDefault, true)
  const [nullish] = normalizeSprintEngineModelCatalog([entry({ offeredByDefault: null, model: 'z' })])
  assert.equal(nullish.offeredByDefault, false)
})

run('axes clamp to in-range integer; invalid/missing => 5', () => {
  const [e] = normalizeSprintEngineModelCatalog([
    entry({ intelligence: 0, frontendDesign: 99, mobile: 5.6, speed: undefined }),
  ])
  assert.equal(e.intelligence, 1) // below range clamps up
  assert.equal(e.frontendDesign, 10) // above range clamps down
  assert.equal(e.mobile, 6) // rounded to nearest integer
  assert.equal(e.speed, 5) // missing => default
  const [bad] = normalizeSprintEngineModelCatalog([
    entry({ intelligence: NaN, frontendDesign: Infinity, mobile: '7', speed: null, model: 'q' }),
  ])
  assert.equal(bad.intelligence, 5)
  assert.equal(bad.frontendDesign, 5)
  assert.equal(bad.mobile, 5) // string is not a number => default
  assert.equal(bad.speed, 5)
})

run('cost coerced to a positive finite number; invalid/missing => 1', () => {
  const [ok] = normalizeSprintEngineModelCatalog([entry({ cost: 10 })])
  assert.equal(ok.cost, 10)
  const [frac] = normalizeSprintEngineModelCatalog([entry({ cost: 2.5, model: 'a' })])
  assert.equal(frac.cost, 2.5) // cost is not clamped to an integer
  for (const bad of [0, -3, NaN, Infinity, undefined, '5', null]) {
    const [e] = normalizeSprintEngineModelCatalog([entry({ cost: bad, model: `m-${String(bad)}` })])
    assert.equal(e.cost, 1, `cost ${String(bad)} => 1`)
  }
})

run('note trimmed; empty omitted from the entry shape', () => {
  const [withNote] = normalizeSprintEngineModelCatalog([entry({ note: '  weak at UI  ' })])
  assert.equal(withNote.note, 'weak at UI')
  const [blank] = normalizeSprintEngineModelCatalog([entry({ note: '   ', model: 'a' })])
  assert.equal('note' in blank, false)
  const [missing] = normalizeSprintEngineModelCatalog([entry({ note: undefined, model: 'b' })])
  assert.equal('note' in missing, false)
})

run('missing or blank model => null (CLI default)', () => {
  const [missing] = normalizeSprintEngineModelCatalog([entry({ model: undefined })])
  assert.equal(missing.model, null)
  const [blank] = normalizeSprintEngineModelCatalog([entry({ model: '   ', cli: 'codex' })])
  assert.equal(blank.model, null)
  const [nonString] = normalizeSprintEngineModelCatalog([entry({ model: 7, cli: 'zai' })])
  assert.equal(nonString.model, null)
})

run('dedupes on cli+model, keeping the first occurrence', () => {
  const out = normalizeSprintEngineModelCatalog([
    entry({ cli: 'claude-code', model: 'opus', cost: 5 }),
    entry({ cli: 'claude-code', model: 'opus', cost: 99 }), // dup dropped
    entry({ cli: 'claude-code', model: 'sonnet', cost: 3 }),
    entry({ cli: 'codex', model: 'opus', cost: 4 }), // same model, different cli => kept
  ])
  assert.equal(out.length, 3)
  assert.equal(out[0].cost, 5) // first occurrence wins
})

run('null-model default is distinct from any string model on the same cli', () => {
  const out = normalizeSprintEngineModelCatalog([
    entry({ cli: 'zai', model: undefined }), // => null (CLI default)
    entry({ cli: 'zai', model: undefined }), // dup of the null-model entry, dropped
    entry({ cli: 'zai', model: '|default' }), // a real model that could collide with a naive key
  ])
  assert.equal(out.length, 2)
  assert.equal(out[0].model, null)
  assert.equal(out[1].model, '|default')
})

run('getAvailableModelCatalogEntries excludes uninstalled-CLI entries', () => {
  const catalog = normalizeSprintEngineModelCatalog([
    entry({ cli: 'claude-code', model: 'opus' }),
    entry({ cli: 'codex', model: 'gpt' }),
    entry({ cli: 'zai', model: 'glm-5.2' }),
  ]) as SprintEngineModelCatalogEntry[]
  const settings = { sprintEngineModelCatalog: catalog }
  // Fake installed-CLI list: only claude-code and zai are installed.
  const available = getAvailableModelCatalogEntries(settings, ['claude-code', 'zai'])
  assert.deepEqual(
    available.map((e) => e.cli),
    ['claude-code', 'zai'],
  )
  // Accepts a Set as the installed-CLI source too.
  const viaSet = getAvailableModelCatalogEntries(settings, new Set(['codex']))
  assert.deepEqual(
    viaSet.map((e) => e.cli),
    ['codex'],
  )
  // No installed CLIs => nothing available.
  assert.deepEqual(getAvailableModelCatalogEntries(settings, []), [])
})
