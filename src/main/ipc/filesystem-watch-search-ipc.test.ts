import { EventEmitter } from 'node:events'
import { expect, test, vi } from 'vitest'
import type { IpcMain } from 'electron'
import type { WatchHub } from '../workspace-watch-hub'

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))
import { registerFilesystemWatchSearchIpc } from './filesystem-watch-search-ipc'

test('search cancellation preserves its channel and sender destruction cancels every channel', async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const ipc = { handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler) }
  const cancelActiveFileSearch = vi.fn()
  const cancelAllFileSearches = vi.fn()
  const cancelActiveContentSearch = vi.fn()
  registerFilesystemWatchSearchIpc(ipc as unknown as IpcMain, {
    pathExists: async () => true,
    isMissingPathError: () => false,
    searchFiles: vi.fn(async () => ({
      ok: true as const,
      results: [],
      truncated: false,
      engine: 'walker' as const,
      elapsedMs: 0,
      resultCount: 0,
    })),
    searchContent: vi.fn(async () => ({
      ok: true as const,
      results: [],
      truncated: false,
      engine: 'ripgrep' as const,
      elapsedMs: 0,
      resultCount: 0,
    })),
    cancelActiveFileSearch,
    cancelAllFileSearches,
    cancelActiveContentSearch,
    watchHub: {} as WatchHub,
  })
  const sender = Object.assign(new EventEmitter(), { id: 42 })
  for (const channel of ['mention-a', 'mention-b'])
    await handlers.get('fs:search-files')!({ sender }, { rootPath: '/workspace', query: 'file', channel })
  handlers.get('fs:cancel-file-search')!({ sender }, 'mention-a')
  expect(cancelActiveFileSearch).toHaveBeenCalledWith(42, 'mention-a')
  expect(sender.listenerCount('destroyed')).toBe(1)
  sender.emit('destroyed')
  expect(cancelAllFileSearches).toHaveBeenCalledExactlyOnceWith(42)
  expect(cancelActiveContentSearch).toHaveBeenCalledExactlyOnceWith(42)
})
