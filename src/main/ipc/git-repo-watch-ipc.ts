import { app, BrowserWindow, type IpcMain, type WebContents } from 'electron'
import { checkoutKey, createGitRepoWatch, type GitCheckoutChange, type GitRepoWatch } from '../git-repo-watch'
import { invalidateCheckoutSummary } from '../workspace-change-summary'

/**
 * The renderer's side of git-repo-watch.ts: a window retains the checkouts it
 * shows and is sent `git:checkout-changed` for those, and only those.
 *
 * Each window's retains are counted here per checkout, so a window gives its
 * share back when it closes (`destroyed`) and when its page is replaced by a
 * reload (Cmd+R, Force Reload) or any other main-frame navigation
 * (`did-navigate`). A reload keeps the same webContents, and the new page
 * retains afresh, so without the second every reload would leak each
 * checkout's watchers — one of them recursive over `refs/`.
 */

let sharedWatch: GitRepoWatch | null = null

/** The part of a webContents the bookkeeping needs. */
export type RetainingSender = {
  id: number
  once(event: 'destroyed', listener: () => void): unknown
  on(event: 'did-navigate', listener: () => void): unknown
}

export function createWindowRetains(watch: Pick<GitRepoWatch, 'retain' | 'release'>) {
  const retainsBySender = new Map<number, Map<string, number>>()

  const releaseAll = (senderId: number): void => {
    const held = retainsBySender.get(senderId)
    if (!held) return
    // The map stays, emptied: the listeners below are attached once per
    // webContents, and the reloaded page keeps retaining into it.
    const entries = [...held]
    held.clear()
    for (const [key, count] of entries) for (let index = 0; index < count; index += 1) watch.release(key)
  }

  return {
    async retain(sender: RetainingSender, checkoutPath: string): Promise<void> {
      const senderId = sender.id
      let retains = retainsBySender.get(senderId)
      if (!retains) {
        retains = new Map()
        retainsBySender.set(senderId, retains)
        sender.once('destroyed', () => {
          releaseAll(senderId)
          retainsBySender.delete(senderId)
        })
        // Emitted for main-frame, cross-document navigations only — a reload
        // is one — once the new page has committed, before its scripts run.
        sender.on('did-navigate', () => releaseAll(senderId))
      }
      const key = checkoutKey(checkoutPath)
      retains.set(key, (retains.get(key) ?? 0) + 1)
      await watch.retain(checkoutPath)
    },

    release(senderId: number, checkoutPath: string): void {
      const key = checkoutKey(checkoutPath)
      const retains = retainsBySender.get(senderId)
      const count = retains?.get(key) ?? 0
      if (!retains || count === 0) return
      if (count === 1) retains.delete(key)
      else retains.set(key, count - 1)
      watch.release(key)
    },

    retainedBy(senderId: number, key: string): number {
      return retainsBySender.get(senderId)?.get(key) ?? 0
    },
  }
}

let windowRetains: ReturnType<typeof createWindowRetains> | null = null

function sendersFor(key: string): WebContents[] {
  const senders: WebContents[] = []
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed() || window.webContents.isDestroyed()) continue
    if ((windowRetains?.retainedBy(window.webContents.id, key) ?? 0) > 0) senders.push(window.webContents)
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
  const retains = createWindowRetains(watch)
  windowRetains = retains

  ipcMain.handle('git:checkout-watch-retain', async (event, checkoutPath: string) => {
    if (typeof checkoutPath !== 'string' || !checkoutPath) return
    await retains.retain(event.sender, checkoutPath)
  })

  ipcMain.handle('git:checkout-watch-release', (event, checkoutPath: string) => {
    if (typeof checkoutPath !== 'string' || !checkoutPath) return
    retains.release(event.sender.id, checkoutPath)
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
