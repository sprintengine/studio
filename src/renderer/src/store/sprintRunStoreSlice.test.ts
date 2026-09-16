import assert from 'node:assert/strict'
import test from 'node:test'

import type { SprintEngineState } from '../types/workspace'
import {
  normalizeStatePathKey,
  sprintRunHandleFromWorkspace,
  useSprintRunStore,
  type SprintRunHandle,
} from './sprintRunStoreSlice'
import { bindSprintEngineIpc } from '../modules/sprint-engine-ipc'

// The slice reads projections through `sprintEngineIpc.readSprintEngineProjection`.
// Install a controllable stub so a test can drive the read result.
type ProjectionResult =
  | { ok: true; data: unknown; token?: string; unchanged?: boolean }
  | { ok: false; message: string; permanent?: boolean }

let nextProjection: ProjectionResult = { ok: false, message: 'not configured' }
const readCalls: Array<{ statePath: string; knownToken?: string }> = []

;(globalThis as unknown as { window: unknown }).window = {
  api: {
    readSprintEngineProjection: async (statePath: string, knownToken?: string) => {
      readCalls.push({ statePath, knownToken })
      return nextProjection
    },
  },
}
bindSprintEngineIpc({
  readSprintEngineProjection: async (statePath: string, knownToken?: string) => {
    readCalls.push({ statePath, knownToken })
    return nextProjection
  },
} as never)

const STATE_PATH = '/tmp/proj/.sprintengine/sprintengine/demo-run/run.yaml'

function projection(tasks: Array<{ id: string; status: string }>): ProjectionResult {
  return {
    ok: true,
    token: 'mtime:size',
    data: {
      run: { name: 'Demo Run', goal: 'Ship it' },
      tasks: tasks.map((t) => ({ id: t.id, title: t.id, role: 'developer', status: t.status })),
    },
  }
}

function reset(): void {
  useSprintRunStore.setState({ runsByStatePath: {} })
  readCalls.length = 0
}

// Build a handle from a resolved store entry exactly as the from-statePath hook
// does, so the test proves the door construction without a React renderer.
function handleFromStore(statePath: string): SprintRunHandle | null {
  const entry = useSprintRunStore.getState().runsByStatePath[normalizeStatePathKey(statePath)]
  if (!entry?.state) return null
  return {
    statePath: entry.statePath,
    sprintEngineContext: entry.context,
    sprintEngineState: entry.state,
    setSprintEngineState: (next) => useSprintRunStore.getState().setRunState(entry.statePath, next),
    refresh: () => useSprintRunStore.getState().refreshRun(entry.statePath),
    workspaceId: undefined,
  }
}

test('from-statePath: openRun reads the projection and resolves a workspace-free handle', async () => {
  reset()
  nextProjection = projection([{ id: 'T1', status: 'done' }])
  await useSprintRunStore.getState().openRun(STATE_PATH)

  const handle = handleFromStore(STATE_PATH)
  assert.ok(handle, 'a handle resolves once the projection is read')
  assert.equal(handle.statePath, STATE_PATH)
  assert.equal(handle.workspaceId, undefined, 'a door handle carries no workspace id')
  assert.equal(handle.sprintEngineState.tasks.length, 1)
  assert.equal(handle.sprintEngineContext?.statePath, STATE_PATH)
  assert.equal(handle.sprintEngineContext?.teamSlug, 'demo-run', 'team slug derives from the run directory')
  assert.equal(handle.sprintEngineContext?.teamName, 'Demo Run', 'team name comes from the projection')
  assert.equal(typeof handle.refresh, 'function', 'a door handle exposes a projection re-read')
})

test('from-statePath: a second openRun does not re-read a resident run', async () => {
  reset()
  nextProjection = projection([{ id: 'T1', status: 'done' }])
  await useSprintRunStore.getState().openRun(STATE_PATH)
  assert.equal(readCalls.length, 1)
  await useSprintRunStore.getState().openRun(STATE_PATH)
  assert.equal(readCalls.length, 1, 'a ready run is not re-read on a second open')
})

test('from-statePath: setRunState updates the displayed state (post-steering apply)', async () => {
  reset()
  nextProjection = projection([{ id: 'T1', status: 'in_progress' }])
  await useSprintRunStore.getState().openRun(STATE_PATH)
  const handle = handleFromStore(STATE_PATH)
  assert.ok(handle)

  const nextState = {
    ...handle.sprintEngineState,
    tasks: [{ id: 'T1', title: 'T1', role: 'developer', status: 'done' }],
  } as unknown as SprintEngineState
  handle.setSprintEngineState(nextState)

  const after = handleFromStore(STATE_PATH)
  assert.equal(after?.sprintEngineState.tasks[0]?.status, 'done')
})

test('from-statePath: a missing/corrupt projection resolves to an error entry, not a crash', async () => {
  reset()
  nextProjection = { ok: false, message: 'run directory is gone', permanent: true }
  await useSprintRunStore.getState().openRun(STATE_PATH)

  const entry = useSprintRunStore.getState().runsByStatePath[normalizeStatePathKey(STATE_PATH)]
  assert.equal(entry?.status, 'error')
  assert.equal(entry?.error, 'run directory is gone')
  assert.equal(entry?.state, null)
  assert.equal(handleFromStore(STATE_PATH), null, 'no handle resolves for an errored run')
})

test('refreshRun passes the prior token back and applies a changed projection', async () => {
  reset()
  nextProjection = projection([{ id: 'T1', status: 'in_progress' }])
  await useSprintRunStore.getState().openRun(STATE_PATH)
  assert.equal(readCalls[0]?.knownToken, undefined)

  nextProjection = projection([{ id: 'T1', status: 'done' }])
  await useSprintRunStore.getState().refreshRun(STATE_PATH)
  assert.equal(readCalls[1]?.knownToken, 'mtime:size', 'the prior change token is passed back')
  assert.equal(handleFromStore(STATE_PATH)?.sprintEngineState.tasks[0]?.status, 'done')
})

test('refreshRun keeps the prior state when the projection is unchanged', async () => {
  reset()
  nextProjection = projection([{ id: 'T1', status: 'done' }])
  await useSprintRunStore.getState().openRun(STATE_PATH)
  const before = handleFromStore(STATE_PATH)?.sprintEngineState

  nextProjection = { ok: true, data: null, token: 'mtime:size', unchanged: true }
  await useSprintRunStore.getState().refreshRun(STATE_PATH)
  const after = handleFromStore(STATE_PATH)?.sprintEngineState
  assert.equal(after, before, 'an unchanged read leaves the resident state in place')
})

test('from-workspace: sprintRunHandleFromWorkspace mirrors the resident workspace and routes the setter', () => {
  const applied: Array<{ id: string; state: SprintEngineState | null }> = []
  const state = { name: 'Demo Run', tasks: [] } as unknown as SprintEngineState
  const workspace = {
    id: 'ws-42',
    sprintEngineState: state,
    sprintEngineContext: {
      teamName: 'Demo Run',
      teamSlug: 'demo-run',
      teamDirectoryPath: '/tmp/proj/.sprintengine/sprintengine/demo-run',
      statePath: STATE_PATH,
    },
  }

  const handle = sprintRunHandleFromWorkspace(workspace, (id, next) => applied.push({ id, state: next }))
  assert.ok(handle)
  assert.equal(handle.workspaceId, 'ws-42', 'a workspace handle carries its workspace id')
  assert.equal(handle.statePath, STATE_PATH)
  assert.equal(handle.sprintEngineState, state)
  assert.equal(handle.refresh, undefined, 'a workspace handle refreshes through its supervisor, not the handle')

  handle.setSprintEngineState(state)
  assert.deepEqual(applied, [{ id: 'ws-42', state }], 'the setter routes to the workspace store')
})

test('from-workspace: a workspace with no sprint state yields no handle', () => {
  const handle = sprintRunHandleFromWorkspace(
    { id: 'ws-1', sprintEngineState: null },
    () => {},
  )
  assert.equal(handle, null)
})

test('normalizeStatePathKey collapses slashes and case so both mounts share one key', () => {
  assert.equal(
    normalizeStatePathKey('/Tmp/Proj/Run.yaml/'),
    normalizeStatePathKey('\\Tmp\\Proj\\Run.yaml'),
  )
})
