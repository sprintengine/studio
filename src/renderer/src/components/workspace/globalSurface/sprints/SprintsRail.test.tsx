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
      search=""
      sort="recent"
      onSelect={() => {}}
      onFilter={() => {}}
      onSearch={() => {}}
      onSort={() => {}}
      onCreate={() => {}}
      {...over}
    />,
  )
}

// Mockup §2 rail anatomy: name over one plain state line, "New sprint" leading
// the rail (never below the scroll), the selected row marked.
run('renders each run with its name, plain state line, and the New sprint affordance', () => {
  const html = render()
  assert.ok(html.includes('wake-filter-sprint'), 'lists the run name')
  assert.ok(html.includes('multicode · running · 4 of 9 tasks'), 'running state line')
  assert.ok(html.includes('multicode-mobile · needs your input'), 'needs-input state line')
  assert.ok(html.includes('multicode +2 repos · 1 merge left'), 'multi-repo state line')
  assert.ok(html.includes('New sprint'), 'carries the New sprint affordance')
  assert.ok(
    html.indexOf('New sprint') < html.indexOf('wake-filter-sprint'),
    'New sprint leads the rail, above the rows',
  )
  assert.ok(html.includes('aria-current="true"'), 'marks the selected row')
})

// Every row carries a hover tooltip with the untruncated title AND state, so a
// clipped name or a terse glyph is always readable in place.
run('rows carry a tooltip naming the run, its lifecycle state, and its state line', () => {
  const html = render()
  assert.ok(
    html.includes('title="wake-filter-sprint — Running · multicode · running · 4 of 9 tasks"'),
    'the tooltip joins name, glyph state, and state line',
  )
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

// The rail's control block, in the Backlog door's toolbar order (MC-1816): the
// project lens LEADS it as one compact Select, then search, then the sort axis
// behind the filter glyph. The lens is never collapsed behind that glyph — a
// person moving between the two doors finds it in the same place.
run('the project lens leads the rail as a Select, ahead of search and the filter glyph', () => {
  const html = render()
  assert.ok(html.includes('role="combobox"'), 'the project lens is a Select, not a glyph-hidden axis')
  const lens = html.indexOf('aria-label="Filter by project"')
  assert.ok(lens > 0, 'named exactly as the Backlog door names its own')
  assert.ok(html.includes('All projects · 3'), 'its trigger reads the current scope and the run total')
  const newSprint = html.indexOf('New sprint')
  const search = html.indexOf('Search sprints…')
  const firstGroup = html.indexOf('Sprints: Needs you')
  assert.ok(newSprint < lens && lens < search, 'New sprint, then the project lens, then search')
  assert.ok(
    html.indexOf('aria-label="Filter and sort sprints"') < firstGroup,
    'sort stays behind the filter glyph, still above the first row',
  )
  assert.ok(search < firstGroup, 'the whole control block sits above the rows')
})

run('a single-project Multicode shows no lens — a lone option narrows nothing', () => {
  const html = render({ runs: [runs[0]!, runs[2]!] })
  assert.ok(!html.includes('aria-label="Filter by project"'), 'no lens when every run shares one project')
  assert.ok(html.includes('Search sprints…'), 'search stays')
  assert.ok(html.includes('aria-label="Filter and sort sprints"'), 'and so does sort')
})

run('a filter that matches no run says so instead of reading as "no sprints"', () => {
  const html = render({ projectFilter: '/work/nowhere' })
  assert.ok(html.includes('No sprints in this project.'))
  assert.ok(html.includes('New sprint'), 'the create path stays reachable')
})

// The last run in the filtered project was deleted while it was selected, so the
// lens now names a project the chips no longer carry. The trigger must still say
// which lens is applied — a placeholder there would leave the operator staring at
// an empty rail with nothing naming why, and no way back.
run('a filter stranded by a deleted run still names itself and offers a way back', () => {
  const html = render({ projectFilter: '/work/nowhere' })
  assert.ok(html.includes('aria-label="Filter by project"'), 'the lens is still offered')
  assert.ok(html.includes('nowhere · no sprints'), 'and the trigger names the applied lens, not a placeholder')
  assert.ok(!html.includes('Select…'), 'never the Select placeholder')
})

// Same state on a single-project Multicode, which otherwise gets no lens at all:
// without one there is no control that can clear the filter, so the rail would
// stay permanently empty.
run('a lone project with a stranded filter still gets a lens — else there is no way back', () => {
  const html = render({ runs: [runs[0]!, runs[2]!], projectFilter: '/work/nowhere' })
  assert.ok(html.includes('aria-label="Filter by project"'), 'the lens appears to carry the way back')
  assert.ok(html.includes('nowhere · no sprints'), 'naming the lens that is stranding the rail')
})

run('a search that matches no run says so instead of reading as "no sprints"', () => {
  const html = render({ search: 'zzz-not-a-run' })
  assert.ok(html.includes('No sprints match.'))
  assert.ok(html.includes('New sprint'), 'the create path stays reachable')
})

run('search narrows the rows by team or project name', () => {
  const html = render({ search: 'relay' })
  assert.ok(html.includes('relay-traffic-efficiency'), 'the matching run stays')
  assert.ok(!html.includes('wake-filter-sprint'), 'the rest drop')
})

run('an empty index renders no rows and no chips, leaving the empty state to the canvas', () => {
  const html = render({ runs: [], selectedStatePath: null })
  assert.ok(!html.includes('All projects'))
  assert.ok(!html.includes('No sprints in this project.'), 'that copy is for a filtered-out list, not an empty one')
})

console.log('all sprints rail render tests passed')
