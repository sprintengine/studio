import type { BrowserWindow, IpcMain, WebContents } from 'electron'

import { createPanePopOutBroker, type PanePopOutPeer, type PanePopOutWindowHandle } from '../pane-popout-broker'
import type { WindowBounds } from '../../shared/ipc/window'

// The Electron half of the pane pop-out (the rules are in pane-popout-broker.ts,
// where a test can reach them). A peer's identity is its WebContents: that is
// what an IPC event names as its sender, and what the broker compares.

type RegisterPanePopOutIpcOptions = {
  openWindow(input: { popOutId: string; workspaceId: string; bounds: WindowBounds | null }): BrowserWindow
  /** Only a workspace window has a pane to pop out of. */
  isWorkspaceWindow(contents: WebContents): boolean
  /** The window a WebContents belongs to, for bringing the owner forward. */
  windowOf(contents: WebContents): BrowserWindow | null
}

function peerOf(contents: WebContents): PanePopOutPeer {
  return {
    id: contents,
    isDestroyed: () => contents.isDestroyed(),
    send: (channel, payload) => {
      if (!contents.isDestroyed()) contents.send(channel, payload)
    },
  }
}

export type PanePopOutIpc = {
  /**
   * Whether `contents` may take over an existing terminal session's route:
   * any window but a pop-out, and a pop-out only for a terminal tab it holds
   * (pane-popout-broker's `mayAttachTerminal`).
   */
  mayAttachTerminal(contents: WebContents, sessionId: unknown): boolean
}

export function registerPanePopOutIpc(ipcMain: IpcMain, options: RegisterPanePopOutIpcOptions): PanePopOutIpc {
  // Owners whose reload and close are already watched: one pair of listeners
  // per window, however many panes it pops out.
  const watchedOwners = new WeakSet<WebContents>()

  const broker = createPanePopOutBroker({
    openWindow: (input) => {
      const win = options.openWindow(input)
      const contents = win.webContents
      win.on('closed', () => broker.windowClosed(input.popOutId))
      const handle: PanePopOutWindowHandle = {
        ...peerOf(contents),
        isDestroyed: () => win.isDestroyed() || contents.isDestroyed(),
        focus: () => {
          if (win.isDestroyed()) return
          if (win.isMinimized()) win.restore()
          win.focus()
        },
        close: () => {
          if (!win.isDestroyed()) win.close()
        },
      }
      return handle
    },
  })

  function watchOwner(owner: WebContents): void {
    if (watchedOwners.has(owner)) return
    watchedOwners.add(owner)
    // Closed, crashed or reloaded, the owner has lost its record of which tabs
    // are out, so the windows it opened go with it (the broker's `ownerGone`).
    // A reload is `did-navigate`: the app document is the only page a
    // workspace window may show (privileged-window-navigation.ts), so any
    // main-frame navigation is that document starting over.
    owner.once('destroyed', () => broker.ownerGone(owner))
    owner.on('did-navigate', () => broker.ownerGone(owner))
    owner.on('render-process-gone', () => broker.ownerGone(owner))
  }

  ipcMain.handle('pane-popout:open', (event, input: unknown) => {
    if (!options.isWorkspaceWindow(event.sender)) return { ok: false, message: 'not_a_workspace_window' }
    try {
      const result = broker.open(peerOf(event.sender), input)
      if (result.ok) watchOwner(event.sender)
      return result
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'open_pane_window_failed' }
    }
  })

  ipcMain.on('pane-popout:push', (event, input: unknown) => {
    broker.push(event.sender, input)
  })

  ipcMain.handle('pane-popout:get-state', (event, input: unknown) => broker.getState(event.sender, input))

  ipcMain.on('pane-popout:act', (event, input: unknown) => {
    const relayed = broker.act(event.sender, input)
    // A file opens in the owner's editor; the person picked it in the
    // pop-out, so the window that answers comes forward rather than changing
    // silently behind the one they are looking at.
    if (relayed?.action.type === 'open-file') options.windowOf(relayed.ownerId as WebContents)?.focus()
  })

  ipcMain.handle('pane-popout:focus', (event, input: unknown) => {
    broker.focus(event.sender, input)
  })

  ipcMain.handle('pane-popout:close', (event, input: unknown) => {
    broker.close(event.sender, input)
  })

  return {
    mayAttachTerminal: (contents, sessionId) =>
      !contents.isDestroyed() && broker.mayAttachTerminal(contents, sessionId),
  }
}
