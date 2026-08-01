import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { AutomationRendererRequest, AutomationRendererResponse } from '../../shared/automation'
import type { WorkspaceSyncSnapshot } from '../../shared/workspace-sync'
import { createModuleWorkspaceContextService, createModuleWorkspaceService } from './module-workspace-service'

function snapshotWith(ids: string[]): WorkspaceSyncSnapshot {
  return {
    state: {
      workspaces: ids.map((id) => ({ id })),
    },
  } as unknown as WorkspaceSyncSnapshot
}

test('delegates to the renderer and confirms via the sync bus', async () => {
  const requests: AutomationRendererRequest[] = []
  let present: string[] = []
  const service = createModuleWorkspaceService({
    delegateToRenderer: async (request): Promise<AutomationRendererResponse> => {
      requests.push(request)
      // The workspace appears on the bus right after the renderer answers.
      present = ['ws-1']
      return { ok: true, workspaceId: 'ws-1' }
    },
    getWorkspaceSyncSnapshot: () => snapshotWith(present),
    now: () => 0,
    sleep: async () => {},
  })

  const result = await service.create({ name: 'Demo', folderPath: '/tmp/demo', templateId: '  ' })
  assert.deepEqual(result, { ok: true, workspaceId: 'ws-1' })
  assert.equal(requests.length, 1)
  assert.deepEqual(requests[0], {
    kind: 'workspace.create',
    name: 'Demo',
    folderPath: '/tmp/demo',
    // Blank templateId is normalized away so the default template is used.
    templateId: undefined,
  })
})

test('propagates a renderer failure', async () => {
  const service = createModuleWorkspaceService({
    delegateToRenderer: async (): Promise<AutomationRendererResponse> => ({
      ok: false,
      code: 'no_primary_window',
      message: 'No window.',
    }),
    getWorkspaceSyncSnapshot: () => snapshotWith([]),
  })
  const result = await service.create({})
  assert.deepEqual(result, { ok: false, code: 'no_primary_window', message: 'No window.' })
})

test('reports an unverified creation when the bus never confirms', async () => {
  let clock = 0
  const service = createModuleWorkspaceService({
    delegateToRenderer: async (): Promise<AutomationRendererResponse> => ({ ok: true, workspaceId: 'ws-x' }),
    // The workspace never shows up on the bus.
    getWorkspaceSyncSnapshot: () => snapshotWith([]),
    now: () => clock,
    sleep: async () => {
      clock += 1000
    },
  })
  const result = await service.create({ name: 'Ghost' })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.code, 'bus_confirmation_timeout')
})

// WorkspaceContextToken contract: id → read-only {id, name, folderPath, mode}
// view from the same sync snapshot; unknown ids are null, never a throw, and
// a folderless workspace reports folderPath: null.
test('workspace context resolves the read-only view or null', async () => {
  const context = createModuleWorkspaceContextService({
    getWorkspaceSyncSnapshot: () =>
      ({
        state: {
          workspaces: [
            { id: 'ws-1', name: 'Calendar sprint', folderPath: '/repos/calendar', mode: 'calendar' },
            { id: 'ws-2', name: 'Scratch', folderPath: null, mode: 'standard' },
          ],
        },
      }) as unknown as WorkspaceSyncSnapshot,
  })
  assert.deepEqual(await context.get('ws-1'), {
    id: 'ws-1',
    name: 'Calendar sprint',
    folderPath: '/repos/calendar',
    mode: 'calendar',
  })
  assert.deepEqual(await context.get('ws-2'), { id: 'ws-2', name: 'Scratch', folderPath: null, mode: 'standard' })
  assert.equal(await context.get('ws-missing'), null)
})

// Post-restart routing placeholders (folder path not yet re-hydrated) resolve
// null — "not currently resolvable" — rather than attesting folderPath: null
// as a folderless workspace. A placeholder that DID persist its folder path
// serves real data.
test('workspace context reports unhydrated routing placeholders as unresolvable', async () => {
  const context = createModuleWorkspaceContextService({
    getWorkspaceSyncSnapshot: () =>
      ({
        state: {
          workspaces: [
            { id: 'ws-stale', name: 'ws-stale', folderPath: null, mode: 'standard', templateId: 'workspace-sync-routing-placeholder' },
            { id: 'ws-hydrated', name: 'Calendar', folderPath: '/repos/calendar', mode: 'calendar', templateId: 'workspace-sync-routing-placeholder' },
          ],
        },
      }) as unknown as WorkspaceSyncSnapshot,
  })
  assert.equal(await context.get('ws-stale'), null)
  assert.deepEqual(await context.get('ws-hydrated'), {
    id: 'ws-hydrated',
    name: 'Calendar',
    folderPath: '/repos/calendar',
    mode: 'calendar',
  })
})
