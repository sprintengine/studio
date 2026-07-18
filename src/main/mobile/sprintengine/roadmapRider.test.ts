// Behavioral acceptance for the mobile roadmap rider (MC-1620 / T7), covering the
// T9 back-compat clause: "an old phone renders sprints unchanged against a snapshot
// carrying the roadmap rider." Distinct from the developer's unit tests — it drives
// the REAL disk-reading path (`listBacklogItems` + the orchestrator sidecar store +
// `parseRoadmap` + `buildRoadmapBoardModel`) against a real temp workspace, then
// asserts the projection is additive and read-only:
//   1. an active roadmap yields one progress rider with derived done/total/running;
//   2. the rider carries ONLY progress fields — no paths, statePath, or anything the
//      phone could steer with (the "no new scope, read-only" guarantee);
//   3. a workspace with no roadmaps yields [] → the snapshot omits `roadmaps`, so a
//      phone that predates roadmaps is untouched (the old-phone-unchanged clause);
//   4. a parked lane surfaces `parked: true`; an inactive roadmap yields no rider.

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readMobileRoadmapRiders } from './roadmapRider'
import { createRoadmapOrchestratorStore } from '../../roadmap-orchestrator-store'
import type { RoadmapLaneRuntime } from '../../../shared/sprintengine/roadmap-orchestrator'

const ROADMAP_REF = 'backlog/roadmaps/platform.md'

// A three-step-ish lane: a delivered (completed) predecessor, an in-progress
// frontier, and a not-yet-started tail — enough to exercise done/total/running.
function roadmapFile(status = 'ready'): string {
  return [
    '---',
    'type: roadmap',
    `status: ${status}`,
    'advance: approve',
    'merge: manual',
    '---',
    '',
    '# Platform Roadmap',
    '',
    '## Delivery',
    '- backlog/a.md',
    '- backlog/b.md',
    '- backlog/c.md',
    '',
  ].join('\n')
}

function backlogItem(title: string, status: string): string {
  return `---\nstatus: ${status}\n---\n\n# ${title}\n`
}

async function makeWorkspace(options: {
  roadmap?: string
  lanes?: Map<string, RoadmapLaneRuntime>
}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'roadmap-rider-'))
  await mkdir(join(root, 'backlog', 'roadmaps'), { recursive: true })
  // The referenced backlog items: a delivered, b running, c queued.
  await writeFile(join(root, 'backlog', 'a.md'), backlogItem('Item A', 'completed'), 'utf8')
  await writeFile(join(root, 'backlog', 'b.md'), backlogItem('Item B', 'in_progress'), 'utf8')
  await writeFile(join(root, 'backlog', 'c.md'), backlogItem('Item C', 'ready'), 'utf8')
  if (options.roadmap !== undefined) {
    await writeFile(join(root, ROADMAP_REF), options.roadmap, 'utf8')
  }
  if (options.lanes) {
    await createRoadmapOrchestratorStore(root).write(ROADMAP_REF, options.lanes)
  }
  return root
}

test('an active roadmap projects one additive, read-only progress rider', async () => {
  const root = await makeWorkspace({
    roadmap: roadmapFile('ready'),
    // The orchestrator is running item b in the Delivery lane.
    lanes: new Map<string, RoadmapLaneRuntime>([
      ['Delivery', {
        lane: 'Delivery',
        activeItemRef: 'backlog/b.md',
        activeStatePath: '/w/.multi-code/sprintengine/team-b/run.yaml',
        activeTeamSlug: 'team-b',
        activeRepoId: 'primary',
      }],
    ]),
  })
  try {
    const riders = await readMobileRoadmapRiders(root)
    assert.equal(riders.length, 1)
    const rider = riders[0]
    assert.equal(rider.roadmapId, 'platform')
    assert.equal(rider.name, 'Platform Roadmap')
    assert.equal(rider.lanes.length, 1)

    const lane = rider.lanes[0]
    // Derived progress: a delivered, b running → 1 of 3 done, b is the running step.
    assert.equal(lane.name, 'Delivery')
    assert.equal(lane.done, 1)
    assert.equal(lane.total, 3)
    assert.equal(lane.runningItem, 'Item B')
    assert.equal(lane.parked, undefined)

    // Read-only guarantee: the rider leaks NOTHING steerable — no state paths, team
    // slugs, refs, or run identifiers a phone could act on. Only progress copy.
    const allowedLaneKeys = new Set(['name', 'done', 'total', 'runningItem', 'parked'])
    for (const key of Object.keys(lane)) {
      assert.ok(allowedLaneKeys.has(key), `rider lane leaked non-progress field "${key}"`)
    }
    const serialized = JSON.stringify(rider)
    assert.ok(!serialized.includes('run.yaml'), 'rider must not carry a run state path')
    assert.ok(!serialized.includes('team-b'), 'rider must not carry a team slug')
    assert.ok(!serialized.includes('backlog/b.md'), 'rider must not carry a backlog ref')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a workspace with no roadmaps yields no riders (old phone renders sprints unchanged)', async () => {
  // Backlog items exist, but no roadmap file — the pre-roadmap world. The snapshot
  // builder spreads `roadmaps` only when non-empty, so an empty result means the
  // field is omitted and a phone that predates roadmaps sees an untouched snapshot.
  const root = await makeWorkspace({ roadmap: undefined })
  try {
    const riders = await readMobileRoadmapRiders(root)
    assert.deepEqual(riders, [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an inactive (completed) roadmap is not ridden — only live progress rides', async () => {
  const root = await makeWorkspace({ roadmap: roadmapFile('completed') })
  try {
    const riders = await readMobileRoadmapRiders(root)
    assert.deepEqual(riders, [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a parked lane surfaces parked:true without leaking the run', async () => {
  const root = await makeWorkspace({
    roadmap: roadmapFile('needs_input'),
    lanes: new Map<string, RoadmapLaneRuntime>([
      ['Delivery', {
        lane: 'Delivery',
        activeItemRef: 'backlog/b.md',
        activeStatePath: '/w/.multi-code/sprintengine/team-b/run.yaml',
        parked: { reason: 'run_failed', itemRef: 'backlog/b.md', at: '2026-07-18T00:00:00Z' },
      }],
    ]),
  })
  try {
    const riders = await readMobileRoadmapRiders(root)
    assert.equal(riders.length, 1)
    const lane = riders[0].lanes[0]
    assert.equal(lane.parked, true)
    // Even parked, the reason string ('run_failed') stays desktop-side — the phone
    // gets a boolean, never the machine-readable reason or the run path.
    const serialized = JSON.stringify(riders[0])
    assert.ok(!serialized.includes('run_failed'), 'rider must not carry the park reason')
    assert.ok(!serialized.includes('run.yaml'), 'rider must not carry a run state path')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
