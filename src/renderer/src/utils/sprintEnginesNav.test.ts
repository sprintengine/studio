import assert from 'node:assert/strict'

import {
  buildSprintEngineNavRows,
  isSprintEngineWorkspace,
  type SprintEngineNavRow,
} from './sprintEnginesNav'
import type { WorkspaceRunGlyph } from './workspaceRunGlyph'

type FakeWorkspace = {
  id: string
  name: string
  mode: string
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

console.log('sprintEnginesNav tests passed')
