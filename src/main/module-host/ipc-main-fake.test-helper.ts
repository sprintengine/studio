import type { IpcMain, IpcMainInvokeEvent } from 'electron'

import type { IpcInvokeHandler } from './main-host'

// Shared IpcMain fake for module-host tests. Records the cumulative order of
// handled channels (registration assertions) and retains live handlers so
// dispatcher tests can invoke them in-process.
export type FakeIpcMain = {
  ipcMain: IpcMain
  /** Every channel ever handled, in registration order; removal does not erase history. */
  handled: string[]
  /** Invoke a currently-registered handler the way ipcMain.handle would. */
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
}

export function createFakeIpcMain(): FakeIpcMain {
  const handled: string[] = []
  const handlers = new Map<string, IpcInvokeHandler>()
  const ipcMain = {
    handle(channel: string, handler: IpcInvokeHandler): void {
      handled.push(channel)
      handlers.set(channel, handler)
    },
    removeHandler(channel: string): void {
      handlers.delete(channel)
    },
  } as unknown as IpcMain
  return {
    ipcMain,
    handled,
    async invoke(channel, ...args) {
      const handler = handlers.get(channel)
      if (!handler) throw new Error(`No handler for "${channel}".`)
      return handler({} as IpcMainInvokeEvent, ...args)
    },
  }
}
