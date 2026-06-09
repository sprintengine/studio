import assert from 'node:assert/strict'
import { deriveWorkspaceRunGlyph, isSprintEngineCompletionUnseen } from './workspaceRunGlyph'
import type { SprintEngineTask, Workspace } from '../types/workspace'

type WorkspaceLike = Pick<
  Workspace,
  'mode' | 'sprintEngineState' | 'sprintEngineContext' | 'sprintEngineAutoState'
>

function task(overrides: Partial<SprintEngineTask>): SprintEngineTask {
  return {
    id: 'T1',
    title: 'Task',
    description: '',
    role: 'developer',
    status: 'done',
    ownerAgentId: null,
    dependsOn: [],
    ownedPaths: [],
    acceptanceCriteria: [],
    implementationNotes: [],
    evidence: { summary: '', touchedFiles: [], commandsRan: [], results: [] },
    notes: [],
    comments: [],
    startedAt: null,
    completedAt: null,
    ...overrides,
  }
}

function sprintWorkspace(overrides: Partial<WorkspaceLike> = {}): WorkspaceLike {
  return {
    mode: 'sprintengine',
    sprintEngineState: null,
    sprintEngineContext: undefined,
    sprintEngineAutoState: {
      desiredMode: 'run_agents',
      runtimeState: 'running',
      keepDoneAgentTerminals: false,
      cliPermissionPreset: 'default',
      maxConcurrentAgents: 3,
      pendingSpawns: [],
      deliveredAgentNotificationEventKeys: [],
    },
    ...overrides,
  }
}

// Non-sprint workspaces never get a run glyph — the shell's dot + recency
// idiom stays theirs.
assert.equal(
  deriveWorkspaceRunGlyph(
    { mode: 'standard', sprintEngineState: null, sprintEngineContext: undefined, sprintEngineAutoState: undefined } as WorkspaceLike,
    'working',
  ),
  null,
)

// An agent terminal waiting on input outranks a running runner — the old
// pulsing warn dot's priority, kept.
assert.deepEqual(deriveWorkspaceRunGlyph(sprintWorkspace(), 'needs-input'), {
  state: 'needs_input',
  live: false,
  label: 'Needs input',
})

// Running runner → the one live spinner.
assert.deepEqual(deriveWorkspaceRunGlyph(sprintWorkspace(), 'idle'), {
  state: 'in_progress',
  live: true,
  label: 'Running',
})

// Idle runner, busy terminals → spinner covers it; no "now" text on sprint rows.
const idleAuto = sprintWorkspace({
  sprintEngineAutoState: {
    desiredMode: 'manual',
    runtimeState: 'idle',
    keepDoneAgentTerminals: false,
    cliPermissionPreset: 'default',
    maxConcurrentAgents: 3,
    pendingSpawns: [],
    deliveredAgentNotificationEventKeys: [],
  },
})
assert.equal(deriveWorkspaceRunGlyph(idleAuto, 'working')?.state, 'in_progress')
assert.equal(deriveWorkspaceRunGlyph(idleAuto, 'failed')?.state, 'failed')
assert.equal(deriveWorkspaceRunGlyph(idleAuto, 'idle'), null)

// Completion is news once: an unseen complete run shows the done glyph; once
// the seen mark is at or past the completion timestamp the row reverts to the
// recency fallback (null).
const completedAt = Date.parse('2026-06-08T10:00:00Z')
function completedWorkspace(completionSeenAt?: number): WorkspaceLike {
  return sprintWorkspace({
    sprintEngineAutoState: {
      desiredMode: 'run_agents',
      runtimeState: 'complete',
      changedAt: completedAt,
      ...(typeof completionSeenAt === 'number' ? { completionSeenAt } : {}),
      keepDoneAgentTerminals: false,
      cliPermissionPreset: 'default',
      maxConcurrentAgents: 3,
      pendingSpawns: [],
      deliveredAgentNotificationEventKeys: [],
    },
  })
}
assert.equal(isSprintEngineCompletionUnseen(completedWorkspace()), true)
assert.deepEqual(deriveWorkspaceRunGlyph(completedWorkspace(), 'idle'), {
  state: 'done',
  live: false,
  label: 'Run completed',
})
assert.equal(isSprintEngineCompletionUnseen(completedWorkspace(completedAt + 1)), false)
assert.equal(deriveWorkspaceRunGlyph(completedWorkspace(completedAt + 1), 'idle'), null)
// A later completion is news again.
assert.equal(isSprintEngineCompletionUnseen(completedWorkspace(completedAt - 1)), true)
// A seen-done workspace whose terminals are busy again still earns the spinner.
assert.equal(deriveWorkspaceRunGlyph(completedWorkspace(completedAt + 1), 'working')?.state, 'in_progress')

// A manually-driven run (runner never reaches `complete`) whose tasks all
// finished reads as done, gated by the same seen rule.
const manualDone = sprintWorkspace({
  sprintEngineState: {
    name: 'Run',
    goal: '',
    roleCounts: {},
    sprintEngineAgents: {},
    events: [],
    artifacts: [],
    tasks: [
      task({ id: 'T1', completedAt: '2026-06-08T09:00:00Z' }),
      task({ id: 'T2', completedAt: '2026-06-08T10:00:00Z' }),
    ],
  },
  sprintEngineAutoState: {
    desiredMode: 'manual',
    runtimeState: 'idle',
    keepDoneAgentTerminals: false,
    cliPermissionPreset: 'default',
    maxConcurrentAgents: 3,
    pendingSpawns: [],
    deliveredAgentNotificationEventKeys: [],
  },
})
assert.equal(deriveWorkspaceRunGlyph(manualDone, 'idle')?.state, 'done')
assert.equal(isSprintEngineCompletionUnseen(manualDone), true)
const manualDoneSeen: WorkspaceLike = {
  ...manualDone,
  sprintEngineAutoState: {
    ...manualDone.sprintEngineAutoState!,
    completionSeenAt: Date.parse('2026-06-08T10:00:01Z'),
  },
}
assert.equal(deriveWorkspaceRunGlyph(manualDoneSeen, 'idle'), null)
// A run with an unfinished task is not a completed run.
const manualInFlight: WorkspaceLike = {
  ...manualDone,
  sprintEngineState: {
    ...manualDone.sprintEngineState!,
    tasks: [task({ id: 'T1', completedAt: '2026-06-08T09:00:00Z' }), task({ id: 'T2', status: 'in_progress' })],
  },
}
assert.equal(deriveWorkspaceRunGlyph(manualInFlight, 'idle'), null)
assert.equal(isSprintEngineCompletionUnseen(manualInFlight), false)

console.log('workspaceRunGlyph tests passed')
