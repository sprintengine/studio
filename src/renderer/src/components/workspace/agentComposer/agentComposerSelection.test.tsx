import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  composerRosterRows,
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
// the remembered selection when its row exists, else falls back to the
// roleless row — never a specialist. Exercising it directly (no store, no DOM) covers the
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

run('falls back to the roleless row when the remembered specialist is absent (disabled pack)', () => {
  const result = resolveInitialSelection(specialistRoster, { kind: 'specialist', specialistId: 'security' })
  assert.deepEqual(
    result,
    { kind: 'general' },
    'a remembered specialist whose pack is now disabled falls back to the roleless row — a role is never a fallback',
  )
})

run('never falls back to a specialist even when the roleless row is missing', () => {
  const cliLessRoster: ComposerRow[] = [{ key: 'terminal', kind: 'terminal' }, specialistRow('architect')]
  const result = resolveInitialSelection(cliLessRoster, { kind: 'specialist', specialistId: 'security' })
  assert.deepEqual(
    result,
    { kind: 'terminal' },
    'with no roleless row the fallback is the first quick row, not the first specialist',
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
// A machine with no agent CLI (MC-2093): the roster stops offering rows that
// launch one. The old catalog escape hatch made every picker offer all eight
// uninstalled CLIs, each of which spawned a bare shell.
// ---------------------------------------------------------------------------

const SPECIALISTS = [
  { id: 'architect', shortLabel: 'Architect', label: 'Architect', description: '' },
  { id: 'developer', shortLabel: 'Developer', label: 'Developer', description: '' },
] as SpecialistAction[]

run('with no CLI installed the roster keeps only what needs no CLI', () => {
  const rows = composerRosterRows({
    showTerminal: true,
    conversationAvailable: true,
    specialistActions: SPECIALISTS,
    noAgentCliInstalled: true,
  })
  assert.deepEqual(
    rows.map((row) => row.kind),
    ['terminal', 'conversation'],
    'Terminal (a plain shell) and Conversation (provider-backed) stay; the roleless and specialist rows go',
  )
  assert.equal(
    rows.some((row) => row.kind === 'general' || row.kind === 'specialist'),
    false,
    'no row that launches a CLI is reachable by click, Enter, or search',
  )
})

run('a select-mode picker with no CLI installed offers no agent at all', () => {
  assert.deepEqual(
    composerRosterRows({
      showTerminal: false,
      conversationAvailable: false,
      specialistActions: SPECIALISTS,
      noAgentCliInstalled: true,
    }),
    [],
    'the Automations soul picker empties rather than persisting an agent that cannot run',
  )
})

run('an installed CLI leaves the roster exactly as it was', () => {
  assert.deepEqual(
    composerRosterRows({
      showTerminal: true,
      conversationAvailable: true,
      specialistActions: SPECIALISTS,
      noAgentCliInstalled: false,
    }).map((row) => row.key),
    ['terminal', 'general', 'conversation', 'specialist:architect', 'specialist:developer'],
    'the normal roster, in order',
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

// Source-contract: the wiring a pure test cannot reach — that the panel names
// the roleless row from THAT row's engine. The icon already did this; the label
// was a constant, so picking a model repainted the icon and not the text.
//
// The popover-density sibling that shared this contract is gone: the spawn
// surface has no roster and therefore no roleless row (MC-2122). What replaced
// it is driven for real in `src/seams/spawnPickerSeam.test.tsx`.
const panelSource = readFileSync(
  join(process.cwd(), 'src/renderer/src/components/workspace/agentComposer/AgentComposer.tsx'),
  'utf8',
)

run('the composer panel labels the roleless row from its own engine, never a constant', () => {
  assert.match(
    panelSource,
    /composer\.engineNamesFor\(\{ kind: 'general' \}\)/,
    "the roleless row's name is resolved against its own engine key, not the highlighted row's",
  )
  assert.equal(panelSource.includes('General agent'), false, '"General agent" is not a name the app uses')
  assert.equal(
    panelSource.includes('general-purpose agent'),
    false,
    'the roleless agent is not described as general-purpose',
  )
  assert.match(panelSource, /Runs your instructions as written\./, 'keeps the description that is actually true')
})

// Source-contract for the wiring the pure roster cannot reach: the hook only
// calls a machine CLI-less once the plugin registry is READY (a pending or
// failed probe leaves the annotated catalog in place, which is what keeps a
// transient failure from emptying the picker), and both surfaces answer that
// state with the shared install route rather than an empty list.
run('the zero-CLI state is derived from a ready catalog and answered with the install route', () => {
  assert.match(
    hookSource,
    /noAgentCliInstalled\s*=\s*pluginCatalogStatus === 'ready' && agentCliOptions\.length === 0/,
    'the flag is "ready and nothing installed", never "the list looks empty"',
  )
  // The spawn picker answers the same state; it is not a roster, so it says so
  // in its own module rather than through this roster's shape.
  const spawnPickerSource = readFileSync(
    join(process.cwd(), 'src/renderer/src/components/workspace/agentComposer/SpawnPicker.tsx'),
    'utf8',
  )
  for (const [name, source] of [['panel', panelSource], ['spawn picker', spawnPickerSource]] as const) {
    assert.match(source, /composer\.noAgentCliInstalled/, `${name}: reads the zero-CLI state`)
    assert.match(source, /<CliInstallRosterRow/, `${name}: offers the shared install route in its place`)
    assert.match(source, /No agent CLI is installed\./, `${name}: says what the machine reported`)
  }
})

if (failures > 0) {
  console.error(`agentComposerSelection.test.tsx: ${failures} failing`)
  process.exit(1)
}
console.log('agentComposerSelection.test.tsx: ok')
