import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  engineNames,
  resolveInitialSelection,
  type AgentComposerSelection,
  type ComposerRow,
} from './useAgentComposer'
import type { SpecialistAction } from '../../../specialists/specialistActions'

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
  assert.deepEqual(result, { kind: 'general' }, 'a remembered roleless agent stays selected, not overridden by a specialist')
})

run('falls back to the first specialist when the remembered one is absent (disabled pack)', () => {
  const result = resolveInitialSelection(specialistRoster, { kind: 'specialist', specialistId: 'security' })
  assert.deepEqual(
    result,
    { kind: 'specialist', specialistId: 'architect' },
    'a remembered specialist whose pack is now disabled falls back to the first specialist row, skipping the quick rows',
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

// ---------------------------------------------------------------------------
// The roleless row is named by its bound engine (MC-2059). It has no role, so
// the model it launches — or the CLI, when no model is picked — is the only
// honest name for it. It used to read the constant "General agent", which never
// changed when the owner picked Fable 5 on it.
// ---------------------------------------------------------------------------

const CATALOG = [
  {
    value: 'claude-code' as const,
    label: 'Claude Code',
    modelSelection: {
      options: [
        { id: 'claude-fable-5', label: 'Fable 5' },
        { id: 'claude-opus-5[1m]', label: 'Opus (latest, 1M context)' },
      ],
      allowCustomId: true,
    },
  },
  { value: 'codex' as const, label: 'Codex' },
] as unknown as Parameters<typeof engineNames>[0]

run('a picked model names the agent', () => {
  assert.deepEqual(
    engineNames(CATALOG, 'claude-code', 'claude-fable-5'),
    { cliLabel: 'Claude Code', modelLabel: 'Fable 5' },
    'the row reads back the model that was picked on it',
  )
  assert.equal(
    engineNames(CATALOG, 'claude-code', 'claude-opus-5[1m]').modelLabel,
    'Opus (latest, 1M context)',
    'including a model whose label carries its context window',
  )
})

run('no model means the CLI names the agent', () => {
  assert.deepEqual(
    engineNames(CATALOG, 'codex', undefined),
    { cliLabel: 'Codex', modelLabel: null },
    'a CLI running its own default model is named by the CLI',
  )
})

run('an unlabelled model keeps its id, and an unknown CLI keeps its own', () => {
  assert.equal(
    engineNames(CATALOG, 'claude-code', 'claude-haiku-4-5-20251001').modelLabel,
    'claude-haiku-4-5-20251001',
    'a user-added model id is shown as itself, never renamed to a catalog neighbour',
  )
  assert.deepEqual(
    engineNames([], 'claude-code', undefined),
    { cliLabel: 'claude-code', modelLabel: null },
    'an empty catalog (registry still loading) falls back to the id, not to a blank row',
  )
})

// Source-contract: the wiring a pure test cannot reach — that each surface
// names the roleless row from THAT row's engine. The icon already did this; the
// label was a constant, so picking a model repainted the icon and not the text.
const popoverSource = readFileSync(
  join(process.cwd(), 'src/renderer/src/components/workspace/agentComposer/AgentComposerPopover.tsx'),
  'utf8',
)
const panelSource = readFileSync(
  join(process.cwd(), 'src/renderer/src/components/workspace/agentComposer/AgentComposer.tsx'),
  'utf8',
)

run('both composer surfaces label the roleless row from its own engine, never a constant', () => {
  for (const [name, source] of [['popover', popoverSource], ['panel', panelSource]] as const) {
    assert.match(
      source,
      /composer\.engineNamesFor\(\{ kind: 'general' \}\)/,
      `${name}: the roleless row's name is resolved against its own engine key, not the highlighted row's`,
    )
  }
  assert.match(
    popoverSource,
    /const label = rowLabel\(row, rolelessLabel\)/,
    'the popover passes that one resolved name into every row it renders',
  )
  for (const [name, source] of [['popover', popoverSource], ['panel', panelSource]] as const) {
    assert.equal(source.includes('General agent'), false, `${name}: "General agent" is not a name the app uses`)
    assert.equal(
      source.includes('general-purpose agent'),
      false,
      `${name}: the roleless agent is not described as general-purpose`,
    )
    assert.match(source, /Runs your instructions as written\./, `${name}: keeps the description that is actually true`)
  }
})

if (failures > 0) {
  console.error(`agentComposerSelection.test.tsx: ${failures} failing`)
  process.exit(1)
}
console.log('agentComposerSelection.test.tsx: ok')
