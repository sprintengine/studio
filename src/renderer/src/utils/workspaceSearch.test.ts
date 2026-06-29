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
  makeWorkspace('board', {
    name: 'Triage queue',
    mode: 'switchboard',
    folderPath: '/Users/dev/work/inbox-app',
  }),
  makeWorkspace('loop', {
    name: 'Roadmap planning',
    mode: 'multiloop',
    folderPath: '/Users/dev/work/roadmap-app',
  }),
  makeWorkspace('plugin', {
    name: 'Experimental surface',
    mode: 'future-plugin-mode' as Workspace['mode'],
    folderPath: '/Users/dev/work/plugin-app',
  }),
]

const hostWorkspace = makeWorkspace('host', {
  name: 'Automations host',
  mode: 'automations-host' as Workspace['mode'],
  folderPath: '/Users/dev/work/acme-platform',
})

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

run('matches workspace mode labels from the registry', () => {
  // Registry-sourced label + searchTerms preserve the prior hardcoded matches.
  assert.deepEqual(
    filterWorkspacesBySearchQuery(workspaces, 'sprint engine').map((workspace) => workspace.id),
    ['swarm'],
  )
  assert.deepEqual(
    filterWorkspacesBySearchQuery(workspaces, 'sprintengine').map((workspace) => workspace.id),
    ['swarm'],
  )
  assert.deepEqual(
    filterWorkspacesBySearchQuery(workspaces, 'guided brief').map((workspace) => workspace.id),
    ['brief'],
  )
  assert.deepEqual(
    filterWorkspacesBySearchQuery(workspaces, 'switchboard').map((workspace) => workspace.id),
    ['board'],
  )
  assert.deepEqual(
    filterWorkspacesBySearchQuery(workspaces, 'multiloop').map((workspace) => workspace.id),
    ['loop'],
  )
})

run('matches the raw mode id for an unregistered type', () => {
  assert.deepEqual(
    filterWorkspacesBySearchQuery(workspaces, 'future-plugin-mode').map((workspace) => workspace.id),
    ['plugin'],
  )
})

run('empty searches preserve the original array reference', () => {
  assert.equal(filterWorkspacesBySearchQuery(workspaces, '   '), workspaces)
})

run('rail-hidden automations host is never a search match', () => {
  // Matches the host name, its folder, and an empty query — none may return it.
  assert.equal(workspaceMatchesSearch(hostWorkspace, 'automations'), false)
  assert.equal(workspaceMatchesSearch(hostWorkspace, 'acme-platform'), false)
  assert.equal(workspaceMatchesSearch(hostWorkspace, ''), false)
})

run('filter drops the rail-hidden host for empty and non-empty queries', () => {
  const withHost = [...workspaces, hostWorkspace]
  // Empty query: every visible workspace, never the host.
  assert.deepEqual(
    filterWorkspacesBySearchQuery(withHost, '   ').map((workspace) => workspace.id),
    workspaces.map((workspace) => workspace.id),
  )
  // A query the host's folder would otherwise match still excludes the host.
  assert.deepEqual(
    filterWorkspacesBySearchQuery(withHost, 'acme-platform').map((workspace) => workspace.id),
    ['api'],
  )
})

console.log('workspaceSearch.test.ts: ok')
