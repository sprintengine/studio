import { join } from 'node:path'
import type { IpcMain } from 'electron'

import { USAGE_LIMITS_CHANGED_CHANNEL, USAGE_LIMITS_GET_CHANNEL } from '../../shared/ipc/usage-limits'
import type { UsageLimitsState } from '../../shared/usage-limits'
import { createUsageLimitsDiskCache, USAGE_LIMITS_CACHE_FILE } from '../usage-limits/disk-cache'
import { usageLimitsStore, type UsageLimitsStore } from '../usage-limits/store'

/** The slice of a renderer's webContents the push touches. */
type SubscriberLike = {
  id: number
  isDestroyed: () => boolean
  send: (channel: string, payload: unknown) => void
  once: (event: 'destroyed', listener: () => void) => unknown
}

export type UsageLimitsIpcDeps = {
  store?: UsageLimitsStore
  /** Where the last reading is kept across restarts (the app's userData). */
  userDataDir?: string
}

/**
 * `usage-limits:get` answers with the reading main holds; every change after
 * that is pushed to each window that asked. A window that never asked draws no
 * limits, so it is not woken for them. Registered with the chats, whose agents
 * report most of the readings; the cache is read once, here, so there is one
 * writer of its file.
 *
 * The cache's write is debounced and not flushed at quit: a reading lost to a
 * quit in that second is replaced by the first turn of the next run.
 */
export function registerUsageLimitsIpc(ipcMain: IpcMain, deps: UsageLimitsIpcDeps = {}): { stop: () => void } {
  const store = deps.store ?? usageLimitsStore()
  const cache = deps.userDataDir
    ? createUsageLimitsDiskCache({ file: join(deps.userDataDir, USAGE_LIMITS_CACHE_FILE) })
    : null
  const loaded = cache ? cache.attach(store).catch(() => undefined) : Promise.resolve()
  const subscribers = new Map<number, SubscriberLike>()
  ipcMain.handle(USAGE_LIMITS_GET_CHANNEL, async (event) => {
    const sender = (event as { sender?: SubscriberLike } | null)?.sender
    if (sender && !subscribers.has(sender.id) && !sender.isDestroyed()) {
      subscribers.set(sender.id, sender)
      sender.once('destroyed', () => subscribers.delete(sender.id))
    }
    await loaded
    return store.state()
  })
  const stopRelay = store.onChanged((state: UsageLimitsState) => {
    for (const [id, sender] of subscribers) {
      if (sender.isDestroyed()) subscribers.delete(id)
      else sender.send(USAGE_LIMITS_CHANGED_CHANNEL, state)
    }
  })
  return {
    stop: () => {
      stopRelay()
      subscribers.clear()
      void cache?.dispose()
    },
  }
}
