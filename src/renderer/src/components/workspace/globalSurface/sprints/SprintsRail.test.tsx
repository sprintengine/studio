import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'

import type { SprintRunSummary } from '../../../../../../shared/sprintengine/runSummary'
import { buildSprintRailGroups } from './railState'
import { SprintsRail, sprintRowTooltip } from './SprintsRail'
import { SPRINTS_DOOR, WORKFLOWS_DOOR } from './runDoorCopy'

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

// Every row carries a whole-row tooltip with the untruncated title AND state, so
// a clipped name or a terse glyph is always readable in place. It is the
// product `Tooltip` on the row button — opened on hover or focus, so it is not
// in static markup — never a native `title`, which the keyboard cannot reach.
run('rows carry a tooltip naming the run, its lifecycle state, and its state line', () => {
  const rows = buildSprintRailGroups(runs, null, 'recent').flatMap((group) => group.rows)
  const row = rows.find((candidate) => candidate.title === 'wake-filter-sprint')
  assert.ok(row, 'the running sprint is a rail row')
  assert.equal(
    sprintRowTooltip(row),
    'wake-filter-sprint — Running · multicode · running · 4 of 9 tasks',
    'the tooltip joins name, glyph state, and state line',
  )
  const html = render()
  assert.ok(!html.includes('title="wake-filter-sprint'), 'and it is never a native title attribute')
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
// One anatomy on every list surface: "New …", then search with the filter glyph
// beside it, then ONE divider, then the rows. The project lens is an axis behind
// that glyph like any other — never a second full-width Select stacked over the
// field it narrows.
run('the rail is New, then search with one filter glyph, then the rows', () => {
  const html = render()
  assert.ok(!html.includes('role="combobox"'), 'the project lens is not a Select above the search')
  const newSprint = html.indexOf('New sprint')
  const search = html.indexOf('Search sprints…')
  const glyph = html.indexOf('aria-label="Filter and sort sprints"')
  const firstGroup = html.indexOf('Sprints: Needs you')
  assert.ok(newSprint < search, 'New sprint leads the rail')
  assert.ok(search < glyph, 'the filter glyph sits beside the search field')
  assert.ok(glyph < firstGroup, 'the whole control block sits above the rows')
})

// The menu's options only exist once the popover opens, so what a static render
// can prove is the part that must be visible AT REST: hiding the lens behind a
// glyph must never hide that a lens is applied.
run('a narrowed project lens marks the filter glyph as active', () => {
  const resting = render()
  assert.ok(
    resting.includes('aria-label="Filter and sort sprints"'),
    'at rest the glyph reports no filters',
  )
  const narrowed = render({ projectFilter: '/work/alpha' })
  assert.ok(
    narrowed.includes('aria-label="Filter and sort sprints — filters active"'),
    'a project lens applied from inside the menu still says so on the trigger',
  )
})

run('a single-project rail still offers the glyph for sort', () => {
  const html = render({ runs: [runs[0]!, runs[2]!] })
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
run('a filter stranded by a deleted run still says so, and the way back stays reachable', () => {
  const html = render({ projectFilter: '/work/nowhere' })
  assert.ok(
    html.includes('aria-label="Filter and sort sprints — filters active"'),
    'the glyph reports that a lens is narrowing the empty rail',
  )
  assert.ok(html.includes('aria-haspopup="menu"'), 'and the menu holding the lens is still there to clear it')
})

// Same state on a lone project, which otherwise gets no project axis at all:
// without one there is no control that can clear the filter, so the rail would
// stay permanently empty.
run('a lone project with a stranded filter still gets the axis — else there is no way back', () => {
  const html = render({ runs: [runs[0]!, runs[2]!], projectFilter: '/work/nowhere' })
  assert.ok(
    html.includes('aria-label="Filter and sort sprints — filters active"'),
    'the glyph says a lens is stranding the rail',
  )
  assert.ok(html.includes('No sprints in this project.'), 'and the rail says why it is empty')
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

// ── Two doors, two plus buttons (item 2470) ─────────────────────────────────
// The same rail renders both doors. What must differ is exactly two things: the
// sentence under the door's name, and the words on its own `+` — and each must
// carry only its own.
run('each door states its difference once, under its name', () => {
  const workflows = render({ door: WORKFLOWS_DOOR })
  const sprints = render({ door: SPRINTS_DOOR })
  assert.ok(
    workflows.includes('You have a goal. An architect works out what the work is, then a roster does it.'),
    'the Workflows door says what a workflow is',
  )
  assert.ok(
    sprints.includes('The work is already written down. Agents take what is ready until the graph is empty.'),
    'the Sprints door says what a sprint is',
  )
  assert.ok(
    !workflows.includes('The work is already written down'),
    'and neither door explains the other',
  )
  assert.ok(!sprints.includes('You have a goal.'))
  // Once, not twice: the sentence is the rail's intro and appears nowhere else
  // in the column.
  const occurrences = sprints.split('The work is already written down').length - 1
  assert.equal(occurrences, 1, 'the difference is stated once and never again')
})

run('each door renders its own `+` at the end of its list', () => {
  const workflows = render({ door: WORKFLOWS_DOOR })
  const sprints = render({ door: SPRINTS_DOOR })
  assert.ok(workflows.includes('New workflow — say what you want done'), 'the Workflows plus row')
  assert.ok(sprints.includes('New sprint — pick the work it should run'), 'the Sprints plus row')
  assert.ok(!workflows.includes('New sprint — '), 'neither door offers to create the other kind')
  assert.ok(!sprints.includes('New workflow'))
  // The plus is at the END of the list, after the rows — the rail's own
  // New-at-top affordance is a separate, earlier control.
  const rowIndex = sprints.indexOf('post-merge-hardening')
  assert.ok(
    rowIndex >= 0 && rowIndex < sprints.indexOf('New sprint — pick the work it should run'),
    'the plus row comes after the runs it follows',
  )
})

console.log('all sprints rail render tests passed')
