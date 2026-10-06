import assert from 'node:assert/strict'

import { test } from 'vitest'

import type { BrowserManager } from '../browser/browser-manager'
import { registerBrowserIpc } from './browser-ipc'

// Which tab the person is looking at is each window's to say for the tabs it
// hosts: a pane showing a terminal does not clear a page out in a pop-out.

test('a window saying it shows no browser tab does not clear a tab another window hosts', async () => {
  const handlers = new Map<string, (event: unknown, input: unknown) => unknown>()
  const ipcMain = {
    handle: (channel: string, fn: (event: unknown, input: unknown) => unknown) => handlers.set(channel, fn),
  }
  const main = { id: 1 }
  const popOut = { id: 2 }
  const hosts = new Map<string, unknown>([
    ['docked', main],
    ['out', popOut],
  ])
  let noted: string | null = null
  const manager = {
    hostOf: (tabId: string) => hosts.get(tabId) ?? null,
    noteActive: (_workspaceId: string, tabId: string | null) => {
      noted = tabId
    },
    notedActive: () => noted,
  } as unknown as BrowserManager
  registerBrowserIpc(ipcMain as unknown as Parameters<typeof registerBrowserIpc>[0], manager, {
    stop: async () => {},
  } as never)
  const note = (sender: unknown, tabId: string | null) =>
    handlers.get('browser:note-active')!({ sender }, { workspaceId: 'ws-1', tabId })

  await note(popOut, 'out')
  await note(main, null)
  assert.equal(noted, 'out', 'the pop-out’s page stays the one named')

  // The pane named its own docked tab, then moved to a terminal: that is its
  // to clear.
  await note(main, 'docked')
  await note(main, null)
  assert.equal(noted, null)
})
