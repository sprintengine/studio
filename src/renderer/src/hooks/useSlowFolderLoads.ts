import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * How long a folder's listing may take before its row says it is loading. A
 * local folder lists in a few milliseconds, and a spinner that blinked into
 * the chevron's place on every open would be noise; a folder on an SSH machine
 * can take a second, and a click with no answer for that long reads as a click
 * that missed. The same hold the Suspense fallback waits out (index.css).
 */
export const FOLDER_LOADING_DELAY_MS = 160

const NO_PATHS: ReadonlySet<string> = new Set()

/**
 * The folders whose listing has been running longer than
 * `FOLDER_LOADING_DELAY_MS`. A listing that lands sooner never touches state,
 * so opening a local folder renders the tree exactly as often as it did
 * before; only a slow one costs a render to show its spinner and one to clear
 * it.
 */
export function useSlowFolderLoads(): {
  slowPaths: ReadonlySet<string>
  track: <T>(path: string, load: Promise<T>) => Promise<T>
} {
  const [slowPaths, setSlowPaths] = useState<ReadonlySet<string>>(NO_PATHS)
  // Per path: how many listings are in flight, and the timer that marks the
  // path slow. Two opens of one folder share a read, so the row stays marked
  // until the last of them lands.
  const pendingRef = useRef(new Map<string, { count: number; timer: number }>())

  useEffect(() => {
    const pending = pendingRef.current
    return () => {
      for (const { timer } of pending.values()) window.clearTimeout(timer)
      pending.clear()
    }
  }, [])

  const track = useCallback(async <T>(path: string, load: Promise<T>): Promise<T> => {
    const pending = pendingRef.current
    const current = pending.get(path)
    if (current) {
      current.count += 1
    } else {
      const timer = window.setTimeout(() => {
        setSlowPaths((paths) => new Set(paths).add(path))
      }, FOLDER_LOADING_DELAY_MS)
      pending.set(path, { count: 1, timer })
    }
    try {
      return await load
    } finally {
      const entry = pending.get(path)
      if (entry && --entry.count === 0) {
        window.clearTimeout(entry.timer)
        pending.delete(path)
        setSlowPaths((paths) => {
          if (!paths.has(path)) return paths
          const next = new Set(paths)
          next.delete(path)
          return next.size ? next : NO_PATHS
        })
      }
    }
  }, [])

  return { slowPaths, track }
}
