import assert from 'node:assert/strict'

import { renderToStaticMarkup } from 'react-dom/server'

import {
  HorizonPlanColumn,
  nextCursorRef,
  sizeCountLabel,
  sizeTooltip,
  trackSteeringItems,
  type HorizonSteering,
} from './HorizonPlanColumn'
import { buildHorizonPlan, type HorizonRefDisplay } from './horizonPlanModel'
import { parseRoadmap, type RoadmapLane } from '../../../../../shared/backlog/roadmap'
import type { RoadmapBoardLane, RoadmapBoardUnit } from '../../../../../shared/sprintengine/roadmap-surface'
import type { SprintEngineRoster } from '../../../types/workspace'

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
  showProjectTag = false,
  steering = STEERING,
  policyRoster,
  knownRosterNames = new Set(['no roles']),
  rosters = [],
}: {
  lanes: RoadmapLane[]
  boardLanes?: RoadmapBoardLane[]
  selectedRef?: string | null
  cursorRef?: string | null
  showProjectTag?: boolean
  steering?: HorizonSteering
  policyRoster?: string
  knownRosterNames?: Set<string>
  /** The user's saved rosters — the menu resolves a name against these. */
  rosters?: SprintEngineRoster[]
}): string {
  const plan = buildHorizonPlan({
    lanes,
    boardLanes,
    refDisplay: DISPLAY,
    projectNameByKey: new Map([[null, 'multicode'], ['mobile', 'multicode-mobile']]),
    policyRoster,
    knownRosterNames,
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
      onSelect={() => undefined}
      showProjectTag={showProjectTag}
      rosters={rosters}
      policyRoster={policyRoster}
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

run('a row is two lines: id + clamped title, then the meta line — no status word', () => {
  const markup = render({
    lanes: SIMPLE,
    boardLanes: [
      { lane: 'Delivery', units: [unit({ state: 'up_next' })], doneCount: 0, total: 1, reason: 'eligible', attention: 'none' },
    ],
  })
  const rowClasses = markup.match(/data-step-row="true"[^>]*class="([^"]*)"/)?.[1] ?? ''
  assert.ok(!/h-\[26px\]/.test(rowClasses), 'the fixed one-line height is gone — it truncated every title to a stub')
  assert.match(markup, /Terminal links open a chooser/)
  assert.match(markup, /MC-1899/, 'the id leads the title — a step must be recognizable without clicking it')
  assert.match(markup, /line-clamp-2/, 'the title clamps at two lines instead of truncating at one')
  assert.match(markup, /aria-label="MC-1899: Terminal links open a chooser"/, 'identifier and title in one accessible name')
  assert.doesNotMatch(markup, />Up next</, 'the glyph already says the state')
  assert.doesNotMatch(markup, />Queued</)
})

// MC-2066 — the team is a first-class choice ON the step. This deliberately
// reverses MC-1924's density call for this ONE control: the thing that decides
// who does the work used to be `opacity-0` until you hovered the row, so the
// only comfortable way to staff anything was the horizon's default in the top
// bar. Reading it must never again require pointing at the row.
run('the team rests on every step, never hover-revealed', () => {
  const markup = render({ lanes: SIMPLE })
  // The chip's OWN class list, not the row's: the drag grip and the delivered
  // row's PR link are hover-revealed on purpose, so a document-wide search for
  // `opacity-0` would pass or fail for reasons that have nothing to do with the
  // team.
  const chipClass = /aria-label="Team for [^"]*"\s+class="([^"]*)"/.exec(markup)?.[1]
  assert.ok(chipClass, 'the step carries a team chip at all')
  assert.doesNotMatch(chipClass, /opacity-0/, 'the inherited chip is no longer hidden until hover')
  assert.doesNotMatch(chipClass, /group-hover\/step:/, 'and nothing about it waits on a hover')
  assert.match(
    markup,
    // The built-in reads "Just an agent" (MC-2145): a label describing what the
    // choice ISN'T was the owner's exact complaint. The stored name stays
    // "No roles" for frontmatter back-compat; only the presentation changed.
    /aria-label="Team for Terminal links open a chooser: Just an agent \(inherited from this horizon\)"/,
    'and it names both the team and where the choice came from',
  )
})

// The trap MC-1881 wrote into RosterMenu and MC-2066 must not undo: the tone is
// `inherit.selected` — the ABSENCE of a `@roster=` — never the label. A step that
// deliberately picks the roster the horizon already uses is an OVERRIDE, and it
// would go quiet the moment either side derived the tier from the name.
run('a step that picks the horizon’s own roster still reads as its own choice', () => {
  const known = new Set(['no roles', 'mobile ui'])
  const saved: SprintEngineRoster[] = [
    { id: 'r1', name: 'Mobile UI', roleCounts: { frontend: 1 }, roleCliDefaults: {}, createdAt: 0, updatedAt: 0 },
  ]
  const inherited = render({
    lanes: lanesOf('## Delivery\n- backlog/one.md\n'),
    policyRoster: 'Mobile UI',
    knownRosterNames: known,
    rosters: saved,
  })
  const overridden = render({
    lanes: lanesOf('## Delivery\n- backlog/one.md @roster=Mobile UI\n'),
    policyRoster: 'Mobile UI',
    knownRosterNames: known,
    rosters: saved,
  })
  assert.match(inherited, /: Mobile UI \(inherited from this horizon\)"/)
  assert.match(overridden, /: Mobile UI \(set for this step\)"/)
  // …and the two look different without a screen reader: the override is a
  // bordered chip, the inherited one plain quiet text.
  assert.match(overridden, /border border-\[color:var\(--border-subtle\)\][^"]*text-\[color:var\(--text-default\)\]/)
})

run('a roster that no longer exists stays loud on the row, and is never softened to the default', () => {
  const markup = render({
    lanes: lanesOf('## Delivery\n- backlog/one.md @roster=Opus\n'),
    knownRosterNames: new Set(['no roles']),
  })
  assert.match(markup, /Opus/, 'the step keeps the name it was given')
  assert.match(markup, /\(not found\)/, 'and says it does not resolve')
  assert.match(markup, /tone-warn/, 'in the warn tone, at rest')
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

run('an epic step counts its children on the meta line, with the unit spelled out', () => {
  const lanes = lanesOf('## Delivery\n- backlog/epics/ext.md\n')
  const markup = render({ lanes })
  assert.match(markup, /Extensions: doors become installable modules/)
  assert.match(markup, /1\/2 items/, 'one of two members has landed — never a bare number with no unit')
})

run('the size count explains itself for the pointer', () => {
  assert.equal(sizeTooltip('5'), '5 child items in this epic')
  assert.equal(sizeTooltip('1'), '1 child item in this epic')
  assert.equal(sizeTooltip('1/2'), '1 of 2 child items delivered')
})

run('the count carries its unit, singular included', () => {
  assert.equal(sizeCountLabel('5'), '5 items')
  assert.equal(sizeCountLabel('1'), '1 item')
  assert.equal(sizeCountLabel('1/2'), '1/2 items')
})

// The MC-2148 UX pass: waiting for a go-ahead is a healthy state. The rail says
// so with a quiet accent chip; the action itself lives on the detail header.
run('a pending approval is a Ready chip in the accent — never a warn card with a buried button', () => {
  const markup = render({
    lanes: lanesOf('## Delivery\n- backlog/one.md\n'),
    boardLanes: [
      {
        lane: 'Delivery',
        units: [unit({ state: 'up_next' })],
        doneCount: 0,
        total: 1,
        reason: 'eligible',
        attention: 'approval',
        pendingApprovalRef: 'backlog/one.md',
      },
    ],
  })
  assert.match(markup, />Ready</, 'the row says which step the horizon would start')
  // The kit's label badge in the accent tone (`--tone-accent-soft` fill, the
  // lifecycle vocabulary's own "ready" hue), with no dot inside it — the pill
  // and a dot said the same thing twice (2026-09-02 audit).
  assert.match(markup, /tone-accent-soft/, 'in the accent — this is good news')
  assert.doesNotMatch(markup, /accent-primary-soft-strong/, 'the accent as a tone, not as a hand-mixed fill')
  assert.doesNotMatch(markup, /size-\[5px\]/, 'no dot beside the word that already carries the state')
  assert.doesNotMatch(markup, /tone-warn/, 'never the warn tone')
  assert.doesNotMatch(markup, /This step is ready/, 'no advisory card for a healthy state')
  assert.doesNotMatch(markup, /Start next|Start sprint/, 'the start action is the detail header’s, not the rail’s')
  assert.match(markup, /ready to start/, 'and the accessible name carries the state')
})

run('a parked track is a one-word Paused label — no prose and no button in the rail', () => {
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
  assert.match(markup, />Paused</, 'the row flags the state at Ready-chip volume')
  assert.match(markup, /, paused"/, 'and the accessible name carries it')
  assert.doesNotMatch(
    markup,
    /No sprint was created/,
    'the reason is the detail header’s, not sidebar prose — the rail states, the detail explains and acts',
  )
  assert.ok(!markup.includes('>Resume<'), 'and no action button in a navigation rail')
})

run('a waiting merge is a one-word label, never actioned from the rail', () => {
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
  const markup = render({ lanes, boardLanes })
  assert.match(markup, />PR waiting</, 'the row flags the state')
  assert.doesNotMatch(markup, /Its pull request is waiting on you/, 'without the prose')
  assert.doesNotMatch(markup, /Approve &amp; merge/, 'the action is the detail pane’s, selected or not')
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

// Cursor ≠ focus (2026-09-02 audit), but the cursor is not a FILL either: the
// hover fill is already on any row under the pointer, and a selected row already
// wears the selection fill, so a fill-only cursor is invisible in both states —
// which is most of them. The cursor takes its own channel, the kit's leading
// rule (LIST_CURSOR_MARK_CLASS), which composes with either fill; the product's
// one focus ring still marks DOM focus alone.
run('the cursor is a leading mark, drawn distinct from selection, hover and focus', () => {
  const markup = render({ lanes: SIMPLE, cursorRef: 'backlog/one.md' })
  assert.match(markup, /bg-\[color:var\(--text-strong\)\]/, 'the cursored row carries the leading cursor rule')
  assert.doesNotMatch(markup, /ring-2|ring-inset/, 'no second focus idiom beside the shared ring')
  assert.match(markup, /data-step-row="true"[^>]*focus-visible:focus-ring/, 'the shared ring stays on the row')
  // The cursor never rides a fill, so a cursored row is not painted like a
  // hovered one, and a cursored+selected row still shows its cursor.
  const cursoredRow = markup.match(/data-step-row="true"[^>]*class="([^"]*)"/)?.[1] ?? ''
  assert.ok(cursoredRow, 'a step row renders')
  assert.ok(
    !/(?:^|\s)bg-\[color:var\(--bg-hover\)\](?:\s|$)/.test(cursoredRow),
    'the cursor does not paint the resting hover fill onto the row',
  )
  assert.match(cursoredRow, /hover:bg-\[color:var\(--bg-hover\)\]/, 'and hover stays the pointer’s own signal')
})

run('a cursored row that is also selected keeps both the selection fill and the cursor', () => {
  const markup = render({ lanes: SIMPLE, cursorRef: 'backlog/one.md', selectedRef: 'backlog/one.md' })
  assert.match(markup, /data-step-row="true"[^>]*bg-\[color:var\(--bg-selected\)\]/, 'the selection fill survives')
  assert.match(markup, /bg-\[color:var\(--text-strong\)\]/, 'and the cursor is still visible on it')
})

run('an uncursored row draws no cursor mark', () => {
  assert.doesNotMatch(
    render({ lanes: SIMPLE }),
    /bg-\[color:var\(--text-strong\)\]/,
    'the mark is earned by the cursor, not painted on every row',
  )
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

run('attention never renders card chrome or reason prose in the rail', () => {
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
  assert.ok(!markup.includes('border-l-2'), 'no bespoke left-bar card')
  assert.ok(
    !markup.includes('tone-warn-soft'),
    'no card at all: the InlineNotice advisory read as a broken-state error box at rail volume — attention is a one-word label with a warn dot',
  )
  assert.ok(
    !markup.includes('the saved roster “opus” was not found'),
    'the underlying reason belongs to the detail header (MC-1909 is met there, one click from this label), not to sidebar prose',
  )
})

if (failures > 0) {
  console.error(`\n${failures} render check(s) failed`)
  process.exit(1)
}
console.log('horizon plan column: all checks passed')
