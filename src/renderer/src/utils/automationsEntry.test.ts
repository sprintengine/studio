import assert from 'node:assert/strict'
import type { Workspace } from '../types/workspace'
import { AUTOMATIONS_HOST_WORKSPACE_MODE } from '../types/workspace'
import {
  listAutomationsProjectFolders,
  resolveAutomationsHostForFolder,
  type AutomationsHostCandidate,
} from './automationsEntry'

function run(name: string, body: () => void): void {
  try {
    body()
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`not ok - ${name}`)
    throw error
  }
}

// Only id/mode/folderPath are read by the resolver; the cast keeps fixtures
// readable at this test boundary without an `any`.
function ws(id: string, mode: Workspace['mode'], folderPath: string | null): AutomationsHostCandidate {
  return { id, mode, folderPath } as AutomationsHostCandidate
}

const HOST = AUTOMATIONS_HOST_WORKSPACE_MODE

run('reveal: existing host for the folder wins', () => {
  const workspaces = [
    ws('std', 'standard', '/proj/app'),
    ws('host', HOST, '/proj/app'),
  ]
  assert.deepEqual(resolveAutomationsHostForFolder(workspaces, '/proj/app'), {
    kind: 'reveal',
    workspaceId: 'host',
  })
})

run('create: no host for the folder', () => {
  const workspaces = [ws('std', 'standard', '/proj/app')]
  assert.deepEqual(resolveAutomationsHostForFolder(workspaces, '/proj/app'), {
    kind: 'create',
    folderPath: '/proj/app',
  })
})

run('reveal: folder match is normalized (trailing slash / case / separators)', () => {
  const workspaces = [ws('host', HOST, '/Proj/App')]
  assert.deepEqual(resolveAutomationsHostForFolder(workspaces, '\\proj\\app\\'), {
    kind: 'reveal',
    workspaceId: 'host',
  })
})

run('create: a host for a different folder does not match', () => {
  const workspaces = [ws('host', HOST, '/proj/other')]
  assert.deepEqual(resolveAutomationsHostForFolder(workspaces, '/proj/app'), {
    kind: 'create',
    folderPath: '/proj/app',
  })
})

run('reveal: first existing host wins (one-host-per-folder)', () => {
  const workspaces = [
    ws('host-a', HOST, '/proj/app'),
    ws('host-b', HOST, '/proj/app'),
  ]
  assert.deepEqual(resolveAutomationsHostForFolder(workspaces, '/proj/app'), {
    kind: 'reveal',
    workspaceId: 'host-a',
  })
})

run('project folders: distinct, first-seen order, host flagged, no-folder skipped', () => {
  const workspaces = [
    ws('a', 'standard', '/proj/app'),
    ws('b', HOST, '/proj/app'),
    ws('c', 'sprintengine', '/proj/lib'),
    ws('d', 'standard', null),
  ]
  assert.deepEqual(listAutomationsProjectFolders(workspaces), [
    { folderPath: '/proj/app', displayName: 'app', hasHost: true },
    { folderPath: '/proj/lib', displayName: 'lib', hasHost: false },
  ])
})

run('project folders: hasHost true even when the host row is seen after a standard row', () => {
  const workspaces = [
    ws('a', 'standard', '/proj/app'),
    ws('b', 'standard', '/proj/app'),
    ws('c', HOST, '/proj/app'),
  ]
  assert.deepEqual(listAutomationsProjectFolders(workspaces), [
    { folderPath: '/proj/app', displayName: 'app', hasHost: true },
  ])
})

console.log('all automationsEntry tests passed')
