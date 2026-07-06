import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'

import { ArchitectTeamCard } from './ArchitectTeamCard'
import { modelCatalogEntryKey } from '../../../utils/modelCatalog'
import type { SprintEngineCliOption } from './SprintEngineRosterTable'
import type { SprintEngineModelCatalogEntry } from '../../../types/workspace'

function run(name: string, body: () => void): void {
  try {
    body()
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`not ok - ${name}`)
    throw error
  }
}

const CLI_OPTIONS: SprintEngineCliOption[] = [
  { value: 'claude-code', label: 'Claude Code' },
  { value: 'zai', label: 'Z.AI' },
]

const ENTRIES: SprintEngineModelCatalogEntry[] = [
  { cli: 'claude-code', model: 'claude-fable-5', offeredByDefault: true, intelligence: 9, frontendDesign: 8, mobile: 6, speed: 4, cost: 10 },
  { cli: 'zai', model: null, offeredByDefault: false, intelligence: 5, frontendDesign: 4, mobile: 3, speed: 8, cost: 1 },
]

function render(selectedKeys: ReadonlySet<string>, guidance = ''): string {
  return renderToStaticMarkup(
    <ArchitectTeamCard
      seat={{ cli: 'claude-code', model: 'claude-fable-5' }}
      seatDefaultedFromCatalog
      cliOptions={CLI_OPTIONS}
      onChangeSeat={() => {}}
      availableEntries={ENTRIES}
      selectedKeys={selectedKeys}
      onToggleEntry={() => {}}
      guidance={guidance}
      onChangeGuidance={() => {}}
    />,
  )
}

run('renders the three labelled rows with exact copy', () => {
  const html = render(new Set([modelCatalogEntryKey('claude-code', 'claude-fable-5')]))
  assert.ok(html.includes('Architect runs on'))
  assert.ok(html.includes('Models for this sprint'))
  assert.ok(html.includes('Guidance for the architect'))
  assert.ok(html.includes('Team is approved with the plan.'))
})

run('reflects the ticked/unticked state per entry', () => {
  const html = render(new Set([modelCatalogEntryKey('claude-code', 'claude-fable-5')]))
  // Two model checkboxes, one checked (fable) and one not (zai CLI default).
  const checked = (html.match(/role="checkbox" aria-checked="true"/g) ?? []).length
  const unchecked = (html.match(/role="checkbox" aria-checked="false"/g) ?? []).length
  assert.equal(checked, 1)
  assert.equal(unchecked, 1)
  // Model ids + score hints render; null model shows the CLI-default label.
  assert.ok(html.includes('claude-fable-5'))
  assert.ok(html.includes('CLI default'))
  assert.ok(html.includes('intel 9'))
  assert.ok(html.includes('10×'))
})

run('shows the guidance value in the input', () => {
  const html = render(new Set(), 'Quality matters')
  assert.ok(html.includes('value="Quality matters"'))
})

console.log('all ArchitectTeamCard render tests passed')
