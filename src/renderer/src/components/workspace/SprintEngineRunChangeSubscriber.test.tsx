import assert from 'node:assert/strict'

import { collectQuiescedSprintWorkspaces } from './SprintEngineRunChangeSubscriber'
import type { Workspace } from '../../types/workspace'

// The selection rule for main's runs-changed broadcast: refresh only the sprint
// workspaces in THIS window whose projection poll has already quiesced on that
// run. Everything else is being read on its own cadence, and refreshing it here
// would just duplicate a read that is about to happen anyway.

const STATE_PATH = '/projects/alpha/.multi-code/sprintengine/alpha/run.yaml'

// `canStopPollingCompletedSprintEngineProjection` quiesces on a run that is
// lifecycle-`complete`, hydrated complete, and torn down.
function quiescedState(): Workspace['sprintEngineState'] {
  return {
    tasks: [{ id: 'T1', status: 'done' }],
    artifacts: [],
  } as unknown as Workspace['sprintEngineState']
}

function workspace(overrides: Partial<Workspace> & { id: string }): Workspace {
  return {
    mode: 'sprintengine',
    sprintEngineContext: { statePath: STATE_PATH },
    sprintEngineState: quiescedState(),
    sprintEngineAutoState: { runtimeState: 'complete', completionTeardownAt: 1 },
    ...overrides,
  } as unknown as Workspace
}

const inWindow = new Set(['quiesced', 'live', 'other-run', 'plain', 'no-context'])

const workspaces: Workspace[] = [
  workspace({ id: 'quiesced' }),
  // Still polling (no teardown marker) — its own supervisor tick will read this.
  workspace({
    id: 'live',
    sprintEngineAutoState: { runtimeState: 'running' },
  } as Partial<Workspace> & { id: string }),
  // A different run entirely.
  workspace({
    id: 'other-run',
    sprintEngineContext: { statePath: '/projects/beta/.multi-code/sprintengine/beta/run.yaml' },
  } as unknown as Partial<Workspace> & { id: string }),
  // Not a sprint workspace.
  { id: 'plain', mode: 'terminal' } as unknown as Workspace,
  workspace({ id: 'no-context', sprintEngineContext: undefined } as Partial<Workspace> & { id: string }),
  // Right run, but this workspace belongs to another window.
  workspace({ id: 'not-in-window' }),
]

{
  const targets = collectQuiescedSprintWorkspaces(workspaces, inWindow, STATE_PATH)
  assert.deepEqual(
    targets.map((target) => target.id),
    ['quiesced'],
    'only the quiesced workspace for the changed run is refreshed',
  )
}

{
  // A run nobody in this window holds refreshes nothing — the headless case, where
  // main probed a run with no board open for it.
  const targets = collectQuiescedSprintWorkspaces(workspaces, inWindow, '/runs/unknown.yaml')
  assert.deepEqual(targets, [])
}

console.log('SprintEngineRunChangeSubscriber: all assertions passed')
