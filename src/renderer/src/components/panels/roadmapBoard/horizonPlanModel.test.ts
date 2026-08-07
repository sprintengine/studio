import assert from 'node:assert/strict'

import {
  buildHorizonPlan,
  horizonStepTeamKind,
  type HorizonPlanInput,
  type HorizonRefDisplay,
} from './horizonPlanModel'
import { parseRoadmap, type RoadmapLane } from '../../../../../shared/backlog/roadmap'
import type { RoadmapBoardLane, RoadmapBoardUnit } from '../../../../../shared/sprintengine/roadmap-surface'

// The plan column's band rules (MC-1924). These are the decisions the surface is
// judged on — what `Now` holds, what falls out of the ordered list into
// `Delivered`, which step owns a track's attention, and what a row's trailing
// slot says — so they are proved here, without a DOM, rather than inferred from
// the rendering.

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

function lanesOf(body: string): RoadmapLane[] {
  return parseRoadmap(`---\ntype: roadmap\n---\n${body}`).lanes
}

function unit(overrides: Partial<RoadmapBoardUnit> = {}): RoadmapBoardUnit {
  return {
    ref: 'backlog/one.md',
    slug: 'one',
    kind: 'item',
    title: 'One',
    state: 'queued',
    projectKey: null,
    projectName: 'multicode',
    ...overrides,
  }
}

function boardLane(lane: string, units: RoadmapBoardUnit[], overrides: Partial<RoadmapBoardLane> = {}): RoadmapBoardLane {
  return {
    lane,
    units,
    doneCount: units.filter((u) => u.state === 'done').length,
    total: units.length,
    reason: 'eligible',
    attention: 'none',
    ...overrides,
  }
}

const DISPLAY = new Map<string, HorizonRefDisplay>([
  ['backlog/one.md', { title: 'One' }],
  ['backlog/two.md', { title: 'Two' }],
  ['backlog/three.md', { title: 'Three' }],
  ['backlog/epics/auth.md', { title: 'Auth' }],
  ['backlog/auth-login.md', { title: 'Login', status: 'completed' }],
  ['backlog/auth-logout.md', { title: 'Logout', status: 'ready' }],
])

// Live epic membership, as the host resolves it from the scan (MC-2031) — the
// plan text carries none.
const EPIC_MEMBERS = new Map<string, string[]>([
  ['backlog/epics/auth.md', ['backlog/auth-login.md', 'backlog/auth-logout.md']],
])

function input(overrides: Partial<HorizonPlanInput> = {}): HorizonPlanInput {
  return {
    lanes: [],
    boardLanes: [],
    refDisplay: DISPLAY,
    projectNameByKey: new Map([[null, 'multicode']]),
    policyRoster: undefined,
    epicMembersByRef: EPIC_MEMBERS,
    knownRosterNames: new Set(['no roles', 'balanced four']),
    defaultRosterLabel: 'No roles',
    ...overrides,
  }
}

// ── the head + the bands ─────────────────────────────────────────────────────

run('a single track names itself in the head, and Now holds only the running step', () => {
  const lanes = lanesOf('## Delivery\n- backlog/one.md\n- backlog/two.md\n- backlog/three.md\n')
  const plan = buildHorizonPlan(
    input({
      lanes,
      boardLanes: [
        boardLane('Delivery', [
          unit({ ref: 'backlog/one.md', title: 'One', state: 'done' }),
          unit({ ref: 'backlog/two.md', title: 'Two', state: 'running' }),
          unit({ ref: 'backlog/three.md', title: 'Three', state: 'queued' }),
        ]),
      ],
    }),
  )
  assert.equal(plan.headTitle, 'Delivery')
  const now = plan.bands.find((band) => band.kind === 'now')
  assert.ok(now, 'a running step earns the Now band')
  assert.deepEqual(now.rows.map((row) => row.title), ['Two'])
  assert.equal(now.label, 'Now')
  const rest = plan.bands.find((band) => band.kind === 'rest')
  assert.ok(rest)
  assert.equal(rest.label, undefined, 'the ordered remainder is unlabelled — order says "next"')
  assert.deepEqual(rest.rows.map((row) => row.title), ['Three'])
})

run('a delivered step leaves the list for the Delivered footer, with its count', () => {
  const lanes = lanesOf('## Delivery\n- backlog/one.md\n- backlog/epics/auth.md\n- backlog/two.md\n')
  const plan = buildHorizonPlan(
    input({
      lanes,
      boardLanes: [
        boardLane('Delivery', [
          unit({ ref: 'backlog/one.md', title: 'One', state: 'done' }),
          unit({
            ref: 'backlog/epics/auth.md',
            title: 'Auth',
            kind: 'epic',
            state: 'done',
            children: [
              { ref: 'backlog/auth-login.md', title: 'Login', status: 'completed', done: true },
              { ref: 'backlog/auth-logout.md', title: 'Logout', status: 'completed', done: true },
            ],
          }),
          unit({ ref: 'backlog/two.md', title: 'Two', state: 'up_next' }),
        ]),
      ],
    }),
  )
  assert.equal(plan.delivered.steps, 2)
  // One loose item + a two-member epic = three backlog items delivered.
  assert.equal(plan.delivered.items, 3)
  const open = plan.bands.flatMap((band) => band.rows.map((row) => row.title))
  assert.deepEqual(open, ['Two'], 'delivered steps never sit in the ordered list too')
})

run('no running step means no Now band at all', () => {
  const lanes = lanesOf('## Delivery\n- backlog/one.md\n')
  const plan = buildHorizonPlan(input({ lanes }))
  assert.equal(plan.bands.filter((band) => band.kind === 'now').length, 0)
  assert.deepEqual(plan.bands.map((band) => band.kind), ['rest'])
})

run('two tracks become two named bands in the ONE column, each with its own count', () => {
  const lanes = lanesOf('## Delivery\n- backlog/one.md\n\n## Mobile\n- backlog/two.md\n- backlog/three.md\n')
  const plan = buildHorizonPlan(
    input({
      lanes,
      boardLanes: [
        boardLane('Delivery', [unit({ ref: 'backlog/one.md', title: 'One', state: 'running' })], {
          doneCount: 2,
          total: 4,
        }),
        boardLane('Mobile', [
          unit({ ref: 'backlog/two.md', title: 'Two', state: 'running' }),
          unit({ ref: 'backlog/three.md', title: 'Three', state: 'queued' }),
        ], { doneCount: 1, total: 3 }),
      ],
    }),
  )
  assert.equal(plan.headTitle, 'Plan', 'the head stops naming one track when there are two')
  assert.deepEqual(plan.bands.map((band) => band.kind), ['track', 'track'])
  assert.deepEqual(plan.bands.map((band) => band.label), ['Delivery', 'Mobile'])
  assert.deepEqual(plan.bands.map((band) => band.count), ['2/4', '1/3'])
  assert.equal(
    plan.bands.filter((band) => band.kind === 'now').length,
    0,
    'each track band leads with its own running step — a global Now would lie',
  )
})

// ── the row ──────────────────────────────────────────────────────────────────

run('the trailing slot carries step SIZE: done/total once anything landed, else the total', () => {
  const lanes = lanesOf('## Delivery\n- backlog/epics/auth.md\n- backlog/one.md\n')
  const plan = buildHorizonPlan(
    input({
      lanes,
      boardLanes: [
        boardLane('Delivery', [
          unit({
            ref: 'backlog/epics/auth.md',
            kind: 'epic',
            title: 'Auth',
            state: 'running',
            children: [
              { ref: 'backlog/auth-login.md', title: 'Login', status: 'completed', done: true },
              { ref: 'backlog/auth-logout.md', title: 'Logout', status: 'ready', done: false },
            ],
          }),
          unit({ ref: 'backlog/one.md', title: 'One', state: 'queued' }),
        ]),
      ],
    }),
  )
  const rows = plan.bands.flatMap((band) => band.rows)
  assert.equal(rows.find((row) => row.title === 'Auth')?.sizeLabel, '1/2')
  assert.equal(rows.find((row) => row.title === 'One')?.sizeLabel, undefined, 'an item is its own size')
})

run('an epic with nothing delivered shows a bare total', () => {
  const lanes = lanesOf('## Delivery\n- backlog/epics/auth.md\n')
  const plan = buildHorizonPlan(
    input({ lanes, epicMembersByRef: new Map([['backlog/epics/auth.md', ['backlog/auth-logout.md']]]) }),
  )
  assert.equal(plan.bands.flatMap((b) => b.rows)[0].sizeLabel, '1')
})

run('a step with no runtime yet sizes from live membership + the display map', () => {
  // A just-dropped epic: the board has not caught up, so there is no unit.
  const lanes = lanesOf('## Delivery\n- backlog/epics/auth.md\n')
  const plan = buildHorizonPlan(input({ lanes, boardLanes: [] }))
  const row = plan.bands.flatMap((band) => band.rows)[0]
  assert.equal(row.title, 'Auth')
  assert.equal(row.state, 'queued', 'no runtime is queued, never a phantom running step')
  assert.equal(row.sizeLabel, '1/2', 'login is completed in the scan, so the size reads 1 of 2')
})

run('roster resolves through the shared function: inherit is quiet, an override is marked', () => {
  const lanes = lanesOf('## Delivery\n- backlog/one.md\n- backlog/two.md @roster=Balanced four\n- backlog/three.md @roster=opus\n')
  const plan = buildHorizonPlan(input({ lanes, policyRoster: 'Balanced four' }))
  const rows = plan.bands.flatMap((band) => band.rows)
  assert.deepEqual(rows.map((row) => row.roster), [
    { label: 'Balanced four', overridden: false, missing: false },
    { label: 'Balanced four', overridden: true, missing: false },
    { label: 'opus', overridden: true, missing: true },
  ])
})

run('an unset roster reads as the default and is never "not found"', () => {
  const plan = buildHorizonPlan(input({ lanes: lanesOf('## Delivery\n- backlog/one.md\n') }))
  assert.deepEqual(plan.bands.flatMap((b) => b.rows)[0].roster, {
    label: 'No roles',
    overridden: false,
    missing: false,
  })
})

// ── attention lands on the work ──────────────────────────────────────────────

run('a park hangs its real reason on the step it happened to, with one action', () => {
  const lanes = lanesOf('## Delivery\n- backlog/one.md\n- backlog/two.md\n')
  const plan = buildHorizonPlan(
    input({
      lanes,
      boardLanes: [
        boardLane(
          'Delivery',
          [
            unit({ ref: 'backlog/one.md', title: 'One', state: 'done' }),
            unit({ ref: 'backlog/two.md', title: 'Two', state: 'paused' }),
          ],
          {
            attention: 'paused',
            parked: {
              reason: 'start_failed',
              itemRef: 'backlog/two.md',
              at: '2026-07-27T00:00:00Z',
              detail: 'roster "opus" was not found',
            },
          },
        ),
      ],
    }),
  )
  const rows = plan.bands.flatMap((band) => band.rows)
  const paused = rows.find((row) => row.title === 'Two')
  assert.deepEqual(paused?.notice, {
    kind: 'paused',
    message: 'No sprint was created. Resuming tries the start again.',
    detail: 'roster "opus" was not found',
    actionLabel: 'Resume',
  })
  assert.equal(rows.filter((row) => row.notice).length, 1, 'exactly one step owns the track’s attention')
})

run('a park whose ref matches nothing still surfaces on the first open step', () => {
  const lanes = lanesOf('## Delivery\n- backlog/one.md\n')
  const plan = buildHorizonPlan(
    input({
      lanes,
      boardLanes: [
        boardLane('Delivery', [unit({ ref: 'backlog/one.md', title: 'One', state: 'up_next' })], {
          attention: 'paused',
          parked: { reason: 'merge_failed', itemRef: 'backlog/gone.md', at: '2026-07-27T00:00:00Z' },
        }),
      ],
    }),
  )
  assert.equal(plan.bands.flatMap((b) => b.rows)[0].notice?.kind, 'paused')
})

run('you-paused-it says so without telling you to resume twice', () => {
  const lanes = lanesOf('## Delivery\n- backlog/one.md\n')
  const plan = buildHorizonPlan(
    input({
      lanes,
      boardLanes: [
        boardLane('Delivery', [unit({ ref: 'backlog/one.md', state: 'paused' })], {
          attention: 'paused',
          parked: { reason: 'paused', itemRef: 'backlog/one.md', at: '2026-07-27T00:00:00Z' },
        }),
      ],
    }),
  )
  assert.equal(plan.bands.flatMap((b) => b.rows)[0].notice?.message, 'You paused this track.')
})

run('an outstanding approval marks the step it would start ready — never a warn notice', () => {
  const lanes = lanesOf('## Delivery\n- backlog/one.md\n- backlog/two.md\n')
  const plan = buildHorizonPlan(
    input({
      lanes,
      boardLanes: [
        boardLane(
          'Delivery',
          [
            unit({ ref: 'backlog/one.md', title: 'One', state: 'done' }),
            unit({ ref: 'backlog/two.md', title: 'Two', state: 'up_next' }),
          ],
          { attention: 'approval', pendingApprovalRef: 'backlog/two.md' },
        ),
      ],
    }),
  )
  const rows = plan.bands.flatMap((band) => band.rows)
  const two = rows.find((row) => row.title === 'Two')
  assert.equal(two?.ready, true, 'the pending step reads ready')
  assert.equal(two?.notice, undefined, 'waiting for a go-ahead is a healthy state, not an advisory')
  assert.ok(
    rows.every((row) => row.title === 'Two' || !row.ready),
    'exactly one step is the one the horizon would start',
  )
})

run('a delivered-but-unmerged step carries the merge action', () => {
  const lanes = lanesOf('## Delivery\n- backlog/one.md\n')
  const plan = buildHorizonPlan(
    input({
      lanes,
      boardLanes: [
        boardLane('Delivery', [unit({ ref: 'backlog/one.md', title: 'One', state: 'running' })], {
          attention: 'merge',
          activeItemRef: 'backlog/one.md',
        }),
      ],
    }),
  )
  assert.equal(plan.bands.flatMap((b) => b.rows)[0].notice?.actionLabel, 'Approve & merge')
})

run('a fully delivered track raises no notice on a delivered row', () => {
  const lanes = lanesOf('## Delivery\n- backlog/one.md\n')
  const plan = buildHorizonPlan(
    input({
      lanes,
      boardLanes: [
        boardLane('Delivery', [unit({ ref: 'backlog/one.md', state: 'done' })], {
          attention: 'merge',
          activeItemRef: 'backlog/one.md',
        }),
      ],
    }),
  )
  assert.equal(plan.delivered.rows[0].notice, undefined)
  assert.equal(plan.bands.flatMap((b) => b.rows).length, 0)
})

// ── cross-project ────────────────────────────────────────────────────────────

run('a cross-project step keeps its own project name for the tag', () => {
  const lanes = parseRoadmap(
    ['---', 'type: roadmap', 'projects:', '  mobile: /repo/mobile', '---', '## Delivery', '- mobile:backlog/two.md', ''].join('\n'),
  ).lanes
  const plan = buildHorizonPlan(
    input({ lanes, projectNameByKey: new Map([[null, 'multicode'], ['mobile', 'multicode-mobile']]) }),
  )
  assert.equal(plan.bands.flatMap((b) => b.rows)[0].projectName, 'multicode-mobile')
})

// ── an empty plan ────────────────────────────────────────────────────────────

run('an empty track still emits its ordered band, so a drop has somewhere to land', () => {
  const plan = buildHorizonPlan(input({ lanes: lanesOf('## Up next\n') }))
  assert.equal(plan.headTitle, 'Up next')
  assert.deepEqual(plan.bands.map((band) => band.kind), ['rest'])
  assert.deepEqual(plan.bands[0].rows, [])
  assert.equal(plan.delivered.steps, 0)
})

run('a plan with no tracks at all has a head fallback and nothing else', () => {
  const plan = buildHorizonPlan(input({ lanes: [] }))
  assert.equal(plan.headTitle, 'Plan')
  assert.deepEqual(plan.bands, [])
})

run('a ref that resolves to nothing is marked, never rendered as ordinary work', () => {
  const lanes = lanesOf('## Delivery\n- backlog/ghost.md\n- backlog/one.md\n')
  const rows = buildHorizonPlan(input({ lanes })).bands.flatMap((band) => band.rows)
  assert.equal(rows.find((row) => row.ref === 'backlog/ghost.md')?.unresolved, true)
  assert.equal(rows.find((row) => row.ref === 'backlog/one.md')?.unresolved, false)
})

run('a step the board resolved is never marked unresolved, even mid-edit', () => {
  const lanes = lanesOf('## Delivery\n- backlog/one.md\n')
  const plan = buildHorizonPlan(
    input({
      lanes,
      refDisplay: new Map(),
      boardLanes: [boardLane('Delivery', [unit({ ref: 'backlog/one.md', title: 'One', itemStatus: 'ready' })])],
    }),
  )
  assert.equal(plan.bands.flatMap((b) => b.rows)[0].unresolved, false)
})

run('a step in a project this Multicode cannot read is unreadable, not stale', () => {
  const lanes = parseRoadmap(
    ['---', 'type: roadmap', 'projects:', '  mobile: /repo/mobile', '---', '## Delivery', '- mobile:backlog/x.md', ''].join('\n'),
  ).lanes
  // The library scanned only the home project, so there is no display entry —
  // but the file is probably fine and telling the author to delete it is wrong.
  const plan = buildHorizonPlan(input({ lanes, resolvableProjects: new Set([null]) }))
  const row = plan.bands.flatMap((band) => band.rows)[0]
  assert.equal(row.projectUnavailable, true)
  assert.equal(row.unresolved, false, 'a project we cannot read says nothing about the file')
})

run('a stale ref in a project we CAN read is still marked stale', () => {
  const plan = buildHorizonPlan(
    input({ lanes: lanesOf('## Delivery\n- backlog/ghost.md\n'), resolvableProjects: new Set([null]) }),
  )
  const row = plan.bands.flatMap((band) => band.rows)[0]
  assert.equal(row.unresolved, true)
  assert.equal(row.projectUnavailable, false)
})

run('a track stalled on a prerequisite says so, with no button it cannot honour', () => {
  const lanes = lanesOf('## Delivery\n- backlog/one.md\n')
  const plan = buildHorizonPlan(
    input({
      lanes,
      boardLanes: [
        boardLane('Delivery', [unit({ ref: 'backlog/one.md', state: 'up_next' })], {
          reason: 'blocked',
          attention: 'none',
        }),
      ],
    }),
  )
  const notice = plan.bands.flatMap((band) => band.rows)[0].notice
  assert.equal(notice?.kind, 'blocked')
  assert.match(notice?.message ?? '', /waiting on work it depends on/)
  assert.equal(notice?.actionLabel, undefined, 'the fix is in the backlog, not a button here')
})

run('an ordinary eligible track raises no notice at all', () => {
  const lanes = lanesOf('## Delivery\n- backlog/one.md\n')
  const plan = buildHorizonPlan(
    input({ lanes, boardLanes: [boardLane('Delivery', [unit({ ref: 'backlog/one.md', state: 'up_next' })])] }),
  )
  assert.equal(plan.bands.flatMap((band) => band.rows)[0].notice, undefined)
})

// MC-2066 — which shape the step's team band takes. The order is the whole
// point: a name that resolves to no saved roster is MISSING first, so the band
// says the step cannot start instead of describing the plain-agent default the
// step would never actually get.
run('the team band reads missing before anything else, and never falls back', () => {
  assert.equal(
    horizonStepTeamKind({ label: 'Opus', overridden: true, missing: true }, false),
    'missing',
  )
  assert.equal(
    // Even if something upstream claimed it resolves, missing wins.
    horizonStepTeamKind({ label: 'Opus', overridden: true, missing: true }, true),
    'missing',
  )
})

run('no roles is the plain-agent shape; a saved roster carries the agents', () => {
  assert.equal(
    horizonStepTeamKind({ label: 'No roles', overridden: false, missing: false }, false),
    'plain_agents',
  )
  assert.equal(
    horizonStepTeamKind({ label: 'Mobile UI', overridden: true, missing: false }, true),
    'roster',
  )
  // Inheritance is orthogonal: an inherited roster is still a roster, and an
  // overridden "No roles" is still plain agents.
  assert.equal(
    horizonStepTeamKind({ label: 'Mobile UI', overridden: false, missing: false }, true),
    'roster',
  )
  assert.equal(
    horizonStepTeamKind({ label: 'No roles', overridden: true, missing: false }, false),
    'plain_agents',
  )
})

if (failures > 0) {
  console.error(`${failures} test(s) failed`)
  process.exit(1)
}
console.log('horizon plan model: all tests passed')
