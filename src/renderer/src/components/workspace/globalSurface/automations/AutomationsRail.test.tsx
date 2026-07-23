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

function definition(id: string, name: string, over: Partial<AutomationDefinition> = {}): AutomationDefinition {
  return {
    id,
    name,
    status: 'enabled',
    action: { kind: 'spawn-agent', config: {} },
    ...over,
  } as unknown as AutomationDefinition
}

function entry(id: string, name: string, over: Partial<AutomationsInstanceEntry>): AutomationsInstanceEntry {
  return {
    workspaceRoot: '/proj/app',
    workspaceId: 'ws',
    definition: definition(id, name),
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
  entry('c', 'Release notes draft', {
    definition: definition('c', 'Release notes draft', { status: 'paused', action: { kind: 'sprint-engine-run', config: {} } }),
  }),
]

function render(over: Partial<Parameters<typeof AutomationsRail>[0]> = {}): string {
  return renderToStaticMarkup(
    <AutomationsRail
      entries={entries}
      selectedId="a"
      now={NOW}
      onSelect={() => {}}
      onCreate={() => {}}
      search={{ value: '', onChange: () => {}, placeholder: 'Search automations…', ariaLabel: 'Search automations' }}
      filter={{
        ariaLabel: 'Filter automations',
        groups: [
          {
            label: 'State',
            items: [{ value: 'all', label: 'All' }],
            value: 'all',
            defaultValue: 'all',
            onChange: () => {},
          },
        ],
      }}
      {...over}
    />,
  )
}

run('renders each automation with its name, plain state line, and the New automation affordance', () => {
  const html = render()
  assert.ok(html.includes('Nightly code review'), 'lists the automation name')
  assert.ok(html.includes('Ran 2 hours ago · passed'), 'shows the passed state line')
  assert.ok(html.includes('Running now'), 'shows the running state line')
  assert.ok(html.includes('Paused'), 'shows the paused state line')
  assert.ok(html.includes('New automation'), 'carries the New automation affordance')
  assert.ok(
    html.indexOf('New automation') < html.indexOf('Nightly code review'),
    'New automation leads the rail, above the rows',
  )
  assert.ok(html.includes('aria-current="true"'), 'marks the selected row')
})

// Rows carry a type glyph — what the automation runs — never a tone dot; the
// state line beside it carries the words (owner ruling 2026-07-24).
run('rows carry an action-type glyph, not a status dot', () => {
  const html = render()
  assert.ok(html.includes('aria-label="Spawn an agent"'), 'the agent automations carry the agent mark')
  assert.ok(html.includes('aria-label="Run a sprint"'), 'the sprint automation carries the sprint mark')
})

// The search + filter row (the Backlog toolbar idiom) sits above the list.
run('the rail carries the search field and the filter glyph', () => {
  const html = render()
  assert.ok(html.includes('Search automations…'), 'the search field renders')
  assert.ok(html.includes('aria-label="Filter automations"'), 'so does the filter control')
})

console.log('all automations rail render tests passed')
