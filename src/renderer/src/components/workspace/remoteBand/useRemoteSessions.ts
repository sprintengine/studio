import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useTailnetPresence, type TailnetPresence } from '../topbar/useTailnetPresence'
import { remoteLinkStateOf, shouldBrowse, type RemoteBrowseEntry, type RemoteLinkState } from './remoteSessionsModel'

// The reads behind the sidebar's Remote band (remote-sessions-in-the-sidebar,
// epic decision 2): an expanded band IS the ask, and the asking is bounded —
// only machines main's last check says are awake, on the transitions that
// change what they hold, and when a machine SAYS it changed. A machine that
// is asleep is never dialled: its last rows stay on screen dimmed, and the
// next reachability event that says it answered is what reads it again.
//
// The change feed (2026-09-05) replaced the thirty-second timer. Main holds
// one idle socket to each paired machine, on which that machine says its
// terminal or workspace list moved, and the band re-reads on that: the
// server owns the state, the client subscribes. The timer
// that remains is a slow fallback for a feed a machine could not open.

/** The fallback re-read of awake machines while the band is open and focused; the change feed is the real beat. */
const REMOTE_BAND_CADENCE_MS = 180_000
/** Attachment link changes arrive in bursts (connecting → live); one read per burst. */
const ATTACHMENT_SETTLE_MS = 750
/** A machine's change pushes arrive already throttled; a short settle folds the terminal and workspace pushes of one event into one read. */
const REMOTE_CHANGE_SETTLE_MS = 250

export type RemoteSessions = {
  presence: TailnetPresence
  browses: ReadonlyMap<string, RemoteBrowseEntry>
  /** This device's listener is up: the band may draw what it read from over there. */
  listening: boolean
  /**
   * Whether this device is on the tailnet at all — up, down, or not yet known.
   * What the rows that are WINDOWS here are gated on: a chat on another machine
   * is not openable, typable, or readable from a device with no tailnet, so its
   * row goes with the link and comes back with it (owner, 2026-09-13).
   */
  link: RemoteLinkState
  /** Read one machine now, or every machine that may be asked. */
  refresh: (connectionId?: string) => void
}

const EMPTY_ENTRY: RemoteBrowseEntry = { browse: null, loading: false, error: null, at: null }

function withEntry(
  current: ReadonlyMap<string, RemoteBrowseEntry>,
  connectionId: string,
  update: (entry: RemoteBrowseEntry) => RemoteBrowseEntry,
): ReadonlyMap<string, RemoteBrowseEntry> {
  const next = new Map(current)
  next.set(connectionId, update(current.get(connectionId) ?? EMPTY_ENTRY))
  return next
}

export function useRemoteSessions({ enabled: wanted }: { enabled: boolean }): RemoteSessions {
  const presence = useTailnetPresence()
  // Off the tailnet nothing over there can answer, so nothing is asked
  // (owner ruling 2026-09-05): the band draws only what is open here until
  // the listener is back, and the first read after that is the mount read.
  const listening = presence.status?.running === true
  const link = remoteLinkStateOf(presence.status)
  const enabled = wanted && listening
  const [browses, setBrowses] = useState<ReadonlyMap<string, RemoteBrowseEntry>>(() => new Map())
  const browsesRef = useRef(browses)
  browsesRef.current = browses
  const inFlight = useRef(new Set<string>())
  // A host without the mesh bridge (partial test harnesses, narrower
  // preloads) gets a band that draws what the rows already know and asks
  // nothing — never a throw inside an effect.
  const bridge = typeof window !== 'undefined' && typeof window.api?.meshBrowse === 'function'
  const conversationBridge = bridge && typeof window.api?.meshConversationList === 'function'

  const browse = useCallback(
    (connectionId: string) => {
      if (!bridge || inFlight.current.has(connectionId)) return
      inFlight.current.add(connectionId)
      setBrowses((current) => withEntry(current, connectionId, (entry) => ({ ...entry, loading: true })))
      window.api
        .meshBrowse(connectionId)
        .then(async (result) => {
          // Its chats too, once it has answered: the list is a short socket
          // on the conversation lane. A pairing that may not read them, or a
          // machine that does not serve them, lists none.
          const listed =
            result.reachable && conversationBridge
              ? await window.api.meshConversationList(connectionId).catch(() => null)
              : null
          setBrowses((current) =>
            withEntry(current, connectionId, (entry) => ({
              // A machine that did not answer keeps its last rows; only an
              // answer replaces them.
              browse: result.reachable ? result : entry.browse,
              loading: false,
              error: result.reachable ? null : (result.unreachableReason ?? 'Not answering.'),
              at: Date.now(),
              ...(listed
                ? { conversations: listed.ok ? listed.conversations : [] }
                : entry.conversations
                  ? { conversations: entry.conversations }
                  : {}),
            })),
          )
        })
        .catch((error: unknown) => {
          setBrowses((current) =>
            withEntry(current, connectionId, (entry) => ({
              ...entry,
              loading: false,
              error: error instanceof Error ? error.message : String(error),
              at: Date.now(),
            })),
          )
        })
        .finally(() => {
          inFlight.current.delete(connectionId)
        })
    },
    [bridge, conversationBridge],
  )

  const { mesh, meshReachability, meshAttachments, meshRemoteChanges } = presence

  // The change feed: a machine that said it changed is re-read, once its
  // pushes settle. Keyed by the mesh's revision so a re-render of the same
  // push reads nothing, and only machines that may be asked are asked.
  const handledChangeRevision = useRef(new Map<string, number>())
  useEffect(() => {
    if (!enabled) return
    const due: string[] = []
    for (const [id, change] of meshRemoteChanges) {
      if ((handledChangeRevision.current.get(id) ?? 0) >= change.revision) continue
      handledChangeRevision.current.set(id, change.revision)
      if (mesh.some((connection) => connection.id === id) && shouldBrowse(meshReachability.get(id))) due.push(id)
    }
    for (const id of [...handledChangeRevision.current.keys()]) {
      if (!meshRemoteChanges.has(id)) handledChangeRevision.current.delete(id)
    }
    if (due.length === 0) return
    const timer = window.setTimeout(() => {
      for (const id of due) browse(id)
    }, REMOTE_CHANGE_SETTLE_MS)
    return () => window.clearTimeout(timer)
  }, [enabled, mesh, meshReachability, meshRemoteChanges, browse])

  // The pairing list: a machine not yet read gets its first read; a machine
  // forgotten drops its entry so its rows go with it.
  useEffect(() => {
    const paired = new Set(mesh.map((connection) => connection.id))
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
    for (const connection of mesh) {
      if (browsesRef.current.has(connection.id) || inFlight.current.has(connection.id)) continue
      if (!shouldBrowse(meshReachability.get(connection.id))) continue
      browse(connection.id)
    }
  }, [enabled, mesh, meshReachability, browse])

  // Reachability transitions: a machine that answers again after being quiet
  // is read again. The first read at mount is the effect above's; this one
  // only fires on a genuine off → on edge.
  const wasAwake = useRef(new Map<string, boolean>())
  useEffect(() => {
    for (const [id, reach] of meshReachability) {
      const awake = shouldBrowse(reach) && reach.checkedAt !== null
      const was = wasAwake.current.has(id)
        ? wasAwake.current.get(id)!
        : browsesRef.current.has(id) || inFlight.current.has(id)
      wasAwake.current.set(id, awake)
      if (enabled && awake && !was && mesh.some((connection) => connection.id === id)) browse(id)
    }
    for (const id of [...wasAwake.current.keys()]) {
      if (!meshReachability.has(id)) wasAwake.current.delete(id)
    }
  }, [enabled, mesh, meshReachability, browse])

  // A link opening or closing changes which rows are "open here"; the list
  // that says so is the remote's, re-read once the burst settles.
  const attachmentSignature = useMemo(
    () =>
      [...meshAttachments.values()]
        .map((attachment) => `${attachment.connectionId}:${attachment.sessionId}:${attachment.state}`)
        .sort()
        .join('|'),
    [meshAttachments],
  )
  const lastSignature = useRef(attachmentSignature)
  useEffect(() => {
    if (lastSignature.current === attachmentSignature) return
    lastSignature.current = attachmentSignature
    if (!enabled) return
    const timer = window.setTimeout(() => {
      for (const connection of mesh) {
        if (shouldBrowse(meshReachability.get(connection.id))) browse(connection.id)
      }
    }, ATTACHMENT_SETTLE_MS)
    return () => window.clearTimeout(timer)
  }, [enabled, attachmentSignature, mesh, meshReachability, browse])

  // The fallback cadence: only while the band is open and this window is in
  // front, and slow — a machine whose change feed is up has already said
  // everything this read could find.
  useEffect(() => {
    if (!enabled || !bridge) return
    const timer = window.setInterval(() => {
      if (typeof document !== 'undefined' && typeof document.hasFocus === 'function' && !document.hasFocus()) return
      for (const connection of mesh) {
        if (shouldBrowse(meshReachability.get(connection.id))) browse(connection.id)
      }
    }, REMOTE_BAND_CADENCE_MS)
    return () => window.clearInterval(timer)
  }, [enabled, bridge, mesh, meshReachability, browse])

  const refresh = useCallback(
    (connectionId?: string) => {
      for (const connection of mesh) {
        if (connectionId && connection.id !== connectionId) continue
        if (connectionId || shouldBrowse(meshReachability.get(connection.id))) browse(connection.id)
      }
    },
    [mesh, meshReachability, browse],
  )

  return { presence, browses, listening, link, refresh }
}
