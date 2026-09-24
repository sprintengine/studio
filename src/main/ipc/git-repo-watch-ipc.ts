import { app, BrowserWindow, type IpcMain, type WebContents } from 'electron'
import { checkoutKey, createGitRepoWatch, type GitCheckoutChange, type GitRepoWatch } from '../git-repo-watch'
import { invalidateCheckoutSummary } from '../workspace-change-summary'

/**
 * The renderer's side of git-repo-watch.ts: a window retains the checkouts it
 * shows and is sent `git:checkout-changed` for those, and only those.
 *
 * Each window's retains are counted here per checkout, so a window that
 * closes (or reloads) without releasing gives its share back on `destroyed`.
 */

let sharedWatch: GitRepoWatch | null = null
const retainsBySender = new Map<number, Map<string, number>>()

function sendersFor(key: string): WebContents[] {
  const senders: WebContents[] = []
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed() || window.webContents.isDestroyed()) continue
    if ((retainsBySender.get(window.webContents.id)?.get(key) ?? 0) > 0) senders.push(window.webContents)
  }
  return senders
}

function deliver(changes: GitCheckoutChange[]): void {
  // The held sidebar reading for a checkout that moved is dropped first, so
  // the re-read these changes cause is a real one.
  for (const change of changes) invalidateCheckoutSummary(change.checkoutKey)
  const bySender = new Map<WebContents, GitCheckoutChange[]>()
  for (const change of changes) {
    for (const sender of sendersFor(change.checkoutKey)) {
      const list = bySender.get(sender) ?? []
      list.push(change)
      bySender.set(sender, list)
    }
  }
  for (const [sender, list] of bySender) sender.send('git:checkout-changed', list)
}

/** The process-wide watch. Also fed by the observed-checkout resolver (app-services). */
export function getGitRepoWatch(): GitRepoWatch {
  sharedWatch ??= createGitRepoWatch({ emit: deliver })
  return sharedWatch
}

export function registerGitRepoWatchIpc(ipcMain: IpcMain): void {
  const watch = getGitRepoWatch()

  const release = (senderId: number, key: string): void => {
    const retains = retainsBySender.get(senderId)
    const count = retains?.get(key) ?? 0
    if (!retains || count === 0) return
    if (count === 1) retains.delete(key)
    else retains.set(key, count - 1)
    watch.release(key)
  }

  ipcMain.handle('git:checkout-watch-retain', async (event, checkoutPath: string) => {
    if (typeof checkoutPath !== 'string' || !checkoutPath) return
    const senderId = event.sender.id
    let retains = retainsBySender.get(senderId)
    if (!retains) {
      retains = new Map()
      retainsBySender.set(senderId, retains)
      event.sender.once('destroyed', () => {
        const held = retainsBySender.get(senderId)
        retainsBySender.delete(senderId)
        for (const [key, count] of held ?? []) for (let index = 0; index < count; index += 1) watch.release(key)
      })
    }
    const key = checkoutKey(checkoutPath)
    retains.set(key, (retains.get(key) ?? 0) + 1)
    await watch.retain(checkoutPath)
  })

  ipcMain.handle('git:checkout-watch-release', (event, checkoutPath: string) => {
    if (typeof checkoutPath !== 'string' || !checkoutPath) return
    release(event.sender.id, checkoutKey(checkoutPath))
  })

  // Nothing is delivered while no window of the app is focused; what changed
  // meanwhile arrives as one batch when one is. Blur is checked a tick later,
  // because moving focus between two of our own windows blurs one before it
  // focuses the other.
  // Until the first focus event says otherwise, the app counts as focused: at
  // registration there is usually no window yet, and a view that asks before
  // one exists must not be held.
  app.on?.('browser-window-focus', () => watch.setFocused(true))
  app.on?.('browser-window-blur', () => {
    setTimeout(() => watch.setFocused(anyWindowFocused()), 0)
  })
}

function anyWindowFocused(): boolean {
  try {
    return BrowserWindow.getFocusedWindow() !== null
  } catch {
    return true
  }
}
