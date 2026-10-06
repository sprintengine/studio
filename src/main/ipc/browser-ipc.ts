import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import type { BrowserCaptureInput, BrowserRegisterInput } from '../../shared/browser'
import type { BrowserManager } from '../browser/browser-manager'
import type { BrowserRecorder } from '../browser/browser-recorder'

// The embedded browser's IPC (browser-pane epic). Every handler resolves the
// tab by id through the manager, which refuses ids it never adopted; the
// registering call binds the guest to the window that sent it.

function tabIdOf(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null
  const tabId = (input as { tabId?: unknown }).tabId
  return typeof tabId === 'string' && tabId.length > 0 ? tabId : null
}

export function registerBrowserIpc(
  ipcMain: IpcMain,
  manager: BrowserManager,
  recorder: Pick<BrowserRecorder, 'stop'>,
): void {
  ipcMain.handle('browser:config', (_event, input: unknown) => {
    const workspaceId = (input as { workspaceId?: unknown } | null)?.workspaceId
    return manager.getConfig(typeof workspaceId === 'string' && workspaceId ? workspaceId : undefined)
  })

  ipcMain.handle('browser:register', (event: IpcMainInvokeEvent, input: BrowserRegisterInput) => {
    if (
      !input ||
      typeof input.tabId !== 'string' ||
      typeof input.workspaceId !== 'string' ||
      typeof input.webContentsId !== 'number'
    ) {
      return { ok: false, reason: 'unknown_webcontents' }
    }
    return manager.register(input, event.sender)
  })

  // Sender-scoped like the note below: only the window hosting the tab's guest
  // lets it go. A browser tab moves between windows — popped out of its pane
  // and docked back — and the window it left unmounts its panel and asks to
  // unregister; arriving after the new window registered, that request would
  // have torn down the guest the tab had just moved into.
  ipcMain.handle('browser:unregister', (event: IpcMainInvokeEvent, input: { tabId: string }) => {
    const tabId = tabIdOf(input)
    if (!tabId) return
    const host = manager.hostOf(tabId)
    if (host && host !== event.sender) return
    manager.unregister(tabId)
  })

  // The renderer's word on which tab the person is looking at: what a
  // `browser.*` tool acts on when the agent names none. Sender-scoped: only a
  // window that hosts the tab may claim it.
  ipcMain.handle(
    'browser:note-active',
    (event: IpcMainInvokeEvent, input: { workspaceId: string; tabId: string | null }) => {
      if (typeof input?.workspaceId !== 'string') return
      const tabId = typeof input.tabId === 'string' ? input.tabId : null
      // The note usually lands before the tab's guest has registered (the strip
      // selects the tab the moment it is created); an unknown tab is accepted
      // and only takes effect once a guest registers under it. A KNOWN tab must
      // be this window's — `activeTab` also checks the workspace it belongs to.
      const host = tabId ? manager.hostOf(tabId) : null
      if (host && host !== event.sender) return
      // "None" is only this window's to say over a tab it hosts: a page out in
      // a pop-out window stays the one named while the pane shows a terminal.
      if (!tabId) {
        const noted = manager.notedActive(input.workspaceId)
        const notedHost = noted ? manager.hostOf(noted) : null
        if (notedHost && notedHost !== event.sender) return
      }
      manager.noteActive(input.workspaceId, tabId)
    },
  )

  ipcMain.handle('browser:navigate', (_event, input: { tabId: string; url: string }) => {
    const tabId = tabIdOf(input)
    if (!tabId || typeof input.url !== 'string') return false
    return manager.navigate(tabId, input.url)
  })

  ipcMain.handle('browser:back', (_event, input: { tabId: string }) => {
    const tabId = tabIdOf(input)
    return tabId ? manager.back(tabId) : false
  })

  ipcMain.handle('browser:forward', (_event, input: { tabId: string }) => {
    const tabId = tabIdOf(input)
    return tabId ? manager.forward(tabId) : false
  })

  ipcMain.handle('browser:reload', (_event, input: { tabId: string; ignoreCache?: boolean }) => {
    const tabId = tabIdOf(input)
    return tabId ? manager.reload(tabId, input.ignoreCache === true) : false
  })

  ipcMain.handle('browser:stop', (_event, input: { tabId: string }) => {
    const tabId = tabIdOf(input)
    return tabId ? manager.stop(tabId) : false
  })

  ipcMain.handle('browser:zoom-step', (_event, input: { tabId: string; direction: 1 | -1 | 0 }) => {
    const tabId = tabIdOf(input)
    const direction = input.direction === 1 || input.direction === -1 ? input.direction : 0
    return tabId ? manager.zoomStep(tabId, direction) : false
  })

  ipcMain.handle('browser:set-color-scheme', (_event, input: { tabId: string; scheme: string }) => {
    const tabId = tabIdOf(input)
    const scheme = input.scheme === 'light' || input.scheme === 'dark' ? input.scheme : 'system'
    return tabId ? manager.setColorScheme(tabId, scheme) : false
  })

  ipcMain.handle('browser:open-devtools', (_event, input: { tabId: string }) => {
    const tabId = tabIdOf(input)
    return tabId ? manager.openDevTools(tabId) : false
  })

  ipcMain.handle('browser:open-window', (_event, input: { tabId: string }) => {
    const tabId = tabIdOf(input)
    return tabId ? manager.openWindow(tabId) : false
  })

  ipcMain.handle('browser:clear-cookies', () => manager.clearCookies())
  ipcMain.handle('browser:clear-cache', () => manager.clearCache())

  ipcMain.handle('browser:capture', (_event, input: BrowserCaptureInput) => {
    if (!tabIdOf(input)) return { ok: false, message: 'The capture request was incomplete.' }
    const rect =
      input.rect &&
      typeof input.rect === 'object' &&
      ['x', 'y', 'width', 'height'].every((key) => Number.isFinite((input.rect as Record<string, unknown>)[key]))
        ? input.rect
        : undefined
    return manager.captureScreenshot({
      tabId: input.tabId,
      kind: input.kind === 'element' ? 'element' : 'screenshot',
      ...(rect ? { rect } : {}),
    })
  })

  ipcMain.handle('browser:copy-screenshot', (_event, input: { tabId: string }) => {
    const tabId = tabIdOf(input)
    return tabId ? manager.copyScreenshot(tabId) : { ok: false, message: 'This browser tab is gone.' }
  })

  ipcMain.handle('browser:open-external', (_event, input: { tabId: string }) => {
    const tabId = tabIdOf(input)
    return tabId ? manager.openExternal(tabId) : { ok: false, message: 'This browser tab is gone.' }
  })

  // The person's Stop on a recording an agent started. Sender-scoped like the
  // active-tab note: only the window showing the tab may stop it.
  ipcMain.handle('browser:recording-stop-request', async (event: IpcMainInvokeEvent, input: { tabId: string }) => {
    const tabId = tabIdOf(input)
    if (!tabId || manager.hostOf(tabId) !== event.sender) return false
    const stopped = await recorder.stop({ tabId, owner: null, reason: 'stopped_by_person' })
    return stopped.ok
  })

  ipcMain.handle('browser:local-servers', (_event, input: { workspaceId: string }) => {
    const workspaceId = input && typeof input.workspaceId === 'string' ? input.workspaceId : ''
    return workspaceId ? manager.listLocalServers(workspaceId) : []
  })
}
