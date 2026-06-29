import assert from 'node:assert/strict'
import type { Workspace } from '../types/workspace'
import { AUTOMATIONS_HOST_WORKSPACE_MODE } from '../types/workspace'
import {
  listAutomationsHostWorkspaces,
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

// Only id/mode/name/folderPath are read; the cast keeps fixtures readable at
// this test boundary without an `any`.
function ws(
  id: string,
  mode: Workspace['mode'],
  name: string,
  folderPath: string | null,
): AutomationsHostCandidate {
  return { id, mode, name, folderPath } as AutomationsHostCandidate
}

const HOST = AUTOMATIONS_HOST_WORKSPACE_MODE

run('lists only automations-host workspaces, in order', () => {
  const workspaces = [
    ws('std', 'standard', 'App', '/proj/app'),
    ws('host-app', HOST, 'Automations', '/proj/app'),
    ws('sprint', 'sprintengine', 'Sprint', '/proj/lib'),
    ws('host-lib', HOST, 'Automations', '/proj/lib'),
  ]
  assert.deepEqual(listAutomationsHostWorkspaces(workspaces), [
    { id: 'host-app', name: 'Automations', folderPath: '/proj/app', displayName: 'app' },
    { id: 'host-lib', name: 'Automations', folderPath: '/proj/lib', displayName: 'lib' },
  ])
})

run('empty when no automations-host workspaces exist', () => {
  const workspaces = [
    ws('std', 'standard', 'App', '/proj/app'),
    ws('sprint', 'sprintengine', 'Sprint', '/proj/lib'),
  ]
  assert.deepEqual(listAutomationsHostWorkspaces(workspaces), [])
})

run('displayName is the folder basename (default-named hosts disambiguate by folder)', () => {
  const workspaces = [
    ws('a', HOST, 'Automations', '/work/projects/checkout-service/'),
    ws('b', HOST, 'Automations', 'C:\\work\\billing'),
  ]
  assert.deepEqual(
    listAutomationsHostWorkspaces(workspaces).map((entry) => entry.displayName),
    ['checkout-service', 'billing'],
  )
})

run('displayName falls back to the workspace name when there is no folder', () => {
  const workspaces = [ws('a', HOST, 'My Automations', null)]
  assert.deepEqual(listAutomationsHostWorkspaces(workspaces), [
    { id: 'a', name: 'My Automations', folderPath: null, displayName: 'My Automations' },
  ])
})

console.log('all automationsEntry tests passed')
