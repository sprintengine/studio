import assert from 'node:assert/strict'

import {
  buildSprintEngineNavRows,
  compareSprintsRows,
  isSprintEngineWorkspace,
  matchesSprintsQuery,
  matchesSprintsView,
  type SprintEngineNavRow,
} from './sprintEnginesNav'
import type { WorkspaceRunGlyph } from './workspaceRunGlyph'

type FakeWorkspace = {
  id: string
  name: string
  mode: string
  folderPath?: string | null
  createdAt?: number
  lastTerminalActivityAt?: number | null
  archivedAt?: number | null
  sprintEngineContext?: unknown
  sprintEngineState?: { goal: string; tasks: { status: string }[] } | null
}

const glyph = (state: WorkspaceRunGlyph['state'], live = false): WorkspaceRunGlyph => ({
  state,
  live,
  label: state,
})

// Membership: sprintengine mode or a sprint engine context, nothing else.
assert.equal(isSprintEngineWorkspace({ mode: 'sprintengine', sprintEngineContext: null }), true)
assert.equal(isSprintEngineWorkspace({ mode: 'default', sprintEngineContext: { team: 't' } }), true)
assert.equal(isSprintEngineWorkspace({ mode: 'default', sprintEngineContext: null }), false)

// Non-sprint-engine workspaces are filtered out; task progress counts done over
// total; a missing state yields zero counts and an empty goal.
{
  const workspaces: FakeWorkspace[] = [
    { id: 'w1', name: 'Terminal', mode: 'default', sprintEngineContext: null },
    {
      id: 'w2',
      name: 'Checkout flow',
      mode: 'sprintengine',
      sprintEngineState: {
        goal: 'Ship checkout',
        tasks: [{ status: 'done' }, { status: 'in_progress' }, { status: 'done' }],
      },
    },
    { id: 'w3', name: 'Fresh run', mode: 'sprintengine', sprintEngineState: null },
  ]
  const rows = buildSprintEngineNavRows(workspaces, () => null)
  assert.deepEqual(
    rows.map((row: SprintEngineNavRow) => [row.workspaceId, row.goal, row.doneTasks, row.totalTasks]),
    [
      ['w2', 'Ship checkout', 2, 3],
      ['w3', '', 0, 0],
    ],
  )
}

// Attention-first ordering: needs_input, failed, running, paused, unseen done,
// then resting rows (no glyph) — name-sorted within a rank.
{
  const glyphById: Record<string, WorkspaceRunGlyph | null> = {
    idle: null,
    done: glyph('done'),
    running: glyph('in_progress', true),
    needsInput: glyph('needs_input'),
    failed: glyph('failed'),
    paused: glyph('paused'),
    idleEarlier: null,
  }
  const workspaces: FakeWorkspace[] = Object.keys(glyphById).map((id) => ({
    id,
    name: id,
    mode: 'sprintengine',
    sprintEngineState: { goal: '', tasks: [] },
  }))
  const rows = buildSprintEngineNavRows(workspaces, (workspace) => glyphById[workspace.id])
  assert.deepEqual(
    rows.map((row) => row.workspaceId),
    ['needsInput', 'failed', 'running', 'paused', 'done', 'idle', 'idleEarlier'],
  )
}

// Row derivation of the aside's filter/sort fields: project name from the
// folder's last segment, lastWorkedAt = max(createdAt, activity), archived
// from the archivedAt stamp.
{
  const workspaces: FakeWorkspace[] = [
    {
      id: 'w1',
      name: 'Alpha',
      mode: 'sprintengine',
      folderPath: '/Users/x/dev/my-app/',
      createdAt: 100,
      lastTerminalActivityAt: 500,
      sprintEngineState: null,
    },
    {
      id: 'w2',
      name: 'Beta',
      mode: 'sprintengine',
      folderPath: null,
      createdAt: 300,
      lastTerminalActivityAt: null,
      archivedAt: 900,
      sprintEngineState: null,
    },
  ]
  const rows = buildSprintEngineNavRows(workspaces, () => null)
  assert.deepEqual(
    rows.map((row) => [row.workspaceId, row.projectName, row.createdAt, row.lastWorkedAt, row.archived]),
    [
      ['w1', 'my-app', 100, 500, false],
      ['w2', null, 300, 300, true],
    ],
  )
}

// View lenses: archived is its own terminal lens; every other lens hides
// archived rows; attention covers input/failure/rework/paused/unmerged;
// completed covers the three done states.
{
  const row = (state: WorkspaceRunGlyph['state'] | null, archived = false): SprintEngineNavRow => ({
    workspaceId: 'w',
    name: 'w',
    goal: '',
    glyph: state ? glyph(state) : null,
    doneTasks: 0,
    totalTasks: 0,
    projectName: null,
    createdAt: 0,
    lastWorkedAt: 0,
    archived,
  })
  assert.equal(matchesSprintsView(row('done_merged', true), 'archived'), true)
  assert.equal(matchesSprintsView(row('done_merged', true), 'active'), false)
  assert.equal(matchesSprintsView(row('done_merged', true), 'completed'), false)
  assert.equal(matchesSprintsView(row('needs_input'), 'archived'), false)
  assert.equal(matchesSprintsView(row('in_progress'), 'active'), true)
  assert.equal(matchesSprintsView(row('in_progress'), 'running'), true)
  assert.equal(matchesSprintsView(row('in_progress'), 'attention'), false)
  for (const state of ['needs_input', 'failed', 'changes_requested', 'paused', 'done_unmerged'] as const) {
    assert.equal(matchesSprintsView(row(state), 'attention'), true, `${state} is attention`)
  }
  for (const state of ['done', 'done_merged', 'done_unmerged'] as const) {
    assert.equal(matchesSprintsView(row(state), 'completed'), true, `${state} is completed`)
  }
  assert.equal(matchesSprintsView(row(null), 'attention'), false)
  assert.equal(matchesSprintsView(row(null), 'active'), true)

  // Query matches name, goal, or project name, case-insensitively; empty
  // query matches everything.
  const searchable: SprintEngineNavRow = {
    ...row(null),
    name: 'Checkout flow',
    goal: 'Ship payments',
    projectName: 'my-app',
  }
  assert.equal(matchesSprintsQuery(searchable, ''), true)
  assert.equal(matchesSprintsQuery(searchable, 'CHECKOUT'), true)
  assert.equal(matchesSprintsQuery(searchable, 'payments'), true)
  assert.equal(matchesSprintsQuery(searchable, 'my-app'), true)
  assert.equal(matchesSprintsQuery(searchable, 'nomatch'), false)
}

// Sorts: created/updated in both directions; attention keeps the glyph-rank
// ordering the builder applies.
{
  const mk = (id: string, createdAt: number, lastWorkedAt: number): SprintEngineNavRow => ({
    workspaceId: id,
    name: id,
    goal: '',
    glyph: null,
    doneTasks: 0,
    totalTasks: 0,
    projectName: null,
    createdAt,
    lastWorkedAt,
    archived: false,
  })
  const rows = [mk('a', 3, 10), mk('b', 1, 30), mk('c', 2, 20)]
  const order = (sort: Parameters<typeof compareSprintsRows>[2]) =>
    [...rows].sort((x, y) => compareSprintsRows(x, y, sort)).map((r) => r.workspaceId)
  assert.deepEqual(order('created_desc'), ['a', 'c', 'b'])
  assert.deepEqual(order('created_asc'), ['b', 'c', 'a'])
  assert.deepEqual(order('updated_desc'), ['b', 'c', 'a'])
  assert.deepEqual(order('updated_asc'), ['a', 'c', 'b'])
  const attention = [
    { ...mk('resting', 0, 0) },
    { ...mk('urgent', 0, 0), glyph: glyph('needs_input') },
  ]
  assert.deepEqual(
    [...attention].sort((x, y) => compareSprintsRows(x, y, 'attention')).map((r) => r.workspaceId),
    ['urgent', 'resting'],
  )
}

console.log('sprintEnginesNav tests passed')
