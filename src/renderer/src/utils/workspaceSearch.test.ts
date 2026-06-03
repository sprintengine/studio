import assert from 'node:assert/strict'
import type { Workspace } from '../types/workspace'
import {
  filterWorkspacesBySearchQuery,
  normalizeWorkspaceSearchQuery,
  workspaceMatchesSearch,
} from './workspaceSearch'

function run(name: string, body: () => void): void {
  try {
    body()
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`not ok - ${name}`)
    throw error
  }
}

function makeWorkspace(
  id: string,
  fields: Pick<Workspace, 'name' | 'mode'> & { folderPath?: string | null }
): Workspace {
  return {
    id,
    name: fields.name,
    mode: fields.mode,
    folderPath: fields.folderPath ?? null,
  } as Workspace
}

const workspaces = [
  makeWorkspace('api', {
    name: 'API cleanup',
    mode: 'standard',
    folderPath: '/Users/dev/work/acme-platform',
  }),
  makeWorkspace('swarm', {
    name: 'Swarm launch',
    mode: 'sprintengine',
    folderPath: '/Users/dev/work/multicode',
  }),
  makeWorkspace('brief', {
    name: 'Checkout flow',
    mode: 'guided-brief',
    folderPath: '/Users/dev/work/storefront',
  }),
]

run('normalizes surrounding whitespace and case', () => {
  assert.equal(normalizeWorkspaceSearchQuery('  API  '), 'api')
})

run('matches workspace names case-insensitively', () => {
  assert.equal(workspaceMatchesSearch(workspaces[0], 'cleanup'), true)
  assert.equal(workspaceMatchesSearch(workspaces[0], 'missing'), false)
})

run('matches folder names and full paths', () => {
  assert.deepEqual(
    filterWorkspacesBySearchQuery(workspaces, 'acme-platform').map((workspace) => workspace.id),
    ['api'],
  )
  assert.deepEqual(
    filterWorkspacesBySearchQuery(workspaces, 'work/store').map((workspace) => workspace.id),
    ['brief'],
  )
})

run('matches workspace mode labels', () => {
  assert.deepEqual(
    filterWorkspacesBySearchQuery(workspaces, 'sprint engine').map((workspace) => workspace.id),
    ['swarm'],
  )
  assert.deepEqual(
    filterWorkspacesBySearchQuery(workspaces, 'guided brief').map((workspace) => workspace.id),
    ['brief'],
  )
})

run('empty searches preserve the original array reference', () => {
  assert.equal(filterWorkspacesBySearchQuery(workspaces, '   '), workspaces)
})

console.log('workspaceSearch.test.ts: ok')
