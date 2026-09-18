import { isAbsolute } from 'node:path'
import { BrowserWindow, screen, shell, type IpcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { offerDockDiff, type DockDiffRequest } from './dock-diff'
import { isCanvasWorkerWindow } from '../canvas/canvas-worker-window'
import { safeExternalUrl } from './external-url'
import type { AuxWindowKind, DockDiffToWorkspaceResult, OpenAuxWindowResult } from '../../shared/electron-api'

const AUX_WINDOW_KINDS: readonly AuxWindowKind[] = ['diff', 'file']

type WindowState = {
  isMaximized: boolean
  isFullScreen: boolean
}

type WindowBounds = {
  x: number
  y: number
  width: number
  height: number
}

type WindowPlacement = {
  bounds: WindowBounds
  isMaximized: boolean
  displayId: number | null
}

function getWindowState(win: BrowserWindow): WindowState {
  return {
    isMaximized: win.isMaximized(),
    isFullScreen: win.isFullScreen(),
  }
}

function getWindowPlacement(win: BrowserWindow): WindowPlacement {
  const bounds = win.getNormalBounds()
  return {
    bounds,
    isMaximized: win.isMaximized(),
    displayId: screen.getDisplayMatching(bounds)?.id ?? null,
  }
}

export function sendWindowState(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  win.webContents.send('window:state-changed', getWindowState(win))
}

export function sendWindowPlacement(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  win.webContents.send('window:placement-changed', getWindowPlacement(win))
}

function getRequestWindow(event: IpcMainInvokeEvent): BrowserWindow | null {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win || win.isDestroyed()) return null
  return win
}

type RegisterWindowIpcOptions = {
  createWorkspaceWindow(input: { windowId: string; bounds?: WindowBounds | null; isMaximized?: boolean }): void
  confirmWindowClose(win: BrowserWindow): void
  openAuxWindow(input: {
    kind: AuxWindowKind
    singletonKey: string
    params: Record<string, string>
    bounds?: WindowBounds | null
  }): { retargeted: boolean }
  /** Membership of the aux-window registry. Only an aux window hands a diff
   *  back to the app, and the registry already knows which windows those are. */
  isAuxWindow(win: BrowserWindow): boolean
}

export function registerWindowIpc(ipcMain: IpcMain, options: RegisterWindowIpcOptions): void {
  ipcMain.handle('window:minimize', (event) => {
    getRequestWindow(event)?.minimize()
  })

  ipcMain.handle('window:toggle-maximize', (event) => {
    const win = getRequestWindow(event)
    if (!win) return null

    if (win.isFullScreen()) {
      win.setFullScreen(false)
    } else if (win.isMaximized()) {
      win.unmaximize()
    } else {
      win.maximize()
    }

    return getWindowState(win)
  })

  ipcMain.handle('window:close', (event) => {
    getRequestWindow(event)?.close()
  })

  ipcMain.handle('window:get-state', (event) => {
    const win = getRequestWindow(event)
    return win ? getWindowState(win) : null
  })

  ipcMain.handle('window:get-placement', (event) => {
    const win = getRequestWindow(event)
    return win ? getWindowPlacement(win) : null
  })

  ipcMain.handle('window:confirm-close', (event) => {
    const win = getRequestWindow(event)
    if (win) options.confirmWindowClose(win)
  })

  ipcMain.handle('window:open-external', async (_event, url: unknown) => {
    const safe = safeExternalUrl(url)
    if (!safe.ok) return safe
    try {
      await shell.openExternal(safe.url)
      return { ok: true }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Could not open link.' }
    }
  })

  ipcMain.handle(
    'window:dock-file',
    (
      event,
      input: {
        workspaceId?: unknown
        path?: unknown
        name?: unknown
      },
    ) => {
      const workspaceId = typeof input?.workspaceId === 'string' ? input.workspaceId : ''
      const path = typeof input?.path === 'string' ? input.path : ''
      const name = typeof input?.name === 'string' ? input.name : ''
      if (!workspaceId || !path || !name) return
      // Broadcast to every other window; only the one whose model owns the
      // workspace acts on it (others no-op), so we avoid tracking window ownership.
      const sender = BrowserWindow.fromWebContents(event.sender)
      for (const win of BrowserWindow.getAllWindows()) {
        if (win === sender || win.isDestroyed()) continue
        win.webContents.send('workspace:dock-file', { workspaceId, path, name })
      }
    },
  )

  // The diff window's "Show in the app". Shaped like a docked file, but it is a
  // HAND-OFF rather than a broadcast, and the difference is the whole point:
  // the diff window closes itself on the strength of this call, so a broadcast
  // that reached nobody left the person with neither the window nor the tab.
  //
  // Main still tracks no window ownership — the receiving renderer is the only
  // thing that knows which workspaces its model holds — so it ASKS, one window
  // at a time, most likely holder first, and stops at the first that says it
  // took the diff (`offerDockDiff`). Asking them all at once was the original
  // bug: acting on the request is what a window acks, so two windows holding
  // the same workspace both opened a Diff tab and both flipped the sticky
  // preference before either answer came back. Silence from all of them is
  // `accepted: false`, and the diff window stays up and says so.
  ipcMain.handle(
    'window:dock-diff',
    async (
      event,
      input: {
        workspaceId?: unknown
        repoRoot?: unknown
        focusPath?: unknown
        focusKind?: unknown
        changelistId?: unknown
      },
    ): Promise<DockDiffToWorkspaceResult> => {
      const workspaceId = typeof input?.workspaceId === 'string' ? input.workspaceId : ''
      const repoRoot = typeof input?.repoRoot === 'string' ? input.repoRoot : ''
      // A repo root is an absolute path or it is not a repo root. The receiving
      // window opens a Diff tab on this string and reads git through it, so a
      // relative one would resolve against whatever that process's cwd happens
      // to be.
      if (!workspaceId || !repoRoot || !isAbsolute(repoRoot)) return { accepted: false }
      const focusPath = typeof input?.focusPath === 'string' && input.focusPath ? input.focusPath : null
      const focusKind = input?.focusKind === 'staged' || input?.focusKind === 'unstaged' ? input.focusKind : null
      // The filter rides along as an opaque list id; the receiving pane looks it
      // up in the repository's own lists and shows all changes if it is gone.
      const changelistId =
        typeof input?.changelistId === 'string' && input.changelistId.trim() ? input.changelistId.trim() : null
      const sender = BrowserWindow.fromWebContents(event.sender)
      // Only an aux window hands a diff back; the registry already knows which
      // those are, so the check costs a Map scan.
      if (!sender || !options.isAuxWindow(sender)) return { accepted: false }
      const windows = dockDiffCandidates(sender, options.isAuxWindow)
      if (windows.length === 0) return { accepted: false }

      const accepted = await offerDockDiff({
        targets: windows.map((win) => ({
          id: win,
          isDestroyed: () => win.isDestroyed(),
          send: (request: DockDiffRequest) => win.webContents.send('workspace:dock-diff', request),
        })),
        payload: { workspaceId, repoRoot, focusPath, focusKind, changelistId },
        subscribe: (listener) => {
          // The ack's SENDER, resolved here rather than trusted from the message:
          // `offerDockDiff` compares it with the window it asked, so a window
          // acking a hand-off it was never sent is ignored.
          const onAck = (ackEvent: IpcMainEvent, id: unknown): void => {
            listener(BrowserWindow.fromWebContents(ackEvent.sender), id)
          }
          ipcMain.on('window:dock-diff-ack', onAck)
          return () => ipcMain.removeListener('window:dock-diff-ack', onAck)
        },
      })
      return { accepted }
    },
  )

  ipcMain.handle(
    'window:open-aux-window',
    (
      _event,
      input: {
        kind?: unknown
        singletonKey?: unknown
        params?: unknown
        bounds?: unknown
      },
    ): OpenAuxWindowResult => {
      const kind = AUX_WINDOW_KINDS.find((candidate) => candidate === input?.kind)
      if (!kind) return { ok: false, message: 'invalid_aux_window_kind' }
      const singletonKey = typeof input?.singletonKey === 'string' ? input.singletonKey.trim() : ''
      if (!singletonKey) return { ok: false, message: 'missing_singleton_key' }
      const params = normalizeStringParams(input?.params)
      try {
        const { retargeted } = options.openAuxWindow({
          kind,
          singletonKey,
          params,
          bounds: normalizeWindowBounds(input?.bounds),
        })
        return { ok: true, retargeted }
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : 'open_aux_window_failed',
        }
      }
    },
  )

  ipcMain.handle(
    'window:create-workspace-window',
    (
      _event,
      input: {
        windowId?: unknown
        bounds?: unknown
        isMaximized?: unknown
      },
    ) => {
      const windowId = typeof input?.windowId === 'string' ? input.windowId.trim() : ''
      if (!windowId) return { ok: false, message: 'missing_window_id' }
      try {
        options.createWorkspaceWindow({
          windowId,
          bounds: normalizeWindowBounds(input.bounds),
          isMaximized: input.isMaximized === true,
        })
        return { ok: true, windowId }
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : 'create_window_failed',
        }
      }
    },
  )
}

/**
 * The windows a diff can be handed to, in the order to ask them.
 *
 * Aux windows are out: only a workspace window has a pane to put a Diff tab in,
 * and the diff window asking its own siblings is asking nobody. Of the rest the
 * FOCUSED one goes first — it is the window the person is looking at, and the
 * one they meant by "the app" — and the others follow newest first, which is
 * the closest thing to "most recently used" that `getAllWindows` (creation
 * order) can be turned into without main tracking focus itself.
 *
 * The hidden canvas worker is out for the same reason as an aux window and one
 * worse: it has no pane, and it never answers. Each ask spends a per-window
 * slice of `offerDockDiff`'s budget waiting for an ack that cannot come, and
 * being created lazily it sorts NEWEST — so it would be asked first and, with
 * two workspace windows open, the third ask would never happen and the person
 * would be told nobody took the diff. The test stays here rather than in
 * `dock-diff.ts`, which is deliberately free of electron.
 */
function dockDiffCandidates(sender: BrowserWindow, isAuxWindow: (win: BrowserWindow) => boolean): BrowserWindow[] {
  const candidates = BrowserWindow.getAllWindows().filter(
    (win) => win !== sender && !win.isDestroyed() && !isAuxWindow(win) && !isCanvasWorkerWindow(win),
  )
  const focused = BrowserWindow.getFocusedWindow()
  const rest = candidates.filter((win) => win !== focused).reverse()
  return focused && candidates.includes(focused) ? [focused, ...rest] : rest
}

function normalizeStringParams(input: unknown): Record<string, string> {
  if (!input || typeof input !== 'object') return {}
  const params: Record<string, string> = {}
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value === 'string') params[key] = value
  }
  return params
}

function normalizeWindowBounds(input: unknown): WindowBounds | null {
  if (!input || typeof input !== 'object') return null
  const bounds = input as Partial<WindowBounds>
  const x = bounds.x
  const y = bounds.y
  const width = bounds.width
  const height = bounds.height
  if (
    typeof x !== 'number' ||
    typeof y !== 'number' ||
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height)
  ) {
    return null
  }
  return { x, y, width, height }
}
