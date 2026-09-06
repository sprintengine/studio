import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useTailnetPresence, type TailnetPresence } from '../topbar/useTailnetPresence'
import { shouldBrowse, type RemoteBrowseEntry } from './remoteSessionsModel'

// The reads behind the sidebar's Remote band (remote-sessions-in-the-sidebar,
// epic decision 2): an expanded band IS the ask, and the asking is bounded —
// only machines main's last check says are awake, on the transitions that
// change what they hold, and on a slow cadence while the band is open and the
// window is the one in front. A machine that is asleep is never dialled: its
// last rows stay on screen dimmed, and the next reachability event that says
// it answered is what reads it again.

/** How often an open band re-reads awake machines while the window is focused. */
export const REMOTE_BAND_CADENCE_MS = 30_000
/** Attachment link changes arrive in bursts (connecting → live); one read per burst. */
const ATTACHMENT_SETTLE_MS = 750

export type RemoteSessions = {
  presence: TailnetPresence
  browses: ReadonlyMap<string, RemoteBrowseEntry>
  /** Read one machine now, or every machine that may be asked. */
  refresh: (connectionId?: string) => void
}

const EMPTY_ENTRY: RemoteBrowseEntry = { browse: null, loading: false, error: null, at: null }

function withEntry(
  current: ReadonlyMap<string, RemoteBrowseEntry>,
  connectionId: string,
  update: (entry: RemoteBrowseEntry) => RemoteBrowseEntry
): ReadonlyMap<string, RemoteBrowseEntry> {
  const next = new Map(current)
  next.set(connectionId, update(current.get(connectionId) ?? EMPTY_ENTRY))
  return next
}

export function useRemoteSessions({ enabled }: { enabled: boolean }): RemoteSessions {
  const presence = useTailnetPresence()
  const [browses, setBrowses] = useState<ReadonlyMap<string, RemoteBrowseEntry>>(() => new Map())
  const browsesRef = useRef(browses)
  browsesRef.current = browses
  const inFlight = useRef(new Set<string>())
  // A host without the fleet bridge (partial test harnesses, narrower
  // preloads) gets a band that draws what the rows already know and asks
  // nothing — never a throw inside an effect.
  const bridge = typeof window !== 'undefined' && typeof window.api?.fleetBrowse === 'function'

  const browse = useCallback(
    (connectionId: string) => {
      if (!bridge || inFlight.current.has(connectionId)) return
      inFlight.current.add(connectionId)
      setBrowses((current) => withEntry(current, connectionId, (entry) => ({ ...entry, loading: true })))
      window.api
        .fleetBrowse(connectionId)
        .then((result) => {
          setBrowses((current) =>
            withEntry(current, connectionId, (entry) => ({
              // A machine that did not answer keeps its last rows; only an
              // answer replaces them.
              browse: result.reachable ? result : entry.browse,
              loading: false,
              error: result.reachable ? null : result.unreachableReason ?? 'Not answering.',
              at: Date.now(),
            }))
          )
        })
        .catch((error: unknown) => {
          setBrowses((current) =>
            withEntry(current, connectionId, (entry) => ({
              ...entry,
              loading: false,
              error: error instanceof Error ? error.message : String(error),
              at: Date.now(),
            }))
          )
        })
        .finally(() => {
          inFlight.current.delete(connectionId)
        })
    },
    [bridge]
  )

  const { fleet, fleetReachability, fleetAttachments } = presence

  // The pairing list: a machine not yet read gets its first read; a machine
  // forgotten drops its entry so its rows go with it.
  useEffect(() => {
    const paired = new Set(fleet.map((connection) => connection.id))
    setBrowses((current) => {
      let next: Map<string, RemoteBrowseEntry> | null = null
      for (const id of current.keys()) {
        if (paired.has(id)) continue
        next ??= new Map(current)
        next.delete(id)
      }
      return next ?? current
    })
    if (!enabled) return
    for (const connection of fleet) {
      if (browsesRef.current.has(connection.id) || inFlight.current.has(connection.id)) continue
      if (!shouldBrowse(fleetReachability.get(connection.id))) continue
      browse(connection.id)
    }
  }, [enabled, fleet, fleetReachability, browse])

  // Reachability transitions: a machine that answers again after being quiet
  // is read again. The first read at mount is the effect above's; this one
  // only fires on a genuine off → on edge.
  const wasAwake = useRef(new Map<string, boolean>())
  useEffect(() => {
    for (const [id, reach] of fleetReachability) {
      const awake = shouldBrowse(reach) && reach.checkedAt !== null
      const was = wasAwake.current.has(id)
        ? wasAwake.current.get(id)!
        : browsesRef.current.has(id) || inFlight.current.has(id)
      wasAwake.current.set(id, awake)
      if (enabled && awake && !was && fleet.some((connection) => connection.id === id)) browse(id)
    }
    for (const id of [...wasAwake.current.keys()]) {
      if (!fleetReachability.has(id)) wasAwake.current.delete(id)
    }
  }, [enabled, fleet, fleetReachability, browse])

  // A link opening or closing changes which rows are "open here"; the list
  // that says so is the remote's, re-read once the burst settles.
  const attachmentSignature = useMemo(
    () =>
      [...fleetAttachments.values()]
        .map((attachment) => `${attachment.connectionId}:${attachment.sessionId}:${attachment.state}`)
        .sort()
        .join('|'),
    [fleetAttachments]
  )
  const lastSignature = useRef(attachmentSignature)
  useEffect(() => {
    if (lastSignature.current === attachmentSignature) return
    lastSignature.current = attachmentSignature
    if (!enabled) return
    const timer = window.setTimeout(() => {
      for (const connection of fleet) {
        if (shouldBrowse(fleetReachability.get(connection.id))) browse(connection.id)
      }
    }, ATTACHMENT_SETTLE_MS)
    return () => window.clearTimeout(timer)
  }, [enabled, attachmentSignature, fleet, fleetReachability, browse])

  // The cadence: only while the band is open and this window is in front.
  useEffect(() => {
    if (!enabled || !bridge) return
    const timer = window.setInterval(() => {
      if (typeof document !== 'undefined' && typeof document.hasFocus === 'function' && !document.hasFocus()) return
      for (const connection of fleet) {
        if (shouldBrowse(fleetReachability.get(connection.id))) browse(connection.id)
      }
    }, REMOTE_BAND_CADENCE_MS)
    return () => window.clearInterval(timer)
  }, [enabled, bridge, fleet, fleetReachability, browse])

  const refresh = useCallback(
    (connectionId?: string) => {
      for (const connection of fleet) {
        if (connectionId && connection.id !== connectionId) continue
        if (connectionId || shouldBrowse(fleetReachability.get(connection.id))) browse(connection.id)
      }
    },
    [fleet, fleetReachability, browse]
  )

  return { presence, browses, refresh }
}
