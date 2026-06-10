import assert from 'node:assert/strict'

import { createRendererHost, type WorkspaceTypeDefinition } from './renderer-host'
import type { LayoutTemplate } from '../types/workspace'

const template: LayoutTemplate = {
  id: 'workspace-type-test',
  name: 'Workspace Type Test',
  description: 'Test template',
  previewSlots: [],
  layout: {
    global: { tabSetEnableDrop: true, tabEnableClose: false },
    borders: [],
    layout: {
      type: 'row',
      children: [],
    },
  },
}

function workspaceType(id: string, pickerOrder?: number): WorkspaceTypeDefinition {
  return {
    id,
    label: id,
    description: `${id} workspace`,
    icon() {
      throw new Error('icon component should not be evaluated during registration')
    },
    accentToken: `--tool-${id}`,
    searchTerms: [`${id}-term`],
    createTemplate() {
      return template
    },
    topBarViews: {
      label: id,
      views: [{ component: `${id}-view`, name: id }],
    },
    supervisors: [],
    creationStepsId: id,
    pickerOrder,
  }
}

const host = createRendererHost()
const sprintType = workspaceType('sprintengine', 20)
const switchboardType = workspaceType('switchboard', 10)
const multiloopType = workspaceType('multiloop', 10)

host.hostFor('sprint-engine').registerWorkspaceType(sprintType)
host.hostFor('switchboard').registerWorkspaceType(switchboardType)
host.hostFor('multiloop').registerWorkspaceType(multiloopType)

assert.throws(
  () => host.hostFor('other').registerWorkspaceType(workspaceType('sprintengine')),
  /Workspace type "sprintengine" is already registered/,
  'duplicate workspace type ids fail clearly',
)
assert.throws(
  () => host.hostFor('core').registerWorkspaceType(workspaceType('standard')),
  /shell-owned/,
  'standard stays owned by the workspace shell',
)
assert.throws(
  () => host.hostFor('blank').registerWorkspaceType(workspaceType('')),
  /non-empty string/,
  'blank workspace type ids are rejected before registration',
)
assert.throws(
  () => host.hostFor('blank').registerWorkspaceType(workspaceType('   ')),
  /non-empty string/,
  'whitespace-only workspace type ids are rejected before registration',
)

assert.equal(host.getWorkspaceType('sprintengine')?.moduleId, 'sprint-engine')
assert.equal(host.getWorkspaceType('sprintengine')?.createTemplate(), template)
assert.equal(host.getWorkspaceTypeModule('switchboard'), 'switchboard')
assert.equal(host.getWorkspaceType('missing'), undefined)
assert.equal(host.getWorkspaceTypeModule('missing'), undefined)

assert.deepEqual(
  host.getWorkspaceTypes().map((definition) => definition.id),
  ['multiloop', 'switchboard', 'sprintengine'],
  'workspace types sort by pickerOrder, then id',
)
assert.deepEqual(
  host.getWorkspaceTypes((moduleId) => moduleId !== 'switchboard').map((definition) => definition.id),
  ['multiloop', 'sprintengine'],
  'disabled modules are filtered from workspace type listings',
)

console.log('renderer host workspace type tests passed')
