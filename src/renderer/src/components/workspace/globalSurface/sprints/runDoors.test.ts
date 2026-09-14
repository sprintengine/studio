import assert from 'node:assert/strict'

import type { SprintEngineRoleCounts } from '../../../../types/workspace'
import type { SprintRunRuntimeState, SprintRunSummary } from '../../../../../../shared/sprintengine/runSummary'
import type { SprintEngineState } from '../../../../../../shared/sprintengine/run-types'
import { sprintEngineCoordinatorSeat } from '../../../../../../shared/sprintengine/state'
import {
  NO_ROLES_ROSTER_ID,
  sprintEngineLaunchRoleCounts,
} from '../../../../../../shared/sprintengine/saved-rosters'
import {
  partitionRunsByDoor,
  runBelongsToDoor,
  runDoorFor,
  runDoorForProjection,
  runDoorForRoleCounts,
  runsForDoor,
  RUN_DOOR_IDS,
  type RunDoorId,
} from './runDoors'

// The run partition's own suite (item 2470), written before either door existed.
//
// Two things have to hold, and the item's review focus names both. The first is
// that the rule reads the run's coordinator SEAT and never a role-name literal —
// asserted here by classifying a run whose seat is named something the app has
// never heard of, and a roleless run whose tasks are the ONLY place a role name
// could be read from. The second is exhaustiveness: no run may land in both
// doors or in neither, including the runs that predate the distinction, the ones
// that were cancelled, and the ones whose projection cannot be read at all.

function run(name: string, body: () => void): void {
  try {
    body()
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`not ok - ${name}`)
    throw error
  }
}

// A summary shaped like the run index emits, with only the fields a test cares
// about overridden.
function summary(overrides: Partial<SprintRunSummary> & { teamSlug: string }): SprintRunSummary {
  const projectRoot = overrides.projectRoot ?? '/work/multicode'
  return {
    statePath: `${projectRoot}/.sprintengine/sprintengine/${overrides.teamSlug}/run.yaml`,
    teamName: overrides.teamSlug,
    projectRoot,
    projectName: projectRoot.slice(projectRoot.lastIndexOf('/') + 1),
    runtimeState: 'idle',
    taskCounts: { total: 0, done: 0, inProgress: 0, waiting: 0 },
    repoRollup: { declared: 0, merged: 0, open: 0 },
    needsInputCount: 0,
    branchName: null,
    worktreePath: null,
    startedAt: null,
    updatedAt: null,
    finishedAt: null,
    sourceLabel: null,
    ...overrides,
  }
}

const RUNTIME_STATES: SprintRunRuntimeState[] = [
  'running',
  'needs_input',
  'completed',
  'canceled',
  'idle',
  'unknown',
]

// ── The rule ────────────────────────────────────────────────────────────────

run('a run whose coordinator seat is named lists under Workflows', () => {
  assert.equal(
    runDoorFor(summary({ teamSlug: 'plan-it', coordinatorSeat: { role: 'architect', agentId: 'architect' } })),
    'workflows',
  )
})

run('a run whose coordinator seat has no role lists under Sprints', () => {
  assert.equal(
    runDoorFor(summary({ teamSlug: 'work-it', coordinatorSeat: { agentId: 'coordinator' } })),
    'sprints',
  )
})

run('the rule reads the seat, never a role name', () => {
  // A seat named something no first-party registry ships still plans: the
  // question is whether the seat HAS a name, not what the name is. A rule
  // written as `role === 'architect' || role === 'general'` — the predicate epic
  // 2058 exists to delete — would drop this run into Sprints.
  assert.equal(
    runDoorFor(summary({ teamSlug: 'custom', coordinatorSeat: { role: 'lead-designer', agentId: 'lead-designer' } })),
    'workflows',
    'a seat named by a custom registry role is still a named seat',
  )
  // And the mirror: a roleless run whose TASKS carry role names is still a
  // sprint. Its seat is what decides, so no amount of role-shaped data on the
  // work can promote it into the door that promises an architect.
  assert.equal(
    runDoorFor(summary({ teamSlug: 'roleless-with-roled-tasks', coordinatorSeat: { agentId: 'coordinator' } })),
    'sprints',
  )
})

run('a role written as blank is an absent role, not a specialist', () => {
  for (const role of ['', '   ']) {
    assert.equal(
      runDoorFor(summary({ teamSlug: 'blank', coordinatorSeat: { role, agentId: 'coordinator' } })),
      'sprints',
      `a seat whose role is ${JSON.stringify(role)} is not named`,
    )
  }
})

// ── The runs that cannot say ────────────────────────────────────────────────

run('a run whose projection could not be read lands in Sprints, never nowhere', () => {
  const unreadable = summary({
    teamSlug: 'unreadable',
    runtimeState: 'unknown',
    coordinatorSeat: null,
    unknownReason: 'Run projection is malformed.',
  })
  assert.equal(runDoorFor(unreadable), 'sprints')
  assert.equal(runBelongsToDoor(unreadable, 'workflows'), false, 'never claimed by the door that promises planning')
})

run('a summary from a build that predates the seat field still lands in a door', () => {
  // `coordinatorSeat` is optional on the wire, so an index payload written by an
  // older build omits it entirely. That is the same "does not state its kind" as
  // an unreadable projection and takes the same door.
  const legacyPayload = summary({ teamSlug: 'older-build' })
  delete (legacyPayload as { coordinatorSeat?: unknown }).coordinatorSeat
  assert.equal(runDoorFor(legacyPayload), 'sprints')
})

// ── Exhaustiveness ──────────────────────────────────────────────────────────

run('every run lands in exactly one door, whatever its lifecycle or its seat', () => {
  const seats: Array<{ label: string; seat: SprintRunSummary['coordinatorSeat'] }> = [
    { label: 'named', seat: { role: 'architect', agentId: 'architect' } },
    { label: 'named-custom', seat: { role: 'lead-designer', agentId: 'lead-designer' } },
    { label: 'roleless', seat: { agentId: 'coordinator' } },
    { label: 'blank-role', seat: { role: '  ', agentId: 'coordinator' } },
    { label: 'unreadable', seat: null },
    { label: 'absent', seat: undefined },
  ]
  const runs = RUNTIME_STATES.flatMap((runtimeState) =>
    seats.map(({ label, seat }) =>
      summary({ teamSlug: `${label}-${runtimeState}`, runtimeState, coordinatorSeat: seat }),
    ),
  )

  const partition = partitionRunsByDoor(runs)
  const doors = Object.keys(partition) as RunDoorId[]
  assert.deepEqual(doors.slice().sort(), RUN_DOOR_IDS.slice().sort(), 'the partition has exactly the declared doors')

  // Exactly one: the two lists are disjoint, and together they are the input.
  const workflows = new Set(partition.workflows.map((entry) => entry.statePath))
  const sprints = new Set(partition.sprints.map((entry) => entry.statePath))
  for (const entry of runs) {
    const inWorkflows = workflows.has(entry.statePath)
    const inSprints = sprints.has(entry.statePath)
    assert.ok(inWorkflows || inSprints, `${entry.teamSlug} vanished — it is in neither door`)
    assert.ok(!(inWorkflows && inSprints), `${entry.teamSlug} is in both doors`)
  }
  assert.equal(
    partition.workflows.length + partition.sprints.length,
    runs.length,
    'no run is dropped and none is duplicated',
  )

  // A cancelled run is classified by kind exactly like a live one: cancellation
  // is a lifecycle, not a kind, so the same seat answers the same door.
  for (const { label } of seats) {
    const byState = RUNTIME_STATES.map((runtimeState) =>
      runDoorFor(runs.find((entry) => entry.teamSlug === `${label}-${runtimeState}`)!),
    )
    assert.equal(new Set(byState).size, 1, `${label} runs answer one door regardless of lifecycle`)
  }
})

run('the partition and the per-door filter are the same answer', () => {
  const runs = [
    summary({ teamSlug: 'a', coordinatorSeat: { role: 'architect', agentId: 'architect' } }),
    summary({ teamSlug: 'b', coordinatorSeat: { agentId: 'coordinator' } }),
    summary({ teamSlug: 'c', coordinatorSeat: null }),
    summary({ teamSlug: 'd', coordinatorSeat: { role: 'tester', agentId: 'tester' } }),
  ]
  const partition = partitionRunsByDoor(runs)
  for (const door of RUN_DOOR_IDS) {
    assert.deepEqual(
      runsForDoor(runs, door).map((entry) => entry.teamSlug),
      partition[door].map((entry) => entry.teamSlug),
      `${door} filters to the same rows it partitions to`,
    )
  }
  // Index order is preserved: the rail owns grouping and sort, not this module.
  assert.deepEqual(partition.workflows.map((entry) => entry.teamSlug), ['a', 'd'])
  assert.deepEqual(partition.sprints.map((entry) => entry.teamSlug), ['b', 'c'])
})

// ── The chain the app actually runs ─────────────────────────────────────────
//
// Everything above hands `runDoorFor` a seat directly, which tests the two-line
// predicate and nothing else. Two of those seats — `lead-designer`, `tester` —
// are seats `sprintEngineCoordinatorSeat` can never produce, so on their own they
// prove less than they look like they prove. These cases start where the app
// starts: a real `SprintEngineState`, through the shared seat resolver, into the
// partition. That is the chain, and it is the only place the item's classifica-
// tion claim can be checked honestly.

function state(configuredRoles: SprintEngineState['configuredRoles']): SprintEngineState {
  return { configuredRoles } as SprintEngineState
}

function doorForState(configuredRoles: SprintEngineState['configuredRoles']): RunDoorId {
  return runDoorFor({ coordinatorSeat: sprintEngineCoordinatorSeat(state(configuredRoles)) })
}

run('a run that staffs an architect resolves, end to end, to Workflows', () => {
  assert.equal(doorForState(['architect', 'developer']), 'workflows')
  assert.equal(doorForState(['architect']), 'workflows')
})

run('a run that staffs no role at all resolves, end to end, to Sprints', () => {
  assert.equal(doorForState([]), 'sprints', 'a deliberate empty set is a roleless run')
})

run('a legacy run that recorded no role set keeps its architect seat', () => {
  // The PRESENCE of the key is what separates the two empty cases: a store that
  // never recorded one is legacy and still coordinates through an architect.
  assert.equal(doorForState(undefined), 'workflows')
})

run('a role-based run with no architect lands in Sprints — the gap epic 2058 owns', () => {
  // THIS IS THE ITEM'S CLASSIFICATION GAP, PINNED AT ITS TRUE BEHAVIOUR.
  //
  // `['developer', 'tester']` staffs ROLES and has no architect. The plan for
  // this item calls Workflows "filtered to role-based runs", but the seat
  // resolver bottoms out on `roles.has('architect')`
  // (src/shared/sprintengine/state.ts:1745), so the effective door predicate is
  // `configuredRoles.includes('architect')` and this run lists under Sprints.
  //
  // Asserted as it BEHAVES, not as the wording wishes. The literal belongs to
  // epic 2058 and this item is forbidden from touching it; when that epic
  // deletes it, this assertion is the one that fails, which is exactly the
  // signal wanted — a gap recorded rather than hidden.
  assert.equal(
    doorForState(['developer', 'tester']),
    'sprints',
    'today the door means "does an architect coordinate it", not "does it staff roles"',
  )
})

// ── The round trip: a run created at a door is listed by the door you land on ─
//
// The blocker this suite exists to stop coming back. The `+` claims a door, but
// the ROSTER decides the run's kind, and creation routes on what it made rather
// than on what was claimed (`runDoorForRoleCounts`, read by NewSprintDialog).
// Each case below walks the whole way: the roster a door hands over → the launch
// role counts the create path derives from it → the door creation lands on → the
// summary the index will publish for that run → the door that lists it.

function createdAtDoor(rosterRef: string | null, roleCounts: SprintEngineRoleCounts): {
  landsOn: RunDoorId
  listedBy: RunDoorId[]
} {
  // Exactly what the create path computes before it calls the engine.
  const launchRoleCounts = sprintEngineLaunchRoleCounts(rosterRef ?? NO_ROLES_ROSTER_ID, roleCounts)
  const landsOn = runDoorForRoleCounts(launchRoleCounts)
  // And what the index will say about the run once it exists: the same seat,
  // resolved from the `configuredRoles` the launch counts become.
  const configuredRoles = (Object.keys(launchRoleCounts) as SprintEngineState['configuredRoles'] & string[])
    .filter((role) => (launchRoleCounts[role as keyof SprintEngineRoleCounts] ?? 0) > 0)
  const created = summary({
    teamSlug: 'just-created',
    coordinatorSeat: sprintEngineCoordinatorSeat(state(configuredRoles)),
  })
  const listedBy = RUN_DOOR_IDS.filter((door) =>
    runsForDoor([created], door).some((entry) => entry.teamSlug === 'just-created'),
  )
  return { landsOn, listedBy }
}

run('a run created at the Workflows door lands on a door that lists it', () => {
  // The Workflows `+` hands over a roster that seats a named coordinator — the
  // only kind it is allowed to offer.
  const architectRoster: SprintEngineRoleCounts = { architect: 1, developer: 1 }
  const trip = createdAtDoor('roster-architect', architectRoster)
  assert.equal(trip.landsOn, 'workflows', 'and it is the door that was pressed')
  assert.deepEqual(trip.listedBy, ['workflows'], 'the run it made is listed there')
})

run('a run created at the Sprints door lands on a door that lists it', () => {
  const trip = createdAtDoor(NO_ROLES_ROSTER_ID, { architect: 1, developer: 1 })
  assert.equal(trip.landsOn, 'sprints', 'no roles is a sprint whatever the seeded rows say')
  assert.deepEqual(trip.listedBy, ['sprints'])
})

run('the door pressed never outranks the run that came out', () => {
  // The regression in full. The Workflows `+` used to allow an unstated roster,
  // which resolved to the zero-configuration default (No roles) — so the door
  // claimed 'workflows', the run came out roleless, and the operator was put
  // down on a list its own partition kept the run out of. On a first run that
  // list said "Run your first workflow", about the workflow they had just run.
  const claimedByTheDoor: RunDoorId = 'workflows'
  const trip = createdAtDoor(NO_ROLES_ROSTER_ID, { architect: 1, developer: 1 })
  assert.notEqual(trip.landsOn, claimedByTheDoor, 'the claim and the truth really do come apart')
  assert.deepEqual(trip.listedBy, [trip.landsOn], 'and routing follows the truth')

  // The mirror, which is just as live: the Sprints `+` with a last-used
  // architect roster produces a workflow, and lands on Workflows.
  const mirror = createdAtDoor('roster-architect', { architect: 1, developer: 1 })
  assert.equal(mirror.landsOn, 'workflows')
  assert.deepEqual(mirror.listedBy, ['workflows'])
})

// ── The deep link resolves the same way ─────────────────────────────────────
// A Backlog run link answers the door from the projection it has already read,
// not from an index summary. Same rule, same fallback.

run('a run link resolves its door from the projection, and an unreadable one falls to Sprints', () => {
  assert.equal(runDoorForProjection(state(['architect'])), 'workflows')
  assert.equal(runDoorForProjection(state([])), 'sprints')
  assert.equal(runDoorForProjection(null), 'sprints', 'a projection that would not normalize states no kind')
})

console.log('all run-door partition tests passed')
