import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  isCancelableSprintEngineWorkspace,
  sprintEngineHasOnDiskState,
  sprintEngineOnDiskStateDirectory,
} from './sprint-engine-sidebar'
import type { WorkspaceTypeSidebarWorkspace } from './renderer-host'

function row(over: Partial<WorkspaceTypeSidebarWorkspace> = {}): WorkspaceTypeSidebarWorkspace {
  return {
    id: 'ws-1',
    name: 'Auth sprint',
    mode: 'sprintengine',
    ...over,
  }
}

const liveContext = {
  teamName: 'auth',
  teamSlug: 'auth',
  teamDirectoryPath: '/Users/dev/app/.sprintengine/sprintengine/auth',
  statePath: '/Users/dev/app/.sprintengine/sprintengine/auth/run.yaml',
}

assert.equal(sprintEngineHasOnDiskState(row()), false, 'no bag ⇒ no on-disk state')
assert.equal(
  sprintEngineHasOnDiskState(row({ moduleState: { sprintengine: { context: liveContext } } })),
  true,
  'a team directory is on-disk state',
)
assert.equal(
  sprintEngineOnDiskStateDirectory(row({ moduleState: { sprintengine: { context: liveContext } } })),
  liveContext.teamDirectoryPath,
)

assert.equal(
  isCancelableSprintEngineWorkspace(row({ mode: 'standard' })),
  false,
  'a standard workspace is not a cancelable sprint',
)
assert.equal(
  isCancelableSprintEngineWorkspace(row({ moduleState: { sprintengine: { context: liveContext } } })),
  true,
  'a live sprint with a run file is cancelable',
)
assert.equal(
  isCancelableSprintEngineWorkspace(row({
    moduleState: { sprintengine: { context: liveContext } },
    sprintEngineAutoState: { runtimeState: 'canceled' } as WorkspaceTypeSidebarWorkspace['sprintEngineAutoState'],
  })),
  false,
  'a canceled runtime does not re-offer Cancel',
)
assert.equal(
  isCancelableSprintEngineWorkspace(row({
    moduleState: {
      sprintengine: {
        context: liveContext,
        state: { canceled: true },
      },
    },
  })),
  false,
  'a canceled projection does not re-offer Cancel',
)

const sidebarSource = readFileSync(
  join(process.cwd(), 'src/renderer/src/components/workspace/WorkspaceSidebar.tsx'),
  'utf8',
)
assert.equal(
  sidebarSource.includes("workspace.mode === 'sprintengine'"),
  false,
  'sidebar rows no longer switch on the sprint mode string',
)
assert.match(sidebarSource, /workspaceTypeRowActions/, 'sidebar row actions come from the registered type')

const runStoreSource = readFileSync(
  join(process.cwd(), 'src/renderer/src/modules/sprint-engine-run-store.ts'),
  'utf8',
)
assert.equal(
  runStoreSource.includes("from '../store/workspaceStore'"),
  false,
  'the module run store does not import the core workspace store',
)
assert.match(runStoreSource, /bindSprintEngineRunStore/, 'the shell binds the run store')

