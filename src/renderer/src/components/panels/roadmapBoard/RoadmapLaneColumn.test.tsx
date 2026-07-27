import assert from 'node:assert/strict'

import { renderToStaticMarkup } from 'react-dom/server'

import { RoadmapLaneColumn } from './RoadmapLaneColumn'
import { LIFECYCLE_LABEL } from '../../ui'
import {
  buildRoadmapBoardModel,
  type RoadmapBoardItemInfo,
  type RoadmapBoardLane,
  type RoadmapBoardResolver,
  type RoadmapBoardUnit,
} from '../../../../../shared/sprintengine/roadmap-surface'
import { parseRoadmap } from '../../../../../shared/backlog/roadmap'

// Rendering checks for one track column on the Horizon board — the surface
// MC-1902's per-member glyphs and step done-count land on, and the surface a
// parked lane's REASON has to reach (MC-1909). SSR markup: effects and click
// handlers don't run under renderToStaticMarkup, so these prove what a person
// actually sees, not what the component intends to do on interaction.

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

const CALLBACKS = {
  onApprove: () => undefined,
  onPause: () => undefined,
  onResume: () => undefined,
  onMerge: () => undefined,
  onSkip: () => undefined,
  onEditPlan: () => undefined,
  onOpenRun: () => undefined,
  busyLane: null,
}

function unit(overrides: Partial<RoadmapBoardUnit> = {}): RoadmapBoardUnit {
  return {
    ref: 'backlog/epics/auth.md',
    slug: 'auth',
    kind: 'epic',
    title: 'Auth',
    state: 'running',
    projectKey: null,
    projectName: 'multicode',
    ...overrides,
  }
}

function boardLane(overrides: Partial<RoadmapBoardLane> = {}): RoadmapBoardLane {
  return {
    lane: 'Backend',
    units: [unit()],
    doneCount: 0,
    total: 1,
    reason: 'in_progress',
    attention: 'none',
    ...overrides,
  }
}

function render(lane: RoadmapBoardLane, props: { wide?: boolean } = {}): string {
  return renderToStaticMarkup(
    <RoadmapLaneColumn
      lane={lane}
      folderPath={null}
      callbacks={CALLBACKS}
      onReloadBoard={() => undefined}
      {...props}
    />,
  )
}

// An epic step mid-run: three members, one delivered, one being worked, one queued.
const MIXED_EPIC = boardLane({
  units: [
    unit({
      children: [
        { ref: 'backlog/login.md', title: 'Login', status: 'completed', done: true },
        { ref: 'backlog/logout.md', title: 'Logout', status: 'in_progress', done: false },
        { ref: 'backlog/reset.md', title: 'Reset', status: 'ready', done: false },
      ],
    }),
  ],
})

run('an epic step shows its members, each with its own live lifecycle glyph', () => {
  const markup = render(MIXED_EPIC)
  assert.match(markup, /Login/)
  assert.match(markup, /Logout/)
  assert.match(markup, /Reset/)
  // The glyph vocabulary, by its accessible labels: done / in progress / ready.
  for (const state of ['done', 'in_progress', 'ready'] as const) {
    assert.match(markup, new RegExp(LIFECYCLE_LABEL[state]), `expected a ${state} member glyph`)
  }
})

run('a member completed reads done; a member still ready does not', () => {
  const delivered = render(
    boardLane({
      units: [
        unit({
          children: [
            { ref: 'backlog/login.md', title: 'Login', status: 'completed', done: true },
            { ref: 'backlog/logout.md', title: 'Logout', status: 'completed', done: true },
          ],
        }),
      ],
    }),
  )
  assert.match(delivered, /2\/2 items/)
  const partly = render(
    boardLane({
      units: [
        unit({
          children: [
            { ref: 'backlog/login.md', title: 'Login', status: 'completed', done: true },
            { ref: 'backlog/logout.md', title: 'Logout', status: 'ready', done: false },
          ],
        }),
      ],
    }),
  )
  assert.match(partly, /1\/2 items/)
})

run('a collapsed epic step carries its done-count; an item step carries none', () => {
  assert.match(render(MIXED_EPIC), /1\/3 items/)
  const itemStep = render(
    boardLane({ units: [unit({ kind: 'item', title: 'Lane merge fixes', ref: 'backlog/a.md' })] }),
  )
  assert.doesNotMatch(itemStep, /\d+\/\d+ items/)
})

run('the members carry no added explanatory copy — the glyphs and the count are it', () => {
  const markup = render(MIXED_EPIC)
  for (const phrase of ['Members', 'Progress', 'Status', 'This epic', 'items in this step are']) {
    assert.doesNotMatch(markup, new RegExp(phrase), `unexpected explanatory copy: ${phrase}`)
  }
})

// --- MC-1909: a paused track says what actually failed ----------------------

run('a merge-park states the repo, branch and underlying error', () => {
  const markup = render(
    boardLane({
      parked: {
        reason: 'merge_failed',
        itemRef: 'backlog/epics/auth.md',
        at: '2026-07-27T00:00:00Z',
        detail: 'multicode (sprintengine/auth): gh: base branch was modified',
      },
    }),
  )
  assert.match(markup, /A merge could not complete\./)
  assert.match(markup, /multicode \(sprintengine\/auth\): gh: base branch was modified/)
})

run('every park reason the orchestrator can set has its own copy', () => {
  // A reason with no copy falls back to "This track is paused", which is exactly
  // the unactionable stall MC-1909 exists to close.
  for (const reason of [
    'run_failed',
    'run_canceled',
    'needs_input',
    'pr_closed',
    'merge_failed',
    'start_failed',
    'eligibility_contradiction',
    'unknown_project',
    'paused',
  ] as const) {
    const markup = render(
      boardLane({ parked: { reason, itemRef: 'backlog/a.md', at: '2026-07-27T00:00:00Z' } }),
    )
    assert.doesNotMatch(markup, /This track is paused\./, `${reason} has no copy of its own`)
  }
})

// --- MC-1905: the single-track column widens ---------------------------------

run('a lone track may widen; a track among others keeps the kanban cap', () => {
  assert.match(render(boardLane(), { wide: true }), /max-w-\[560px\]/)
  assert.match(render(boardLane()), /max-w-\[340px\]/)
  // The floor is the same either way, so a narrow window is unchanged.
  assert.match(render(boardLane(), { wide: true }), /min-w-\[280px\]/)
})


// --- SEAM: MC-1904 writes the status, MC-1902 renders it --------------------

// The two items meet at ONE fact: a member's `status:` frontmatter. 1904's
// completed-on-merge write changes it; 1902's glyphs and done-count read it. This
// drives the real chain — roadmap file → buildRoadmapBoardModel → the rendered
// column — with nothing hand-assembled in between, so a renderer that had derived
// its own notion of "done" would show it here.
const SEAM_ROADMAP = parseRoadmap(
  `---\ntype: roadmap\nstatus: ready\nadvance: auto\nmerge: auto\n---\n\n` +
    `## Backend\n- backlog/epics/auth.md\n  - backlog/login.md\n  - backlog/logout.md\n`,
)

function seamResolver(statuses: Record<string, RoadmapBoardItemInfo['status']>): RoadmapBoardResolver {
  const titles: Record<string, string> = {
    'backlog/epics/auth.md': 'Auth',
    'backlog/login.md': 'Login',
    'backlog/logout.md': 'Logout',
  }
  return {
    itemInfo: (_projectKey, relativePath) =>
      titles[relativePath] ? { title: titles[relativePath], status: statuses[relativePath] ?? 'ready' } : undefined,
    projectName: () => 'multicode',
    resolvableProjects: new Set([null]),
  }
}

function renderSeam(statuses: Record<string, RoadmapBoardItemInfo['status']>): string {
  const [lane] = buildRoadmapBoardModel(SEAM_ROADMAP, seamResolver(statuses), new Map())
  return render(lane)
}

run('SEAM: before the merge write, no member reads done and the count is 0/2', () => {
  const markup = renderSeam({ 'backlog/epics/auth.md': 'in_progress' })
  assert.match(markup, /0\/2 items/)
  assert.doesNotMatch(markup, new RegExp(`aria-label="${LIFECYCLE_LABEL.done}"`))
})

run('SEAM: the exact value MC-1904 writes — status: completed — lands as a done glyph and the count', () => {
  // One member flipped, as a run that delivered one of two would leave it.
  const partial = renderSeam({ 'backlog/epics/auth.md': 'in_progress', 'backlog/login.md': 'completed' })
  assert.match(partial, /1\/2 items/)
  assert.match(partial, new RegExp(`aria-label="${LIFECYCLE_LABEL.done}"`))

  // Both flipped: the step reads fully delivered, and the epic's own row derives
  // done from its members rather than from its own frontmatter.
  const full = renderSeam({
    'backlog/epics/auth.md': 'in_progress',
    'backlog/login.md': 'completed',
    'backlog/logout.md': 'completed',
  })
  assert.match(full, /2\/2 items/)
  assert.equal(full.match(new RegExp(`aria-label="${LIFECYCLE_LABEL.done}"`, 'g'))?.length, 2)
})

// --- SEAM: MC-1902, MC-1905 and MC-1909 all land in THIS component ------------

run('SEAM: a widened lone track shows member glyphs, its count, and the park reason at once', () => {
  // Three items edit this one column: 1905 widens it when it is the only track,
  // 1902 adds the member rows and the done-count, 1909 adds the park detail. None
  // of them may quietly cost another its behaviour, so this asserts all three in a
  // single render rather than one per test.
  const markup = render(
    boardLane({
      units: [
        unit({
          state: 'paused',
          children: [
            { ref: 'backlog/login.md', title: 'Login', status: 'completed', done: true },
            { ref: 'backlog/logout.md', title: 'Logout', status: 'ready', done: false },
          ],
        }),
      ],
      parked: {
        reason: 'merge_failed',
        itemRef: 'backlog/epics/auth.md',
        at: '2026-07-27T00:00:00Z',
        detail: 'multicode (sprintengine/auth): gh: base branch was modified',
      },
    }),
    { wide: true },
  )
  assert.match(markup, /max-w-\[560px\]/, 'MC-1905: the lone track still widens')
  assert.match(markup, /1\/2 items/, 'MC-1902: the done-count still renders')
  assert.match(markup, new RegExp(`aria-label="${LIFECYCLE_LABEL.done}"`), 'MC-1902: member glyphs still render')
  assert.match(markup, /gh: base branch was modified/, 'MC-1909: the park reason still renders')
})

if (failures > 0) {
  console.error(`\n${failures} lane-column render checks failed`)
  process.exit(1)
}
