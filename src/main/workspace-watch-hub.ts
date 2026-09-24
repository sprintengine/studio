import { watch as fsWatch, type FSWatcher, type WatchListener } from 'fs'
import type { FileWatchEvent } from '../shared/ipc/filesystem'

/**
 * One OS watcher per watched root, shared by every caller that watches it.
 *
 * The renderer's file tree, the git status hook, the backlog scan and module
 * file watches all watched the same workspace root, each with its own recursive
 * `fs.watch` — so one `npm install` was delivered to main four times over, and
 * every one of those raw events reset a timer on main's event loop. Here the
 * root is watched once and the events are fanned out.
 *
 * Two things happen before anything leaves main:
 *
 * 1. **Churn nobody renders is dropped.** `.git/` (the gitdir watcher in
 *    git-repo-watch.ts reads that, precisely), `node_modules/`, the app's own
 *    `.sprintengine/` sidecar, and build output. An install or a build inside a
 *    watched checkout is thousands of events that would otherwise each wake the
 *    file tree and the git status reader.
 * 2. **A burst becomes a SET of paths, not `path: null`.** The previous
 *    coalescing collapsed any two events inside the window to "something
 *    changed", and the two consumers read that null in opposite ways: the file
 *    tree refreshed on it (so `node_modules` churn refreshed the tree) and the
 *    git status hook ignored it (so a real edit that arrived in the same burst
 *    as anything else was silently dropped). With the paths kept, each consumer
 *    decides on what actually changed.
 *
 * A subscriber that needs the dropped directories (a module watching a file
 * under `.sprintengine/`) asks for `includeIgnored`, and still shares the one
 * watcher.
 */

/** Anywhere in the path: nothing under these is ever rendered from a watch. */
const IGNORED_SEGMENTS = new Set(['.git', 'node_modules', '.sprintengine', '__pycache__', '.vite', '.next', '.turbo'])
/**
 * Only at the root of the watch: the conventional build output directories. A
 * `build/` deep in a source tree is as likely to be source as output, so it is
 * left alone there.
 */
const IGNORED_TOP_LEVEL = new Set(['out', 'dist', 'build', 'coverage'])

export function isIgnoredWatchPath(relativePath: string): boolean {
  const segments = relativePath.split(/[/\\]+/).filter(Boolean)
  if (segments.length === 0) return false
  if (IGNORED_TOP_LEVEL.has(segments[0]) && segments.length > 1) return true
  return segments.some((segment) => IGNORED_SEGMENTS.has(segment))
}

/** Past this many distinct paths in one window a burst is reported as "many". */
export const WATCH_BATCH_PATH_LIMIT = 256
export const WATCH_COALESCE_MS = 100

type Subscriber = {
  listener: (event: FileWatchEvent) => void
  includeIgnored: boolean
  pending: Set<string>
  pendingRename: boolean
  pendingOverflow: boolean
  timer: NodeJS.Timeout | null
}

type RootWatch = {
  watcher: FSWatcher
  subscribers: Set<Subscriber>
}

export type WatchSubscription = { close(): void }

export type WatchHub = {
  /**
   * Starts (or joins) the watch on `root`. Throws what `fs.watch` throws — a
   * missing path in particular — so the caller can tell "cannot watch" apart.
   */
  subscribe(
    root: string,
    listener: (event: FileWatchEvent) => void,
    options?: { includeIgnored?: boolean },
  ): WatchSubscription
  /** How many OS watchers are open. For tests and diagnostics. */
  watcherCount(): number
}

type WatchFn = (path: string, options: { recursive: boolean }, listener: WatchListener<string>) => FSWatcher

export function createWatchHub(
  deps: {
    watch?: WatchFn
    platform?: NodeJS.Platform
    coalesceMs?: number
    setTimer?: (callback: () => void, ms: number) => NodeJS.Timeout
    clearTimer?: (timer: NodeJS.Timeout) => void
  } = {},
): WatchHub {
  const watch: WatchFn = deps.watch ?? ((path, options, listener) => fsWatch(path, options, listener))
  const platform = deps.platform ?? process.platform
  const coalesceMs = deps.coalesceMs ?? WATCH_COALESCE_MS
  const setTimer = deps.setTimer ?? ((callback: () => void, ms: number) => setTimeout(callback, ms))
  const clearTimer = deps.clearTimer ?? ((timer: NodeJS.Timeout) => clearTimeout(timer))
  const roots = new Map<string, RootWatch>()

  const keyOf = (root: string): string => root.replace(/\\/g, '/').replace(/\/+$/u, '')

  const flush = (subscriber: Subscriber): void => {
    subscriber.timer = null
    const paths = subscriber.pendingOverflow ? [] : [...subscriber.pending]
    const event: FileWatchEvent = {
      eventType: subscriber.pendingRename ? 'rename' : 'change',
      path: paths[0] ?? null,
      paths,
      ...(subscriber.pendingOverflow ? { overflow: true } : {}),
    }
    subscriber.pending = new Set()
    subscriber.pendingRename = false
    subscriber.pendingOverflow = false
    try {
      subscriber.listener(event)
    } catch (error) {
      console.warn('[watch-hub] listener threw', error)
    }
  }

  const deliver = (entry: RootWatch, eventType: string, filename: string | null): void => {
    const ignored = filename !== null && isIgnoredWatchPath(filename)
    for (const subscriber of entry.subscribers) {
      if (ignored && !subscriber.includeIgnored) continue
      if (filename === null || subscriber.pending.size >= WATCH_BATCH_PATH_LIMIT) {
        // No name from the OS, or too many names to be worth sending: the
        // consumer is told "re-read", which every consumer already handles.
        subscriber.pendingOverflow = true
      } else {
        subscriber.pending.add(filename)
      }
      if (eventType === 'rename') subscriber.pendingRename = true
      // Armed once per window and never re-armed per event: a burst of ten
      // thousand events costs one timer, not ten thousand resets of one.
      if (!subscriber.timer) subscriber.timer = setTimer(() => flush(subscriber), coalesceMs)
    }
  }

  const open = (root: string): RootWatch => {
    const entry: RootWatch = { watcher: null as unknown as FSWatcher, subscribers: new Set() }
    const listener: WatchListener<string> = (eventType, filename) => {
      deliver(entry, eventType, typeof filename === 'string' && filename ? filename : null)
    }
    const recursive = platform === 'win32' || platform === 'darwin'
    try {
      entry.watcher = watch(root, { recursive }, listener)
    } catch (error) {
      if (!recursive || (error as NodeJS.ErrnoException).code === 'ENOENT') throw error
      entry.watcher = watch(root, { recursive: false }, listener)
    }
    // An FSWatcher that errors (the root deleted, a network mount dropping)
    // emits 'error', which with no listener would throw on main. The watch is
    // over; subscribers keep their subscription objects and simply hear no
    // more, the same as the single-watcher code before this.
    entry.watcher.on('error', () => {
      try {
        entry.watcher.close()
      } catch {
        // Already closed.
      }
      if (roots.get(keyOf(root)) === entry) roots.delete(keyOf(root))
    })
    return entry
  }

  return {
    subscribe(root, listener, options = {}) {
      const key = keyOf(root)
      let entry = roots.get(key)
      if (!entry) {
        entry = open(root)
        roots.set(key, entry)
      }
      const subscriber: Subscriber = {
        listener,
        includeIgnored: options.includeIgnored === true,
        pending: new Set(),
        pendingRename: false,
        pendingOverflow: false,
        timer: null,
      }
      entry.subscribers.add(subscriber)
      const owner = entry
      let closed = false
      return {
        close() {
          if (closed) return
          closed = true
          if (subscriber.timer) clearTimer(subscriber.timer)
          owner.subscribers.delete(subscriber)
          if (owner.subscribers.size === 0) {
            try {
              owner.watcher.close()
            } catch {
              // Already closed.
            }
            if (roots.get(key) === owner) roots.delete(key)
          }
        },
      }
    },
    watcherCount: () => roots.size,
  }
}

let sharedHub: WatchHub | null = null

/** The process-wide hub. Main's file watch IPC and the quick-open cache share it. */
export function getWatchHub(): WatchHub {
  sharedHub ??= createWatchHub()
  return sharedHub
}
