import assert from 'node:assert/strict'

import { restoreDetachedWorkspaceWindowsOnStartup } from './workspaceWindowRestore'
import type { CreateWorkspaceWindowInput, CreateWorkspaceWindowResult } from '../../../../shared/electron-api'

const primaryWindow = {
  id: 'primary',
  activeWorkspaceId: 'ws-primary',
  bounds: null,
  isMaximized: false,
}

const detachedWindow = {
  id: 'detached-1',
  activeWorkspaceId: 'ws-detached',
  bounds: { x: 120, y: 80, width: 1000, height: 700 },
  isMaximized: true,
}

const createCalls: CreateWorkspaceWindowInput[] = []
const collapsed: Array<{ windowId: string; fallbackWindowId: string }> = []
let createResult: CreateWorkspaceWindowResult = { ok: true, windowId: 'detached-1' }

const success = await restoreDetachedWorkspaceWindowsOnStartup({
  primaryWorkspaceWindowId: 'primary',
  workspaceWindows: [primaryWindow, detachedWindow],
  createWorkspaceWindow: async (input) => {
    createCalls.push(input)
    return createResult
  },
  closeWorkspaceWindow: (windowId, fallbackWindowId) => collapsed.push({ windowId, fallbackWindowId }),
})

assert.deepEqual(success.restoredWindowIds, ['detached-1'])
assert.deepEqual(success.collapsedWindowIds, [])
assert.equal(createCalls.length, 1)
assert.equal(createCalls[0]?.windowId, 'detached-1')
assert.equal(createCalls[0]?.workspaceId, 'ws-detached')
assert.deepEqual(createCalls[0]?.bounds, { x: 120, y: 80, width: 1000, height: 700 })
assert.equal(createCalls[0]?.isMaximized, true)
assert.equal(collapsed.length, 0, 'successful restore does not collapse detached ownership to primary')

createCalls.length = 0
collapsed.length = 0
createResult = { ok: false, message: 'create_window_failed' }

const fallback = await restoreDetachedWorkspaceWindowsOnStartup({
  primaryWorkspaceWindowId: 'primary',
  workspaceWindows: [primaryWindow, detachedWindow],
  createWorkspaceWindow: async (input) => {
    createCalls.push(input)
    return createResult
  },
  closeWorkspaceWindow: (windowId, fallbackWindowId) => collapsed.push({ windowId, fallbackWindowId }),
})

assert.deepEqual(fallback.restoredWindowIds, [])
assert.deepEqual(fallback.collapsedWindowIds, ['detached-1'])
assert.deepEqual(collapsed, [{ windowId: 'detached-1', fallbackWindowId: 'primary' }])

console.log('WorkspaceManager.restore.test.ts: ok')
