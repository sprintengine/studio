import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  ModelCatalogHeaderRow,
  ModelCatalogRow,
  draftRowToEntry,
  entryToDraftRow,
  isCatalogCliUnavailable,
  modelCatalogRowEmphasis,
  type ModelCatalogDraftRow,
} from './modelCatalogRows'
import { normalizeSprintEngineModelCatalog } from '../../utils/modelCatalog'
import type { AgentCliAvailabilityMap, SprintEngineModelCatalogEntry } from '../../types/workspace'

function run(name: string, body: () => void): void {
  try {
    body()
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`not ok - ${name}`)
    throw error
  }
}

function draft(overrides: Partial<ModelCatalogDraftRow> = {}): ModelCatalogDraftRow {
  return {
    key: 1,
    cli: 'claude-code',
    model: 'claude-opus-4-8',
    offeredByDefault: true,
    intelligence: '9',
    frontendDesign: '8',
    mobile: '6',
    speed: '4',
    cost: '5',
    note: 'solid all-rounder',
    ...overrides,
  }
}

function availability(entries: Record<string, boolean>): AgentCliAvailabilityMap {
  const map: AgentCliAvailabilityMap = {}
  for (const [cli, installed] of Object.entries(entries)) {
    map[cli] = { cli, installed, resolvedPath: installed ? `/bin/${cli}` : null, version: null }
  }
  return map
}

// --- Pure mapping: draft <-> entry, coercion delegated to the T1 normalizer ---

run('draftRowToEntry maps a fully-specified row and normalizes cleanly', () => {
  const [entry] = normalizeSprintEngineModelCatalog([draftRowToEntry(draft())])
  assert.deepEqual(entry, {
    cli: 'claude-code',
    model: 'claude-opus-4-8',
    offeredByDefault: true,
    intelligence: 9,
    frontendDesign: 8,
    mobile: 6,
    speed: 4,
    cost: 5,
    note: 'solid all-rounder',
  })
})

run('entryToDraftRow round-trips through draftRowToEntry + normalizer', () => {
  const entry: SprintEngineModelCatalogEntry = {
    cli: 'zai',
    model: null,
    offeredByDefault: false,
    intelligence: 5,
    frontendDesign: 4,
    mobile: 3,
    speed: 8,
    cost: 1,
  }
  const [round] = normalizeSprintEngineModelCatalog([draftRowToEntry(entryToDraftRow(entry, 7))])
  assert.deepEqual(round, entry)
})

run('blank numeric fields fall back via the normalizer (axis => 5, cost => 1), not Number("")===0', () => {
  const [entry] = normalizeSprintEngineModelCatalog([
    draftRowToEntry(draft({ intelligence: '', frontendDesign: '   ', mobile: 'x', speed: '', cost: '' })),
  ])
  assert.equal(entry.intelligence, 5)
  assert.equal(entry.frontendDesign, 5)
  assert.equal(entry.mobile, 5)
  assert.equal(entry.speed, 5)
  assert.equal(entry.cost, 1)
})

run('blank note is omitted from the normalized entry', () => {
  const [entry] = normalizeSprintEngineModelCatalog([draftRowToEntry(draft({ note: '   ' }))])
  assert.equal('note' in entry, false)
})

// --- Availability greying: cautious, mirrors filterCatalogByAvailability ---

run('isCatalogCliUnavailable only greys a known-uninstalled CLI when detection is trustworthy', () => {
  const map = availability({ 'claude-code': true, codex: false })
  // Trustworthy: ready + at least one installed + this CLI explicitly not installed.
  assert.equal(isCatalogCliUnavailable('codex', map, 'ready'), true)
  assert.equal(isCatalogCliUnavailable('claude-code', map, 'ready'), false)
  // Unknown CLI (no entry) reads as not-yet-probed, never unavailable.
  assert.equal(isCatalogCliUnavailable('opencode', map, 'ready'), false)
  // Detection not trustworthy: loading, missing map, or zero installed => never grey.
  assert.equal(isCatalogCliUnavailable('codex', map, 'loading'), false)
  assert.equal(isCatalogCliUnavailable('codex', null, 'ready'), false)
  assert.equal(isCatalogCliUnavailable('codex', availability({ codex: false }), 'ready'), false)
})

run('modelCatalogRowEmphasis greys an unavailable row (recessed bg + muted data text) and leaves an available row at full strength', () => {
  const off = modelCatalogRowEmphasis(true)
  assert.equal(off.rowBg, 'bg-[color:var(--bg-app)]')
  assert.equal(off.cellText, 'text-[color:var(--text-muted)]')
  const on = modelCatalogRowEmphasis(false)
  assert.equal(on.rowBg, 'bg-[color:var(--bg-surface-raised)]')
  assert.equal(on.cellText, 'text-[color:var(--text-strong)]')
  // The two states must be visually distinct, or "greyed" is not conveyed.
  assert.notEqual(off.rowBg, on.rowBg)
  assert.notEqual(off.cellText, on.cellText)
})

// --- Rendered surface: required column copy + unavailable hint ---

run('header renders the required plain column labels', () => {
  const html = renderToStaticMarkup(<ModelCatalogHeaderRow />)
  for (const label of ['Default', 'CLI', 'Model', 'Intelligence', 'Frontend design', 'Mobile', 'Speed', 'Cost ×', 'Note']) {
    assert.ok(html.includes(label), `header missing column label: ${label}`)
  }
})

run('unavailable row shows the CLI-not-installed hint with the friendly CLI label', () => {
  const html = renderToStaticMarkup(
    <ModelCatalogRow
      row={draft({ cli: 'opencode', model: 'qwen3-coder' })}
      cliOption={{ value: 'opencode', label: 'OpenCode', modelSelection: { options: [], allowCustomId: true } }}
      installedCliOptions={[{ value: 'claude-code', label: 'Claude Code' }]}
      unavailable
      onUpdate={() => {}}
      onReconcile={() => {}}
      onRemove={() => {}}
    />,
  )
  assert.ok(html.includes('CLI not installed'), 'expected unavailable badge')
  assert.ok(html.includes('OpenCode'), 'expected friendly CLI label in the hint')
})

run('available row renders editable score/cost/note controls and hides the unavailable hint', () => {
  const html = renderToStaticMarkup(
    <ModelCatalogRow
      row={draft()}
      cliOption={{ value: 'claude-code', label: 'Claude Code', modelSelection: { options: [], allowCustomId: true } }}
      installedCliOptions={[{ value: 'claude-code', label: 'Claude Code' }]}
      unavailable={false}
      onUpdate={() => {}}
      onReconcile={() => {}}
      onRemove={() => {}}
    />,
  )
  assert.equal(html.includes('CLI not installed'), false, 'installed row must not show the unavailable hint')
  assert.ok(html.includes('role="switch"'), 'expected the offered-by-default switch')
  // One aria-labelled input per axis + cost + note keeps the row keyboard/SR usable.
  assert.ok(html.includes('Intelligence score (1–10)'), 'expected labelled intelligence input')
  assert.ok(html.includes('Cost multiplier for'), 'expected labelled cost input')
  assert.ok(html.includes('Note for'), 'expected labelled note input')
  assert.ok(html.includes('from the catalog'), 'expected the remove control')
})
