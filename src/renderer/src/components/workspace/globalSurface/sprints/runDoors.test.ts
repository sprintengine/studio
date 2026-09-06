import assert from 'node:assert/strict'

import type { SprintRunRuntimeState, SprintRunSummary } from '../../../../../../shared/sprintengine/runSummary'
import {
  partitionRunsByDoor,
  runBelongsToDoor,
  runDoorFor,
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

console.log('all run-door partition tests passed')
