import assert from 'node:assert/strict'
import { deriveWorkspaceRunGlyph } from './workspaceRunGlyph'
import { useWorkspaceStore } from '../store/workspaceStore'
import type { SprintEngineTask, Workspace } from '../types/workspace'

type WorkspaceLike = Pick<
  Workspace,
  'mode' | 'sprintEngineState' | 'sprintEngineContext' | 'sprintEngineAutoState' | 'sprintEngineCompletionSeenAt'
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

function sprintEngineContext(): NonNullable<Workspace['sprintEngineContext']> {
  return {
    teamName: 'Run',
    teamSlug: 'run',
    teamDirectoryPath: '/workspace/.multi-code/sprintengine/run',
    statePath: '/workspace/.multi-code/sprintengine/run/run.yaml',
  }
}

useWorkspaceStore.getState().setModuleEnabled('sprint-engine', true)

// Non-sprint workspaces never get a run glyph — the shell's dot + recency
// idiom stays theirs.
assert.equal(
  deriveWorkspaceRunGlyph(
    { mode: 'standard', sprintEngineState: null, sprintEngineContext: undefined, sprintEngineAutoState: undefined } as unknown as WorkspaceLike,
    'working',
  ),
  null,
)

assert.equal(
  deriveWorkspaceRunGlyph({ ...sprintWorkspace(), mode: 'multiloop' }, 'working'),
  null,
  'a workspace type without a run-glyph provider falls back to the dot/recency idiom',
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

assert.deepEqual(
  deriveWorkspaceRunGlyph(
    sprintWorkspace({
      mode: 'standard',
      sprintEngineContext: sprintEngineContext(),
    }),
    'idle',
  ),
  {
    state: 'in_progress',
    live: true,
    label: 'Running',
  },
  'sprintEngineContext membership dispatches to the Sprint Engine provider even when mode is standard',
)

useWorkspaceStore.getState().setModuleEnabled('sprint-engine', false)
assert.equal(
  deriveWorkspaceRunGlyph(sprintWorkspace(), 'needs-input'),
  null,
  'disabled sprint-engine module disables its run-glyph provider',
)
useWorkspaceStore.getState().setModuleEnabled('sprint-engine', true)

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

// A completed run keeps the done glyph until the user views the workspace after
// completion. Recency survives in the tooltip.
const completedAt = Date.parse('2026-06-08T10:00:00Z')
function completedWorkspace(): WorkspaceLike {
  return sprintWorkspace({
    sprintEngineAutoState: {
      desiredMode: 'run_agents',
      runtimeState: 'complete',
      changedAt: completedAt,
      keepDoneAgentTerminals: false,
      cliPermissionPreset: 'default',
      maxConcurrentAgents: 3,
      pendingSpawns: [],
      deliveredAgentNotificationEventKeys: [],
    },
  })
}
assert.deepEqual(deriveWorkspaceRunGlyph(completedWorkspace(), 'idle'), {
  state: 'done',
  live: false,
  label: 'Run completed',
})
assert.equal(
  deriveWorkspaceRunGlyph({ ...completedWorkspace(), sprintEngineCompletionSeenAt: completedAt }, 'idle'),
  null,
  'viewing the workspace after completion clears the done glyph',
)
assert.equal(
  deriveWorkspaceRunGlyph({ ...completedWorkspace(), sprintEngineCompletionSeenAt: completedAt - 1 }, 'idle')?.state,
  'done',
  'an older view does not acknowledge a newer completion',
)
// A done workspace whose terminals are busy again still earns the spinner.
assert.equal(deriveWorkspaceRunGlyph(completedWorkspace(), 'working')?.state, 'in_progress')

// A manually-driven run (runner never reaches `complete`) whose tasks all
// finished reads as done too.
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
assert.equal(
  deriveWorkspaceRunGlyph({ ...manualDone, sprintEngineCompletionSeenAt: Date.parse('2026-06-08T10:00:00Z') }, 'idle'),
  null,
  'manual completion clears after the workspace is viewed',
)
// A run with an unfinished task is not a completed run.
const manualInFlight: WorkspaceLike = {
  ...manualDone,
  sprintEngineState: {
    ...manualDone.sprintEngineState!,
    tasks: [task({ id: 'T1', completedAt: '2026-06-08T09:00:00Z' }), task({ id: 'T2', status: 'in_progress' })],
  },
}
assert.equal(deriveWorkspaceRunGlyph(manualInFlight, 'idle'), null)

console.log('workspaceRunGlyph tests passed')
