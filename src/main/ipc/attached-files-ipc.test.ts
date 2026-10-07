import type { IpcMain } from 'electron'
import { expect, test, vi } from 'vitest'

// A window's contents answer `fromWebContents`; a webview guest's do not.
vi.mock('electron', () => ({
  BrowserWindow: {
    fromWebContents: (contents: { inWindow?: boolean } | null) => (contents?.inWindow ? {} : null),
  },
}))

const { registerAttachedFilesIpc } = await import('./attached-files-ipc')

const APP_URL = 'file:///Applications/SprintEngine%20Studio.app/Contents/Resources/app.asar/out/renderer/index.html'

function harness() {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const files = {
    register: vi.fn(),
    preview: vi.fn(async () => ({ kind: 'file' as const, thumbnailDataUrl: null, openable: true })),
    open: vi.fn(async () => undefined),
  }
  registerAttachedFilesIpc(
    { handle: (channel: string, handler: never) => handlers.set(channel, handler) } as unknown as IpcMain,
    files,
  )
  const invoke = (channel: string, sender: { url: string; parent?: object | null }, ...args: unknown[]) =>
    handlers.get(channel)!(
      { sender: { inWindow: true }, senderFrame: { url: sender.url, parent: sender.parent ?? null } },
      ...args,
    )
  return { invoke, files }
}

test('the app’s own window registers, previews and opens attached files', async () => {
  const { invoke, files } = harness()
  await invoke('attached-files:register', { url: APP_URL }, '/Users/dev/report.pdf')
  await invoke('attached-files:preview', { url: APP_URL }, '/Users/dev/report.pdf')
  await invoke('attached-files:open', { url: APP_URL }, '/Users/dev/report.pdf')
  expect(files.register).toHaveBeenCalledWith('/Users/dev/report.pdf')
  expect(files.preview).toHaveBeenCalledWith('/Users/dev/report.pdf')
  expect(files.open).toHaveBeenCalledWith('/Users/dev/report.pdf')
})

test('an embedded page holding the preload can neither grow the list nor open from it', async () => {
  const { invoke, files } = harness()
  for (const sender of [{ url: APP_URL, parent: {} }, { url: 'https://example.com/' }]) {
    await expect(async () => invoke('attached-files:register', sender, '/Users/dev/payload.pdf')).rejects.toThrow(
      'did not come from a SprintEngine Studio window',
    )
    await expect(async () => invoke('attached-files:open', sender, '/Users/dev/payload.pdf')).rejects.toThrow(
      'did not come from a SprintEngine Studio window',
    )
  }
  expect(files.register).not.toHaveBeenCalled()
  expect(files.open).not.toHaveBeenCalled()
})
