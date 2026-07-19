import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'

import type {
  AutomationDefinition,
  AutomationsInstanceEntry,
} from '../../../../../../shared/automations/contracts'
import { AutomationsRail } from './AutomationsRail'

function run(name: string, body: () => void): void {
  try {
    body()
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`not ok - ${name}`)
    throw error
  }
}

const NOW = Date.parse('2026-07-19T12:00:00Z')

function entry(id: string, name: string, over: Partial<AutomationsInstanceEntry>): AutomationsInstanceEntry {
  return {
    workspaceRoot: '/proj/app',
    workspaceId: 'ws',
    definition: { id, name, status: 'enabled' } as unknown as AutomationDefinition,
    lastRun: null,
    isRunningNow: false,
    ...over,
  }
}

const entries: AutomationsInstanceEntry[] = [
  entry('a', 'Nightly code review', {
    lastRun: { id: 'r', automationId: 'a', status: 'completed', dueAt: '2026-07-19T10:00:00Z', startedAt: null, completedAt: '2026-07-19T10:00:00Z' } as unknown as AutomationsInstanceEntry['lastRun'],
  }),
  entry('b', 'Backlog triage', { isRunningNow: true }),
  entry('c', 'Release notes draft', { definition: { id: 'c', name: 'Release notes draft', status: 'paused' } as unknown as AutomationDefinition }),
]

run('renders each automation with its name, plain state line, and the New automation affordance', () => {
  const html = renderToStaticMarkup(
    <AutomationsRail entries={entries} selectedId="a" now={NOW} onSelect={() => {}} onKeyDown={() => {}} onCreate={() => {}} />,
  )
  assert.ok(html.includes('Nightly code review'), 'lists the automation name')
  assert.ok(html.includes('Ran 2 hours ago · passed'), 'shows the passed state line')
  assert.ok(html.includes('Running now'), 'shows the running state line')
  assert.ok(html.includes('Paused'), 'shows the paused state line')
  assert.ok(html.includes('New automation'), 'carries the New automation affordance')
  assert.ok(html.includes('aria-current="true"'), 'marks the selected row')
})

console.log('all automations rail render tests passed')
