import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  resolveInitialSelection,
  type AgentComposerSelection,
  type ComposerRow,
} from './useAgentComposer'
import type { SpecialistAction, MultiloopRoleDescriptor } from '../../../specialists/specialistActions'
import type { MultiloopRole } from '../../../types/workspace'

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

// resolveInitialSelection is the pure seam behind every composer surface's
// preselected row: given the live roster and the remembered agent, it returns
// the remembered selection when its row exists, else falls back to the first
// specialist/role. Exercising it directly (no store, no DOM) covers the
// restore-from-lastSelected contract and the disabled-pack fallback the pickers
// rely on. It replaces SpawnAgentMenu's rememberedHighlight index seam.
function specialistRow(id: string): ComposerRow {
  return { key: `specialist:${id}`, kind: 'specialist', action: { id, shortLabel: id, label: id, description: '' } as SpecialistAction }
}
function multiloopRow(role: MultiloopRole): ComposerRow {
  return { key: `multiloop:${role}`, kind: 'multiloop', role: { role, shortLabel: role, label: role } as MultiloopRoleDescriptor }
}
const quickRows: ComposerRow[] = [
  { key: 'terminal', kind: 'terminal' },
  { key: 'general', kind: 'general' },
]
const specialistRoster: ComposerRow[] = [
  ...quickRows,
  specialistRow('architect'),
  specialistRow('developer'),
  specialistRow('frontend-design-review'),
]

run('restores the remembered specialist when its row is present', () => {
  const result = resolveInitialSelection(specialistRoster, { kind: 'specialist', specialistId: 'developer' })
  assert.deepEqual(result, { kind: 'specialist', specialistId: 'developer' }, 'the remembered Developer row is preselected')
})

run('preselects a remembered quick row (General) when present', () => {
  const result = resolveInitialSelection(specialistRoster, { kind: 'general' })
  assert.deepEqual(result, { kind: 'general' }, 'a remembered General agent stays selected, not overridden by a specialist')
})

run('falls back to the first specialist when the remembered one is absent (disabled pack)', () => {
  const result = resolveInitialSelection(specialistRoster, { kind: 'specialist', specialistId: 'security' })
  assert.deepEqual(
    result,
    { kind: 'specialist', specialistId: 'architect' },
    'a remembered specialist whose pack is now disabled falls back to the first specialist row, skipping the quick rows',
  )
})

run('falls back to the first role in the multiloop roster', () => {
  const roster = [multiloopRow('architect'), multiloopRow('developer')]
  assert.deepEqual(
    resolveInitialSelection(roster, { kind: 'multiloop', role: 'security' }),
    { kind: 'multiloop', role: 'architect' },
    'an absent remembered role falls back to the first role',
  )
  assert.deepEqual(
    resolveInitialSelection(roster, { kind: 'multiloop', role: 'developer' }),
    { kind: 'multiloop', role: 'developer' },
    'a present remembered role is restored',
  )
})

run('returns the preferred selection unchanged for an empty roster', () => {
  const preferred: AgentComposerSelection = { kind: 'specialist', specialistId: 'developer' }
  assert.deepEqual(resolveInitialSelection([], preferred), preferred, 'an empty roster never yields an out-of-range fallback')
})

// Source-contract: the pure helper above is only meaningful if the hook actually
// seeds its selection through it (lazily, so reopening returns to the last pick
// with no first-row flash). Mirrors the source-regex style of the debug-toggle
// test.
const hookSource = readFileSync(
  join(process.cwd(), 'src/renderer/src/components/workspace/agentComposer/useAgentComposer.ts'),
  'utf8',
)

run('the composer hook seeds its selection via resolveInitialSelection in a lazy initializer', () => {
  assert.match(
    hookSource,
    /useState<AgentComposerSelection>\(\(\) =>\s*\n?\s*resolveInitialSelection\(allRows, initialSelection\)/,
    'selection uses a lazy useState initializer running resolveInitialSelection, not a constant',
  )
})

if (failures > 0) {
  console.error(`agentComposerSelection.test.tsx: ${failures} failing`)
  process.exit(1)
}
console.log('agentComposerSelection.test.tsx: ok')
