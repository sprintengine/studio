import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'

import type {
  AutomationDefinition,
  AutomationsInstanceEntry,
} from '../../../../../../shared/automations/contracts'
import { BUILTIN_AUTOMATIONS } from '../../../../../../shared/automations/builtin'
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
      builtins={[]}
      addedBuiltinIds={new Set<string>()}
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

// With nothing shipped to show beside them, the project's automations are the
// whole rail — one group, and the substrate withholds a heading over a lone one,
// so the column reads as a list rather than a "Yours" header spanning every row.
// (MC-2035 kept a single group here for a different reason: the starter-editor
// prototype's second "Starters" group was discovery, which is ruled to the
// Extensions shelf. What arrives beside Yours now is not discovery — it is the
// five that ship inside the app, Extensions drawer ruling 2026-09-05.)
run('with no built-ins to list, the rail is the one "Yours" list', () => {
  const html = render()
  assert.ok(
    html.includes('aria-label="Automations: Yours"'),
    'the list is named for the one group it carries',
  )
  assert.ok(!/Starters/i.test(html), 'no Starters group — discovery lives on the Extensions shelf')
  // One list, not one per notional group.
  assert.equal((html.match(/role="list"/g) ?? []).length, 1, 'exactly one list in the rail')
})

// Extensions drawer ruling, 2026-09-05, frame 4: what you have, then what ships.
run('the built-ins are a second group, after Yours, and say when they run', () => {
  const html = render({ builtins: BUILTIN_AUTOMATIONS })
  assert.ok(
    html.indexOf('aria-label="Automations: Yours"') < html.indexOf('aria-label="Automations: Built in"'),
    'Yours leads; Built in follows it',
  )
  assert.ok(html.includes('Dead code sweep'), 'the shipped five are listed')
  assert.ok(html.includes('Nightly 02:00'), 'each with its schedule in words')
  assert.equal((html.match(/role="list"/g) ?? []).length, 2, 'two lists, one per group')
})

// A built-in the project already holds cannot be added again, and the rail is
// where that is first legible — before the card, before the control.
run('a built-in the project already has says so, and keeps its schedule', () => {
  const html = render({
    builtins: BUILTIN_AUTOMATIONS,
    addedBuiltinIds: new Set(['dead-code-sweep-automation']),
  })
  assert.ok(html.includes('Added · Nightly 02:00'), 'Added leads the line, the schedule follows')
})

// An empty group would read as "this app ships none", which is a different and
// false statement about a failed read.
run('a built-in read that could not answer says so rather than showing nothing', () => {
  const html = render({ builtins: [], builtinNotice: 'Loading…' })
  assert.ok(html.includes('Built in'), 'the group still names itself')
  assert.ok(html.includes('Loading…'), 'and says why it has no rows')
})

console.log('all automations rail render tests passed')
