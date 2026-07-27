import assert from 'node:assert/strict'

import { renderToStaticMarkup } from 'react-dom/server'

import { HorizonPlanColumn, trackSteeringItems, type HorizonSteering } from './HorizonPlanColumn'
import { buildHorizonPlan, type HorizonRefDisplay } from './horizonPlanModel'
import { parseRoadmap, type RoadmapLane } from '../../../../../shared/backlog/roadmap'
import type { RoadmapBoardLane, RoadmapBoardUnit } from '../../../../../shared/sprintengine/roadmap-surface'

// What a person actually SEES in the plan column (MC-1924, mockup frame 1). SSR
// markup: effects and click handlers don't run under renderToStaticMarkup, so
// these prove the rendered anatomy — one-line rows, no id, no status word, the
// attention notice on the work, the Delivered footer — rather than intent.

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

const DISPLAY = new Map<string, HorizonRefDisplay>([
  ['backlog/one.md', { title: 'Terminal links open a chooser', displayId: 'MC-1899' }],
  ['backlog/epics/ext.md', { title: 'Extensions: doors become installable modules', displayId: 'MC-1853' }],
  ['backlog/child-a.md', { title: 'Child A', status: 'completed' }],
  ['backlog/child-b.md', { title: 'Child B', status: 'ready' }],
  ['backlog/done.md', { title: 'Sprint Engine simplification', status: 'completed' }],
])

const STEERING: HorizonSteering = {
  busyLane: null,
  pausedLanes: new Set(),
  onPause: () => undefined,
  onResume: () => undefined,
  onApprove: () => undefined,
  onMerge: () => undefined,
}

function lanesOf(body: string): RoadmapLane[] {
  return parseRoadmap(`---\ntype: roadmap\n---\n${body}`).lanes
}

function unit(overrides: Partial<RoadmapBoardUnit> = {}): RoadmapBoardUnit {
  return {
    ref: 'backlog/one.md',
    slug: 'one',
    kind: 'item',
    title: 'Terminal links open a chooser',
    state: 'queued',
    projectKey: null,
    projectName: 'multicode',
    ...overrides,
  }
}

function render({
  lanes,
  boardLanes = [],
  selectedRef = null,
  showProjectTag = false,
  steering = STEERING,
}: {
  lanes: RoadmapLane[]
  boardLanes?: RoadmapBoardLane[]
  selectedRef?: string | null
  showProjectTag?: boolean
  steering?: HorizonSteering
}): string {
  const plan = buildHorizonPlan({
    lanes,
    boardLanes,
    refDisplay: DISPLAY,
    projectNameByKey: new Map([[null, 'multicode'], ['mobile', 'multicode-mobile']]),
    policyRoster: undefined,
    knownRosterNames: new Set(['no roles']),
    defaultRosterLabel: 'No roles',
  })
  return renderToStaticMarkup(
    <HorizonPlanColumn
      plan={plan}
      lanes={lanes}
      selectedRef={selectedRef}
      onSelect={() => undefined}
      showProjectTag={showProjectTag}
      rosters={[]}
      policyRoster={undefined}
      onManageRosters={() => undefined}
      onLanes={() => undefined}
      onAddRef={() => undefined}
      onResyncEpic={() => undefined}
      onOpenItem={() => undefined}
      onAddWork={() => undefined}
      addWorkActive={false}
      libraryDragRef={null}
      steering={steering}
      onRenameTrack={() => undefined}
      onRemoveTrack={() => undefined}
    />,
  )
}

const SIMPLE = lanesOf('## Delivery\n- backlog/one.md\n')

run('the head names the single track and carries Add work', () => {
  const markup = render({ lanes: SIMPLE })
  assert.match(markup, /Delivery/)
  assert.match(markup, /Add work/)
  assert.match(markup, /aria-label="Track options"/)
})

run('a row is 26px and says title only — no id, no status word', () => {
  const markup = render({
    lanes: SIMPLE,
    boardLanes: [
      { lane: 'Delivery', units: [unit({ state: 'up_next' })], doneCount: 0, total: 1, reason: 'eligible', attention: 'none' },
    ],
  })
  assert.match(markup, /h-\[26px\]/, 'rows are one line at 26px')
  assert.match(markup, /Terminal links open a chooser/)
  assert.doesNotMatch(markup, /MC-1899/, 'the id belongs to the detail, not every row')
  assert.doesNotMatch(markup, />Up next</, 'the glyph already says the state')
  assert.doesNotMatch(markup, />Queued</)
})

run('a single-project horizon repeats no project tag; a spanning one names the project', () => {
  const single = render({ lanes: SIMPLE, showProjectTag: false })
  assert.doesNotMatch(single, /In multicode/)
  const spanning = render({ lanes: SIMPLE, showProjectTag: true })
  assert.match(spanning, /title="In multicode"/)
})

run('Now names the running step; the remainder is an unlabelled ordered list', () => {
  const lanes = lanesOf('## Delivery\n- backlog/done.md\n- backlog/one.md\n')
  const markup = render({
    lanes,
    boardLanes: [
      {
        lane: 'Delivery',
        units: [
          unit({ ref: 'backlog/done.md', title: 'Sprint Engine simplification', state: 'running' }),
          unit({ ref: 'backlog/one.md', state: 'queued' }),
        ],
        doneCount: 0,
        total: 2,
        reason: 'in_progress',
        attention: 'none',
      },
    ],
  })
  assert.match(markup, />Now</)
  // Exactly one named band — the ordered remainder carries a rule, not a label.
  assert.equal((markup.match(/>Now</g) ?? []).length, 1)
})

run('selection is the accent-soft fill plus the 2px left accent bar', () => {
  const markup = render({ lanes: SIMPLE, selectedRef: 'backlog/one.md' })
  assert.match(markup, /border-l-2/)
  assert.match(markup, /border-\[color:var\(--accent-primary\)\] bg-\[color:var\(--accent-primary-soft\)\]/)
  assert.match(markup, /aria-current="true"/)
})

run('an epic step carries its size in the trailing slot', () => {
  const lanes = lanesOf('## Delivery\n- backlog/epics/ext.md\n  - backlog/child-a.md\n  - backlog/child-b.md\n')
  const markup = render({ lanes })
  assert.match(markup, /Extensions: doors become installable modules/)
  assert.match(markup, />1\/2</, 'one of two members has landed')
})

run('a parked track states its real reason and offers the one action, on the step', () => {
  const lanes = lanesOf('## Delivery\n- backlog/one.md\n')
  const markup = render({
    lanes,
    boardLanes: [
      {
        lane: 'Delivery',
        units: [unit({ state: 'paused' })],
        doneCount: 0,
        total: 1,
        reason: 'blocked',
        attention: 'paused',
        parked: {
          reason: 'start_failed',
          itemRef: 'backlog/one.md',
          at: '2026-07-27T00:00:00Z',
          detail: 'the saved roster “opus” was not found',
        },
      },
    ],
  })
  assert.match(markup, /No sprint was created\. Resume to continue\./)
  assert.match(markup, /the saved roster “opus” was not found/, 'the underlying reason, not a summary of it')
  assert.match(markup, />Resume</)
})

run('the selected step does not restate the merge action its detail already carries', () => {
  const lanes = lanesOf('## Delivery\n- backlog/one.md\n')
  const boardLanes: RoadmapBoardLane[] = [
    {
      lane: 'Delivery',
      units: [unit({ state: 'running' })],
      doneCount: 0,
      total: 1,
      reason: 'awaiting_merge',
      attention: 'merge',
      activeItemRef: 'backlog/one.md',
    },
  ]
  assert.match(render({ lanes, boardLanes }), /Approve &amp; merge/, 'an unselected step still shows it')
  assert.doesNotMatch(
    render({ lanes, boardLanes, selectedRef: 'backlog/one.md' }),
    /Approve &amp; merge/,
    'the selected step’s detail pane is the louder home for it',
  )
})

run('Delivered is a closed footer carrying steps and items', () => {
  const lanes = lanesOf('## Delivery\n- backlog/done.md\n- backlog/one.md\n')
  const markup = render({
    lanes,
    boardLanes: [
      {
        lane: 'Delivery',
        units: [
          unit({ ref: 'backlog/done.md', title: 'Sprint Engine simplification', state: 'done' }),
          unit({ ref: 'backlog/one.md', state: 'up_next' }),
        ],
        doneCount: 1,
        total: 2,
        reason: 'eligible',
        attention: 'none',
      },
    ],
  })
  assert.match(markup, /Delivered/)
  assert.match(markup, /1 step · 1 item/)
  assert.match(markup, /aria-expanded="false"/, 'closed at rest')
  assert.doesNotMatch(
    markup,
    /Sprint Engine simplification/,
    'a delivered step is not also in the ordered list',
  )
})

run('two tracks are two named bands in the one column', () => {
  const lanes = lanesOf('## Delivery\n- backlog/one.md\n\n## Mobile\n- backlog/done.md\n')
  const markup = render({ lanes })
  assert.match(markup, />Plan</, 'the head stops naming one track')
  assert.match(markup, />Delivery</)
  assert.match(markup, />Mobile</)
  assert.equal((markup.match(/aria-label="Plan"/g) ?? []).length, 1, 'still ONE column, never side-by-side')
})

run('a track offers Pause, and a parked one offers Resume instead — never both', () => {
  const paused: string[] = []
  const resumed: string[] = []
  const steering: HorizonSteering = {
    ...STEERING,
    pausedLanes: new Set(['Mobile']),
    onPause: (lane) => paused.push(lane),
    onResume: (lane) => resumed.push(lane),
  }
  const running = trackSteeringItems('Delivery', steering)
  assert.deepEqual(running.map((item) => item.label), ['Pause track'])
  running[0].onSelect()
  assert.deepEqual(paused, ['Delivery'])

  const parked = trackSteeringItems('Mobile', steering)
  assert.deepEqual(parked.map((item) => item.label), ['Resume track'])
  parked[0].onSelect()
  assert.deepEqual(resumed, ['Mobile'])
})

run('a track with a command in flight cannot fire it twice', () => {
  const items = trackSteeringItems('Delivery', { ...STEERING, busyLane: 'Delivery' })
  assert.equal(items[0].disabled, true)
})

run('an empty plan says what a track is instead of showing a blank column', () => {
  const markup = render({ lanes: [] })
  assert.match(markup, /No tracks yet/)
  assert.match(markup, /run in order, one sprint at a time/)
})

if (failures > 0) {
  console.error(`\n${failures} render check(s) failed`)
  process.exit(1)
}
console.log('horizon plan column: all checks passed')
