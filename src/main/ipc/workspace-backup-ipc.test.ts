import assert from 'node:assert/strict'

import type { WorkspaceBackupPayload } from '../../shared/electron-api'
import { registerWorkspaceBackupIpc, type WorkspaceBackupBridge } from './workspace-backup-ipc'
import { test } from 'vitest'

test('workspace-backup-ipc', async () => {
  type Handler = (event: unknown, input?: unknown) => Promise<unknown>

  function createIpcMain(): { handle(channel: string, handler: Handler): void; handlers: Map<string, Handler> } {
    const handlers = new Map<string, Handler>()
    return {
      handlers,
      handle(channel: string, handler: Handler): void {
        handlers.set(channel, handler)
      },
    }
  }

  async function main(): Promise<void> {
    const writeCalls: WorkspaceBackupPayload[] = []
    const bridge: WorkspaceBackupBridge = {
      write: async (payload) => {
        writeCalls.push(payload)
        return { ok: true }
      },
      read: async () => ({
        ok: true,
        payload: { version: 44, writtenAt: '2026-05-19T12:00:00.000Z', data: 'from-disk' },
      }),
    }

    const ipcMain = createIpcMain()
    registerWorkspaceBackupIpc(ipcMain as unknown as Parameters<typeof registerWorkspaceBackupIpc>[0], bridge)

    // 1. Both channels are registered.
    assert.ok(ipcMain.handlers.has('workspace-backup:write'))
    assert.ok(ipcMain.handlers.has('workspace-backup:read'))

    // 2. write channel forwards the payload to the bridge.
    const payload: WorkspaceBackupPayload = {
      version: 44,
      writtenAt: '2026-05-19T13:00:00.000Z',
      data: 'envelope',
    }
    const writeResult = (await ipcMain.handlers.get('workspace-backup:write')?.(null, payload)) as {
      ok: boolean
    }
    assert.equal(writeResult.ok, true)
    assert.equal(writeCalls.length, 1)
    assert.deepEqual(writeCalls[0], payload)

    // 3. read channel returns the bridge result verbatim.
    const readResult = (await ipcMain.handlers.get('workspace-backup:read')?.(null)) as {
      ok: boolean
      payload?: WorkspaceBackupPayload
    }
    assert.equal(readResult.ok, true)
    assert.equal(readResult.payload?.data, 'from-disk')

    // 4. write channel rejects malformed input without forwarding.
    const rejected = (await ipcMain.handlers.get('workspace-backup:write')?.(null, null)) as {
      ok: boolean
      message?: string
    }
    assert.equal(rejected.ok, false)
    assert.equal(rejected.message, 'invalid_payload')
    assert.equal(writeCalls.length, 1, 'malformed payload should NOT reach the bridge')

    console.log('workspace-backup-ipc.test.ts: ok')
  }

  const suiteRun = main().catch((error) => {
    console.error(error)
    process.exit(1)
  })

  await suiteRun
})
