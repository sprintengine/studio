import assert from 'node:assert/strict'

import { renderToStaticMarkup } from 'react-dom/server'

import {
  HorizonPlanColumn,
  nextCursorRef,
  trackSteeringItems,
  type HorizonSteering,
} from './HorizonPlanColumn'
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
  cursorRef = null,
  selectedHasRunStrip = false,
  showProjectTag = false,
  steering = STEERING,
}: {
  lanes: RoadmapLane[]
  boardLanes?: RoadmapBoardLane[]
  selectedRef?: string | null
  cursorRef?: string | null
  selectedHasRunStrip?: boolean
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
    // Live epic membership, as the surface resolves it from the scan (MC-2031).
    epicMembersByRef: new Map([['backlog/epics/ext.md', ['backlog/child-a.md', 'backlog/child-b.md']]]),
  })
  return renderToStaticMarkup(
    <HorizonPlanColumn
      plan={plan}
      lanes={lanes}
      selectedRef={selectedRef}
      cursorRef={cursorRef}
      selectedHasRunStrip={selectedHasRunStrip}
      onSelect={() => undefined}
      showProjectTag={showProjectTag}
      rosters={[]}
      policyRoster={undefined}
      onManageRosters={() => undefined}
      onLanes={() => undefined}
      onAddRef={() => undefined}
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

// Item 1993: the plan is a GROUP of the door's one context rail, not a column
// beside it. Each of these is what made it a third navigation column, and each
// would come back invisibly — a width, a dividing border, or a scrollport of its
// own that stops the rail scrolling as one list.
run('the plan is a rail group, not a column of its own', () => {
  const markup = render({ lanes: SIMPLE })
  assert.doesNotMatch(markup, /w-\[360px\]/, 'no width of its own — the rail column supplies it')
  assert.doesNotMatch(markup, /shrink-0 flex-col border-r/, 'no dividing border against a pane beside it')
  assert.doesNotMatch(
    markup,
    /min-h-0 flex-1 overflow-y-auto pb-2/,
    'no scrollport of its own: horizons above and steps below scroll as one rail',
  )
  assert.match(markup, /aria-label="Plan"/, 'it is still one labelled region')
})

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

run('selection is the neutral fill, with no left bar and no accent', () => {
  const markup = render({ lanes: SIMPLE, selectedRef: 'backlog/one.md' })
  assert.match(markup, /bg-\[color:var\(--bg-selected\)\]/)
  assert.doesNotMatch(markup, /border-l-2/)
  assert.doesNotMatch(markup, /bg-\[color:var\(--accent-primary-soft\)\]/)
  assert.match(markup, /aria-current="true"/)
})

run('an epic step carries its size in the trailing slot', () => {
  const lanes = lanesOf('## Delivery\n- backlog/epics/ext.md\n')
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
    render({ lanes, boardLanes, selectedRef: 'backlog/one.md', selectedHasRunStrip: true }),
    /Approve &amp; merge/,
    'the selected step’s detail pane is the louder home for it',
  )
  assert.match(
    render({ lanes, boardLanes, selectedRef: 'backlog/one.md', selectedHasRunStrip: false }),
    /Approve &amp; merge/,
    'but only when that pane actually mounted a run strip — otherwise this is the only way to merge',
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

// ── the keyboard cursor (MC-1925) ────────────────────────────────────────────

const ORDER = ['a', 'b', 'c']

run('j and k walk the cursor, and clamp at the ends rather than wrapping', () => {
  assert.equal(nextCursorRef(ORDER, 'a', null, 1), 'b')
  assert.equal(nextCursorRef(ORDER, 'b', null, -1), 'a')
  assert.equal(nextCursorRef(ORDER, 'c', null, 1), 'c', 'past the last step is not the first')
  assert.equal(nextCursorRef(ORDER, 'a', null, -1), 'a')
})

run('from no cursor, the keyboard picks up at the selection', () => {
  assert.equal(nextCursorRef(ORDER, null, 'c', 1), 'c', 'it continues where the pointer left off')
  assert.equal(nextCursorRef(ORDER, null, 'c', -1), 'c')
})

run('with nothing selected the cursor starts at the top; an empty plan has none', () => {
  assert.equal(nextCursorRef(ORDER, null, null, 1), 'a')
  assert.equal(nextCursorRef([], null, null, 1), null)
})

run('a cursor on a step that has left the plan falls back to the selection', () => {
  assert.equal(nextCursorRef(ORDER, 'gone', 'b', 1), 'b')
})

run('the cursor is a focus ring, drawn distinct from selection', () => {
  const markup = render({ lanes: SIMPLE, cursorRef: 'backlog/one.md' })
  assert.match(markup, /ring-2 ring-inset/)
})

run('rows are focusable targets the cursor can land on', () => {
  assert.match(render({ lanes: SIMPLE }), /data-step-row="true"/)
})

// ── MC-2099: the plan column sits on the rail's grid, and owns no scroll ─────
// The plan shares a column with the horizons rail above it but shared none of
// its geometry: an 8px group header against the rail's 18px, full-bleed hover
// fills against inset ones, and a title 9px further right because of a drag
// handle that occupied a column of its own. Each of those reads as "these two
// lists are unrelated" in a column that is supposed to be one rail.

run('step rows land on the rail grid: 8px row inset, 8px gap, one 16px icon slot', () => {
  const markup = render({ lanes: SIMPLE })
  const rowClasses = markup.match(/data-step-row="true"[^>]*class="([^"]*)"/)?.[1] ?? ''
  assert.ok(rowClasses, 'a step row renders')
  assert.match(rowClasses, /(?:^|\s)px-2(?:\s|$)/, 'row padding is 8px, as the rail rows use')
  assert.match(rowClasses, /(?:^|\s)gap-2(?:\s|$)/, 'and the icon-to-title gap is 8px')
  assert.ok(
    !/(?:^|\s)pl-1\.5(?:\s|$)/.test(rowClasses),
    'the 6px left padding that paired with a dedicated handle column is gone',
  )
  assert.match(rowClasses, /(?:^|\s)rounded-md(?:\s|$)/, 'and the fill is rounded like every sibling row')
  // 4 (scrollport) + 8 (row padding) + 16 (icon slot) + 8 (gap) = the rail's
  // own 36px text edge, which is the whole point of the three assertions above.
  assert.equal(4 + 8 + 16 + 8, 36)
})

run('the drag handle shares the state glyph slot instead of adding a column', () => {
  const markup = render({ lanes: SIMPLE })
  assert.ok(
    !markup.includes('w-[11px]'),
    'no 11px handle column — it pushed the title off the rail grid and bought nothing, since the whole row is draggable',
  )
  assert.match(markup, /size-icon-sm/, 'the row leads with the shared 16px icon slot')
  assert.match(
    markup,
    /group-hover\/step:opacity-0/,
    'the state glyph fades on hover so the grip can take the same slot (the app sidebar folder-row idiom)',
  )
})

run('the delivered fold adds no second scrollport', () => {
  const markup = render({
    lanes: lanesOf('## Delivery\n- backlog/done.md\n- backlog/one.md\n'),
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
  assert.ok(
    !markup.includes('max-h-[40vh]'),
    'delivered steps scroll with the column that owns them, not in a capped region of their own',
  )
  assert.ok(
    !/class="[^"]*overflow-y-auto[^"]*"/.test(markup),
    'and the plan column declares no scrollport at all — the rail it is rendered into owns the one scroll region',
  )
})

run('the steering notice is the kit advisory, not a hand-rolled card', () => {
  const markup = render({
    lanes: lanesOf('## Delivery\n- backlog/one.md\n'),
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
  assert.ok(
    !markup.includes('border-l-2'),
    'the bespoke left-bar warn card is gone — InlineNotice already carries this shape',
  )
  assert.match(
    markup,
    /the saved roster “opus” was not found/,
    'and the reason still renders inline — MC-1909: a pause you cannot act on must say WHY where it can be seen, so the detail rides `hint`, never `detail` behind a "Show details" disclosure',
  )
  assert.match(markup, />Resume</, 'the one action survives the swap')
})

if (failures > 0) {
  console.error(`\n${failures} render check(s) failed`)
  process.exit(1)
}
console.log('horizon plan column: all checks passed')
