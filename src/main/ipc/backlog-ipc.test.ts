import assert from 'node:assert/strict'

import { registerBacklogIpc } from './backlog-ipc'

type Handler = (_event: unknown, ...args: unknown[]) => Promise<unknown>

function createIpcMain(): { handle(channel: string, handler: Handler): void; handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>()
  return {
    handlers,
    handle(channel, handler): void {
      handlers.set(channel, handler)
    },
  }
}

async function main(): Promise<void> {
  const ipcMain = createIpcMain()
  registerBacklogIpc(ipcMain as unknown as Parameters<typeof registerBacklogIpc>[0])

  for (const channel of [
    'backlog:read-object-store',
    'backlog:ensure-object-records',
    'backlog:update-status',
    'backlog:update-triage',
    'backlog:add-or-update-link',
    'backlog:update-module-metadata',
    'backlog:move-object-source',
    'backlog:remove-object-record',
    'backlog:update-dependencies',
    'backlog:update-mockups',
  ]) {
    assert.ok(ipcMain.handlers.has(channel), `${channel} should be registered`)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
