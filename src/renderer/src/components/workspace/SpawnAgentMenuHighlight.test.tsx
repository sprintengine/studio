import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { rememberedHighlight } from './SpawnAgentMenu'

let failures = 0
function run(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`ok - ${name}`)
  } catch (error) {
    failures += 1
    console.error(`not ok - ${name}`)
    console.error(error)
  }
}

// rememberedHighlight is the pure seam behind the spawn menu's initial keyboard
// highlight: given the live roster and a predicate matching the last-used row,
// it returns the row's index, or 0 when that row is absent. Exercising it
// directly (no store, no DOM) covers the restore-from-lastSelectedSpecialist
// contract and the disabled-pack fallback that the menu relies on.
type Action = { id: string }
const roster: Action[] = [
  { id: 'architect' },
  { id: 'developer' },
  { id: 'frontend-design-review' },
  { id: 'nuclear-review' },
]

run('restores the remembered specialist to its current roster index', () => {
  assert.equal(
    rememberedHighlight(roster, (a) => a.id === 'developer'),
    1,
    'reopening highlights the last-used Developer row, not the first row',
  )
  assert.equal(
    rememberedHighlight(roster, (a) => a.id === 'nuclear-review'),
    3,
    'the index tracks the live order, not a fixed slot',
  )
})

run('survives reordering — the index follows the remembered id, not a saved number', () => {
  const reordered: Action[] = [{ id: 'developer' }, { id: 'architect' }]
  assert.equal(
    rememberedHighlight(reordered, (a) => a.id === 'developer'),
    0,
    'after the user drags Developer to the top, restore points at its new position',
  )
})

run('falls back to the first row when the remembered specialist is absent (disabled pack)', () => {
  assert.equal(
    rememberedHighlight(roster, (a) => a.id === 'security'),
    0,
    'a remembered specialist whose pack is now disabled is not in the roster → highlight the first enabled row',
  )
})

run('falls back to 0 for an empty roster (every pack disabled / still loading)', () => {
  assert.equal(
    rememberedHighlight([] as Action[], (a) => a.id === 'developer'),
    0,
    'an empty roster never yields an out-of-range highlight',
  )
})

run('the cold-install default is resolved by ordinary lookup, not special-cased', () => {
  // 'architect' is only the persisted default; the helper does not reassert it —
  // it is found like any other id, and absent like any other when its pack is off.
  assert.equal(rememberedHighlight(roster, (a) => a.id === 'architect'), 0, 'architect resolves to its real index')
  assert.equal(
    rememberedHighlight([{ id: 'developer' }] as Action[], (a) => a.id === 'architect'),
    0,
    'with architect absent, the helper does not force architect — it falls back to the first row',
  )
})

// Source-contract checks: the pure helper above is only meaningful if the menu
// actually seeds its highlight through it for both roster modes. Mirrors the
// source-regex style of SpawnDebugToggle.test.tsx.
const menuSource = readFileSync(
  join(process.cwd(), 'src/renderer/src/components/workspace/SpawnAgentMenu.tsx'),
  'utf8',
)

run('the menu seeds agentMenuHighlight from the remembered pick via a lazy initializer', () => {
  assert.match(
    menuSource,
    /useState\(\(\) =>\s*\n?\s*multiloopLaunchMenu/,
    'agentMenuHighlight uses a lazy initializer (re-runs on each open, no row-0 flash) rather than a constant 0',
  )
  assert.match(
    menuSource,
    /rememberedHighlight\(specialistActions, \(action\) => action\.id === lastSelectedSpecialist\)/,
    'the specialist roster restores from lastSelectedSpecialist',
  )
  assert.match(
    menuSource,
    /rememberedHighlight\(MULTILOOP_ROLES, \(soul\) => soul\.role === lastSelectedMultiloopRole\)/,
    'the multiloop roster restores symmetrically from lastSelectedMultiloopRole',
  )
})

if (failures > 0) {
  console.error(`SpawnAgentMenuHighlight.test.tsx: ${failures} failing`)
  process.exit(1)
}
console.log('SpawnAgentMenuHighlight.test.tsx: ok')
