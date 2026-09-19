import assert from 'node:assert/strict'
import { test } from 'vitest'
import { createModuleWorkspaceContextService, createModuleWorkspaceService } from './module-workspace-service'
import { createWorkspaceRegistryService } from '../workspace-registry-service'
import { createInMemoryWorkspaceRegistryStore } from '../workspace-registry-store'
import { createWorkspaceSyncService } from '../workspace-sync-service'
import { AUTOMATIONS_HOST_WORKSPACE_MODE } from '../../shared/workspace-mode'

// The delegate-then-poll shape these tests used to assert is gone:
// there is no renderer round trip to observe and no bus confirmation to time
// out, because the id a module gets back is the one main just committed.

function harness() {
  let ids = 0
  const registry = createWorkspaceRegistryService({
    store: createInMemoryWorkspaceRegistryStore(),
    now: () => 1_000,
    newWorkspaceId: () => `ws-${++ids}`,
  })
  const workspaceSync = createWorkspaceSyncService({ registry, now: () => 1_000 })
  return { registry, workspaceSync, service: createModuleWorkspaceService({ workspaceSync }) }
}

test('a module create mints the workspace in main with no window open', async () => {
  const { registry, service } = harness()
  const result = await service.create({ name: 'Demo', folderPath: '/tmp/demo', templateId: '  ' })
  assert.deepEqual(result, { ok: true, workspaceId: 'ws-1' })

  const record = registry.getRecord('ws-1')
  assert.ok(record, 'the id a module is handed is readable from the registry immediately')
  assert.equal(record.name, 'Demo')
  assert.equal(record.folderPath, '/tmp/demo')
  // A blank templateId falls through to the default template rather than failing.
  assert.equal(record.templateId, 'solo')
})

test('a module create of a folder’s host reuses the existing one', async () => {
  const { registry, service } = harness()
  const first = await service.create({ folderPath: '/repo', mode: AUTOMATIONS_HOST_WORKSPACE_MODE })
  const second = await service.create({ folderPath: '/repo', mode: AUTOMATIONS_HOST_WORKSPACE_MODE })
  assert.ok(first.ok && second.ok)
  assert.equal(second.workspaceId, first.workspaceId)
  assert.equal(registry.getRecords().length, 1)
})

test('workspace context resolves a record main holds, and null for an unknown id', async () => {
  const { workspaceSync, service } = harness()
  const created = await service.create({ name: 'Context', folderPath: '/repo' })
  assert.ok(created.ok)
  const context = createModuleWorkspaceContextService({
    getWorkspaceSyncSnapshot: () => workspaceSync.getSnapshot(),
  })
  assert.deepEqual(await context.get(created.workspaceId), {
    id: created.workspaceId,
    name: 'Context',
    folderPath: '/repo',
    mode: 'standard',
  })
  assert.equal(await context.get('nope'), null)
})

console.log('module-workspace-service.test.ts: ok')
