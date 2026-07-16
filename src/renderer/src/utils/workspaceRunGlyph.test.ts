import assert from 'node:assert/strict'
import { deriveWorkspaceRunGlyph, workspaceHasRunGlyphProvider } from './workspaceRunGlyph'
import { useWorkspaceStore } from '../store/workspaceStore'
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
      cliPermissionPreset: 'default',
      maxConcurrentAgents: 3,
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

function manualAutoState(): NonNullable<WorkspaceLike['sprintEngineAutoState']> {
  return {
    desiredMode: 'manual',
    runtimeState: 'idle',
    cliPermissionPreset: 'default',
    maxConcurrentAgents: 3,
    deliveredAgentNotificationEventKeys: [],
  }
}

function sprintState(tasks: SprintEngineTask[]): NonNullable<WorkspaceLike['sprintEngineState']> {
  return {
    name: 'Run',
    goal: '',
    roleCounts: {},
    sprintEngineAgents: {},
    events: [],
    artifacts: [],
    tasks,
  }
}

useWorkspaceStore.getState().setModuleEnabled('sprint-engine', true)

// Non-sprint workspaces never get a run glyph — the shell's dot + recency
// idiom stays theirs.
assert.equal(
  deriveWorkspaceRunGlyph(
    { mode: 'standard', sprintEngineState: null, sprintEngineContext: undefined, sprintEngineAutoState: undefined } as unknown as WorkspaceLike,
  ),
  null,
)
assert.equal(
  workspaceHasRunGlyphProvider({
    mode: 'standard', sprintEngineState: null, sprintEngineContext: undefined, sprintEngineAutoState: undefined,
  } as unknown as WorkspaceLike),
  false,
)

assert.equal(
  deriveWorkspaceRunGlyph({ ...sprintWorkspace(), mode: 'multiloop' }),
  null,
  'a workspace type without a run-glyph provider falls back to the dot/recency idiom',
)

// Running runner → the one live spinner.
assert.deepEqual(deriveWorkspaceRunGlyph(sprintWorkspace()), {
  state: 'in_progress',
  live: true,
  label: 'Running',
})
assert.equal(workspaceHasRunGlyphProvider(sprintWorkspace()), true)

assert.deepEqual(
  deriveWorkspaceRunGlyph(
    sprintWorkspace({
      mode: 'standard',
      sprintEngineContext: sprintEngineContext(),
    }),
  ),
  {
    state: 'in_progress',
    live: true,
    label: 'Running',
  },
  'sprintEngineContext membership dispatches to the Sprint Engine provider even when mode is standard',
)

// Regression — the whole point of this change: terminals do NOT drive a sprint's
// glyph. A clean board (no needs_input task) reads from sprint state even though
// an agent terminal is sitting at (or stuck at) an awaiting-input prompt; the
// caller no longer passes terminal activity in at all.
assert.equal(
  deriveWorkspaceRunGlyph(sprintWorkspace({ sprintEngineState: sprintState([task({ status: 'in_progress' })]) }))?.state,
  'in_progress',
  'a running sprint with a clean board is in_progress, not needs_input, regardless of terminal phase',
)

useWorkspaceStore.getState().setModuleEnabled('sprint-engine', false)
assert.equal(
  deriveWorkspaceRunGlyph(sprintWorkspace()),
  null,
  'disabled sprint-engine module disables its run-glyph provider',
)
assert.equal(workspaceHasRunGlyphProvider(sprintWorkspace()), false)
useWorkspaceStore.getState().setModuleEnabled('sprint-engine', true)

// Idle/manual runner with no observable work → no run signal; the surface keeps
// its own resting rendering. Terminals can no longer manufacture a glyph here.
const idleAuto = sprintWorkspace({ sprintEngineAutoState: manualAutoState() })
assert.equal(deriveWorkspaceRunGlyph(idleAuto), null)

// A completed run keeps the done glyph for good — viewing the workspace no
// longer fades it back to recency text. Recency survives in the glyph tooltip.
const completedAt = Date.parse('2026-06-08T10:00:00Z')
function completedWorkspace(): WorkspaceLike {
  return sprintWorkspace({
    sprintEngineAutoState: {
      desiredMode: 'run_agents',
      runtimeState: 'complete',
      changedAt: completedAt,
      cliPermissionPreset: 'default',
      maxConcurrentAgents: 3,
      deliveredAgentNotificationEventKeys: [],
    },
  })
}
assert.deepEqual(deriveWorkspaceRunGlyph(completedWorkspace()), {
  state: 'done',
  live: false,
  label: 'Complete',
})

// A manually-driven run (runner never reaches `complete`) whose tasks all
// finished reads as done too.
const manualDone = sprintWorkspace({
  sprintEngineState: sprintState([
    task({ id: 'T1', completedAt: '2026-06-08T09:00:00Z' }),
    task({ id: 'T2', completedAt: '2026-06-08T10:00:00Z' }),
  ]),
  sprintEngineAutoState: manualAutoState(),
})
assert.equal(deriveWorkspaceRunGlyph(manualDone)?.state, 'done')

// A manual run with an in-flight task now reads in_progress (static — no live
// runner is asserted) instead of null: progress is derived from the board.
const manualInFlight = sprintWorkspace({
  sprintEngineState: sprintState([
    task({ id: 'T1', completedAt: '2026-06-08T09:00:00Z' }),
    task({ id: 'T2', status: 'in_progress' }),
  ]),
  sprintEngineAutoState: manualAutoState(),
})
assert.deepEqual(deriveWorkspaceRunGlyph(manualInFlight), {
  state: 'in_progress',
  live: false,
  label: 'In progress',
})

// Removed: the changes_requested run-glyph case tested deleted gate machinery
// (MC-1542 single-owner tasks — `changes_requested` is no longer a task status).

// A started run (some done) with nothing running reads paused.
const pausedRun = sprintWorkspace({
  sprintEngineState: sprintState([task({ id: 'T1', completedAt: '2026-06-08T09:00:00Z' }), task({ id: 'T2', status: 'todo' })]),
  sprintEngineAutoState: manualAutoState(),
})
assert.equal(deriveWorkspaceRunGlyph(pausedRun)?.state, 'paused')

// A never-started run (all todo, idle runner) has no run signal yet.
const notStarted = sprintWorkspace({
  sprintEngineState: sprintState([task({ id: 'T1', status: 'todo' }), task({ id: 'T2', status: 'todo' })]),
  sprintEngineAutoState: manualAutoState(),
})
assert.equal(deriveWorkspaceRunGlyph(notStarted), null)

console.log('workspaceRunGlyph tests passed')
