import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { AutomationRendererRequest, AutomationRendererResponse } from '../../shared/automation'
import type { WorkspaceSyncSnapshot } from '../../shared/workspace-sync'
import { createModuleWorkspaceService } from './module-workspace-service'

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
