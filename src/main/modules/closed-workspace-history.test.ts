import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'vitest'

import { createModuleWorkspaceContextService, createModuleWorkspaceService } from './module-workspace-service'
import { createClosedWorkspaceHistory } from './closed-workspace-history'
import { createWorkspaceRegistryService } from '../workspace-registry-service'
import { createInMemoryWorkspaceRegistryStore } from '../workspace-registry-store'
import { createWorkspaceSyncService } from '../workspace-sync-service'

// Closing a workspace deletes its registry record, so the workspaces a module
// can list with `includeClosed` come from this history: what the registry said
// about each one the moment it left.

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'closed-workspaces-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const view = (id: string, folderPath: string | null = `/Users/dev/${id}`) => ({
  id,
  name: id.toUpperCase(),
  folderPath,
  mode: 'standard',
})

test('the first observation is a baseline: nothing is recorded as closed', () => {
  const history = createClosedWorkspaceHistory({ filePath: join(dir, 'closed.json') })
  history.observe([view('a'), view('b')])
  assert.deepEqual(history.list(), [])
})

test('a workspace that leaves the registry is recorded, newest first, and survives a restart', () => {
  let clock = 100
  const filePath = join(dir, 'closed.json')
  const history = createClosedWorkspaceHistory({ filePath, now: () => clock })
  history.observe([view('a'), view('b'), view('c', null)])
  history.observe([view('b'), view('c', null)])
  clock = 200
  history.observe([view('b')])
  assert.deepEqual(history.list(), [
    { ...view('c', null), closedAt: 200 },
    { ...view('a'), closedAt: 100 },
  ])
  assert.deepEqual(createClosedWorkspaceHistory({ filePath }).list(), history.list(), 'persisted to disk')
})

test('a workspace that comes back is no longer listed as closed', () => {
  const history = createClosedWorkspaceHistory({ filePath: join(dir, 'closed.json') })
  history.observe([view('a'), view('b')])
  history.observe([view('b')])
  assert.equal(history.list().length, 1)
  history.observe([view('a'), view('b')])
  assert.deepEqual(history.list(), [])
})

test('the history is bounded, keeping the newest', () => {
  let clock = 0
  const history = createClosedWorkspaceHistory({ filePath: join(dir, 'closed.json'), limit: 2, now: () => ++clock })
  history.observe([view('a'), view('b'), view('c')])
  history.observe([view('b'), view('c')])
  history.observe([view('c')])
  history.observe([])
  assert.deepEqual(
    history.list().map((record) => record.id),
    ['c', 'b'],
  )
})

test('a corrupt file reads as an empty history', async () => {
  const filePath = join(dir, 'closed.json')
  const { writeFileSync } = await import('node:fs')
  writeFileSync(filePath, '{ not json')
  assert.deepEqual(createClosedWorkspaceHistory({ filePath }).list(), [])
})

test('list({ includeClosed }) puts the closed workspaces after the open ones', async () => {
  let ids = 0
  const registry = createWorkspaceRegistryService({
    store: createInMemoryWorkspaceRegistryStore(),
    now: () => 1_000,
    newWorkspaceId: () => `ws-${++ids}`,
  })
  const workspaceSync = createWorkspaceSyncService({ registry, now: () => 1_000 })
  const creator = createModuleWorkspaceService({ workspaceSync })
  const history = createClosedWorkspaceHistory({ filePath: join(dir, 'closed.json'), now: () => 5_000 })
  const views = () =>
    workspaceSync.getSnapshot().state.workspaces.map((workspace) => ({
      id: workspace.id,
      name: workspace.name,
      folderPath: workspace.folderPath ?? null,
      mode: workspace.mode,
    }))
  history.observe(views())
  workspaceSync.subscribeEvents(() => history.observe(views()))
  const context = createModuleWorkspaceContextService({
    getWorkspaceSyncSnapshot: () => workspaceSync.getSnapshot(),
    listClosedWorkspaces: () => history.list(),
  })

  const kept = await creator.create({ name: 'Kept', folderPath: '/Users/dev/kept' })
  const gone = await creator.create({ name: 'Gone', folderPath: '/Users/dev/gone' })
  assert.ok(kept.ok && gone.ok)
  workspaceSync.removeWorkspace(gone.workspaceId, 'module')

  assert.deepEqual(await context.list(), [
    { id: kept.workspaceId, name: 'Kept', folderPath: '/Users/dev/kept', mode: 'standard', open: true },
  ])
  assert.deepEqual(await context.list({ includeClosed: true }), [
    { id: kept.workspaceId, name: 'Kept', folderPath: '/Users/dev/kept', mode: 'standard', open: true },
    {
      id: gone.workspaceId,
      name: 'Gone',
      folderPath: '/Users/dev/gone',
      mode: 'standard',
      open: false,
      closedAt: 5_000,
    },
  ])
})
