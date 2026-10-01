import { useCallback, useEffect, useState } from 'react'

import type { HostsListResult } from '../../../shared/execution-host'

/**
 * The machines this computer offers, as main lists them: this one first, then
 * (on Windows) its WSL distributions — every one with `all` (Settings ▸
 * Machines), the enabled ones otherwise (the New chat machine dropdown).
 *
 * Read once on mount and again whenever main says the list may read
 * differently (a setting moved, a refresh landed). Never on window focus:
 * listing WSL starts a process on Windows. `refresh()` asks WSL again, for
 * Settings' own Refresh.
 *
 * Null until the first answer; a window whose preload predates the API (a
 * test harness) stays null, which every caller reads as "this machine only".
 */
export function useExecutionHosts(options: { all?: boolean; refreshOnMount?: boolean; enabled?: boolean } = {}): {
  listing: HostsListResult | null
  refresh: () => Promise<void>
} {
  const all = options.all === true
  const refreshOnMount = options.refreshOnMount === true
  // False holds off the first read (and the subscription) until a caller that
  // mounts early actually needs the list.
  const enabled = options.enabled !== false
  const [listing, setListing] = useState<HostsListResult | null>(null)
  const load = useCallback(
    async (refresh: boolean): Promise<void> => {
      if (typeof window.api?.hostsList !== 'function') return
      try {
        setListing(await window.api.hostsList({ all, refresh }))
      } catch {
        // Keep what was there: a failed read is not "no machines".
      }
    },
    [all],
  )
  useEffect(() => {
    if (!enabled) return
    void load(refreshOnMount)
    const unsubscribe =
      typeof window.api?.onHostsChanged === 'function' ? window.api.onHostsChanged(() => void load(false)) : null
    return () => unsubscribe?.()
  }, [enabled, load, refreshOnMount])
  const refresh = useCallback(() => load(true), [load])
  return { listing, refresh }
}
