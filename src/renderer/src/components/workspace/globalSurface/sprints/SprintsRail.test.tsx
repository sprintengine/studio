import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'

import type { SprintRunSummary } from '../../../../../../shared/sprintengine/runSummary'
import { SprintsRail } from './SprintsRail'

function run(name: string, body: () => void): void {
  try {
    body()
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`not ok - ${name}`)
    throw error
  }
}

function summary(overrides: Partial<SprintRunSummary> & { teamSlug: string }): SprintRunSummary {
  const projectRoot = overrides.projectRoot ?? '/work/multicode'
  return {
    statePath: `${projectRoot}/.multi-code/sprintengine/${overrides.teamSlug}/run.yaml`,
    teamSlug: overrides.teamSlug,
    teamName: overrides.teamSlug,
    projectRoot,
    projectName: projectRoot.slice(projectRoot.lastIndexOf('/') + 1),
    runtimeState: 'idle',
    taskCounts: { total: 0, done: 0, inProgress: 0, waiting: 0 },
    repoRollup: { declared: 0, merged: 0, open: 0 },
    needsInputCount: 0,
    startedAt: null,
    updatedAt: null,
    sourceLabel: null,
    ...overrides,
  }
}

const runs: SprintRunSummary[] = [
  summary({
    teamSlug: 'wake-filter-sprint',
    runtimeState: 'running',
    taskCounts: { total: 9, done: 4, inProgress: 1, waiting: 4 },
  }),
  summary({
    teamSlug: 'relay-traffic-efficiency',
    projectRoot: '/work/multicode-mobile',
    runtimeState: 'needs_input',
    needsInputCount: 1,
  }),
  summary({
    teamSlug: 'post-merge-hardening',
    runtimeState: 'completed',
    repoRollup: { declared: 3, merged: 2, open: 1 },
  }),
]

function render(over: Partial<Parameters<typeof SprintsRail>[0]> = {}): string {
  return renderToStaticMarkup(
    <SprintsRail
      runs={runs}
      selectedStatePath={runs[2]!.statePath}
      projectFilter={null}
      onSelect={() => {}}
      onFilter={() => {}}
      onCreate={() => {}}
      {...over}
    />,
  )
}

// Mockup §2 rail anatomy: name over one plain state line, "New sprint" at the
// bottom, the selected row marked.
run('renders each run with its name, plain state line, and the New sprint affordance', () => {
  const html = render()
  assert.ok(html.includes('wake-filter-sprint'), 'lists the run name')
  assert.ok(html.includes('multicode · running · 4 of 9 tasks'), 'running state line')
  assert.ok(html.includes('multicode-mobile · needs your input'), 'needs-input state line')
  assert.ok(html.includes('multicode +2 repos · 1 merge left'), 'multi-repo state line')
  assert.ok(html.includes('New sprint'), 'carries the New sprint affordance')
  assert.ok(html.includes('aria-current="true"'), 'marks the selected row')
})

run('a run whose workspace is long gone still lists — the rail reads the index, not the rail', () => {
  const historical = summary({ teamSlug: 'review-workspace-1673', runtimeState: 'completed', updatedAt: '2026-07-18T09:00:00Z' })
  const html = render({ runs: [historical], selectedStatePath: null })
  assert.ok(html.includes('review-workspace-1673'))
  assert.ok(html.includes('landed Jul 18'))
})

// The rail groups (MC-1838): the list is the inbox — Needs you leads, live work
// under Active, everything else under Recent, and empty groups are omitted.
// Rows carry the app's lifecycle iconography — the same marks the Backlog rows
// use — never a bare tone dot (owner ruling 2026-07-24).
run('rows carry lifecycle glyphs, not tone dots', () => {
  const html = render()
  assert.ok(html.includes('aria-label="Needs input"'), 'the waiting run carries the needs-input mark')
  assert.ok(html.includes('aria-label="Running"'), 'the live run carries the running spinner')
  assert.ok(
    html.includes('aria-label="Ready for review"'),
    'a completed run with a branch still out carries the review branch mark',
  )
  const merged = render({
    runs: [summary({ teamSlug: 'landed-run', runtimeState: 'completed', repoRollup: { declared: 2, merged: 2, open: 0 } })],
    selectedStatePath: null,
  })
  assert.ok(merged.includes('aria-label="Merged"'), 'a fully-merged run carries the purple merge mark')
})

run('rows group under Needs you / Active / Recent', () => {
  const html = render()
  assert.ok(html.includes('Sprints: Needs you'), 'the waiting group renders')
  assert.ok(html.includes('Sprints: Active'), 'so does the live group')
  assert.ok(html.includes('Sprints: Recent'), 'and the rest')
  assert.ok(
    html.indexOf('Needs you') < html.indexOf('relay-traffic-efficiency'),
    'the waiting run sits under Needs you',
  )
})

run('an empty group is omitted, not rendered as an empty header', () => {
  const html = render({ runs: [runs[0]!] })
  assert.ok(!html.includes('Needs you'), 'no waiting group without a waiting run')
  assert.ok(html.includes('Sprints: Active'), 'the one live run still groups')
})

// One compact project filter (MC-1838) instead of a chip strip.
run('the project filter is one compact select with counts', () => {
  const html = render()
  assert.ok(html.includes('aria-label="Filter sprints by project"'), 'the filter is a named control')
  assert.ok(html.includes('All projects · 3'), 'the unfiltered lens carries the total')
  assert.ok(html.includes('role="combobox"'), 'one control, not a chip per project')
})

run('a single-project Multicode shows no filter — a lone option narrows nothing', () => {
  const html = render({ runs: [runs[0]!, runs[2]!] })
  assert.ok(!html.includes('All projects'), 'no filter when every run shares one project')
})

run('a filter that matches no run says so instead of reading as "no sprints"', () => {
  const html = render({ projectFilter: '/work/nowhere' })
  assert.ok(html.includes('No sprints in this project.'))
  assert.ok(html.includes('New sprint'), 'the create path stays reachable')
})

run('an empty index renders no rows and no chips, leaving the empty state to the canvas', () => {
  const html = render({ runs: [], selectedStatePath: null })
  assert.ok(!html.includes('All projects'))
  assert.ok(!html.includes('No sprints in this project.'), 'that copy is for a filtered-out list, not an empty one')
})

console.log('all sprints rail render tests passed')
