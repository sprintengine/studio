import { useEffect, useMemo, useRef, useState } from 'react'

import type { TailnetLiveState, TailnetRemoteStatus } from '../../../../../shared/tailnet'
import type {
  FleetConnection,
  FleetLiveAttachment,
  FleetMachineReachability,
  FleetPairRequestView,
} from '../../../../../shared/tailnet-fleet'

// The Remote glyph's one data source (remote-sessions-ux /
// remote-glyph-topbar): the pushed tailnet payloads plus the fleet's
// broadcast lifecycle, folded into render-ready presence. No polling — the
// initial reads seed it and every later change arrives as an event.
//
// Every fold is ordered by the main-side `revision`: a pushed payload older than the
// last one applied is dropped, and so is an initial read that resolves AFTER
// a push has already landed — the mount race that used to roll presence
// back to what main knew a moment before.

export type TailnetPresence = {
  /** Null until the first read lands; the glyph stays absent until it has. */
  status: TailnetRemoteStatus | null
  live: TailnetLiveState
  fleet: FleetConnection[]
  /** Every outbound attachment main holds, by attachId — a pane is a link, a session is not. */
  fleetAttachments: ReadonlyMap<string, FleetLiveAttachment>
  /** connectionId → remote session ids with a LIVE attachment in this app. Derived from `fleetAttachments`. */
  fleetLiveSessions: ReadonlyMap<string, ReadonlySet<string>>
  /** Requests this machine made that are still waiting to be answered (phase 3). Main owns the wait. */
  fleetRequests: readonly FleetPairRequestView[]
  /** connectionId → main's last reachability answer for that machine (phase 4). */
  fleetReachability: ReadonlyMap<string, FleetMachineReachability>
  /**
   * connectionId → the last change that machine pushed (the change feed,
   * 2026-09-05). A surface showing that machine re-reads when this moves;
   * `revision` is the fleet's own stamp, so a consumer can tell a new push
   * from a re-render.
   */
  fleetRemoteChanges: ReadonlyMap<string, FleetRemoteChange>
}

export type FleetRemoteChange = { what: 'terminals' | 'workspaces'; revision: number; at: number }

export const EMPTY_LIVE_STATE: TailnetLiveState = { revision: 0, devices: [] }

/** The bridge functions presence needs; a host missing any of them gets a quiet, absent glyph. */
export function hasTailnetPresenceBridge(api: Partial<Window['api']> | undefined): boolean {
  return (
    !!api
    && typeof api.onTailnetEvent === 'function'
    && typeof api.onFleetEvent === 'function'
    && typeof api.tailnetGetStatus === 'function'
    && typeof api.tailnetGetLiveState === 'function'
    && typeof api.fleetListConnections === 'function'
    && typeof api.fleetGetLiveState === 'function'
  )
}

/** Live sessions per connection, from the attachments held. Only `live` counts — connecting, reconnecting, and offline are a pane hoping. */
export function fleetLiveSessionsOf(
  attachments: ReadonlyMap<string, FleetLiveAttachment>
): ReadonlyMap<string, ReadonlySet<string>> {
  const next = new Map<string, Set<string>>()
  for (const attachment of attachments.values()) {
    if (attachment.state !== 'live') continue
    const sessions = next.get(attachment.connectionId) ?? new Set<string>()
    sessions.add(attachment.sessionId)
    next.set(attachment.connectionId, sessions)
  }
  return next
}

/**
 * The terminal sessions a paired device is looking at right now.
 *
 * The gateway already announces every terminal attach and detach with its
 * session id (`onActivity`, kind `terminal`), and the service already folds
 * that into `attachedTerminalSessions` per device — so "is a phone watching
 * this agent" is a set membership, not new plumbing.
 *
 * A Set rather than the device list, because the caller is a tab render that
 * asks the question once per agent: a scan of every device's array per tab is
 * the same answer computed n times.
 */
export function useRemoteAttachedSessions(): ReadonlySet<string> {
  const presence = useTailnetPresence()
  return useMemo(() => {
    const sessions = new Set<string>()
    for (const device of presence.live.devices) {
      for (const sessionId of device.attachedTerminalSessions) sessions.add(sessionId)
    }
    return sessions
  }, [presence.live])
}

export function useTailnetPresence(): TailnetPresence {
  const [status, setStatus] = useState<TailnetRemoteStatus | null>(null)
  const [live, setLive] = useState<TailnetLiveState>(EMPTY_LIVE_STATE)
  const [fleet, setFleet] = useState<FleetConnection[]>([])
  const [fleetAttachments, setFleetAttachments] = useState<ReadonlyMap<string, FleetLiveAttachment>>(new Map())
  const [fleetRequests, setFleetRequests] = useState<readonly FleetPairRequestView[]>([])
  const [fleetReachability, setFleetReachability] = useState<ReadonlyMap<string, FleetMachineReachability>>(new Map())
  const [fleetRemoteChanges, setFleetRemoteChanges] = useState<ReadonlyMap<string, FleetRemoteChange>>(new Map())
  // The newest revision applied on each channel. Refs, not state: they gate
  // what becomes state and must be read synchronously inside callbacks.
  const tailnetRevision = useRef(0)
  const fleetRevision = useRef(0)
  // Whether a PUSHED payload has set status. The initial live-state read also
  // advances `tailnetRevision`, and status carries no revision of its own, so
  // the status read must yield only to a push — never to its sibling read
  // resolving first, which would leave status null on a quiet system.
  const statusPushed = useRef(false)

  useEffect(() => {
    // A host without the complete tailnet/fleet bridge (partial test
    // harnesses, narrower preloads) gets a quiet, absent glyph rather than a
    // mount-time throw inside React's commit — and the guard covers EVERY
    // function called below, not just the subscriptions.
    if (!hasTailnetPresenceBridge(window.api)) return
    let cancelled = false
    void window.api
      .tailnetGetStatus()
      .then((initial) => {
        // Every push carries a fresher status, so a push already applied
        // outranks this read; the live-state read does not.
        if (!cancelled && !statusPushed.current) setStatus(initial)
      })
      .catch(() => {})
    void window.api
      .tailnetGetLiveState()
      .then((initial) => {
        if (cancelled || initial.revision < tailnetRevision.current) return
        tailnetRevision.current = initial.revision
        setLive(initial)
      })
      .catch(() => {})
    void window.api
      .fleetListConnections()
      .then((connections) => {
        if (!cancelled) setFleet(connections)
      })
      .catch(() => {})
    void window.api
      .fleetGetLiveState()
      .then((initial) => {
        if (cancelled || initial.revision < fleetRevision.current) return
        fleetRevision.current = initial.revision
        setFleetAttachments(new Map(initial.attachments.map((attachment) => [attachment.attachId, attachment])))
        // Tolerant of a main that predates these fields (a partial bridge in
        // a test): an absent list is an empty one, not a throw at mount.
        setFleetRequests(initial.requests ?? [])
        setFleetReachability(new Map((initial.reachability ?? []).map((entry) => [entry.connectionId, entry])))
      })
      .catch(() => {})

    const offTailnet = window.api.onTailnetEvent((payload) => {
      if (payload.revision < tailnetRevision.current) return
      tailnetRevision.current = payload.revision
      statusPushed.current = true
      setStatus(payload.status)
      setLive(payload.live)
    })
    const offFleet = window.api.onFleetEvent((event) => {
      if (event.revision < fleetRevision.current) return
      fleetRevision.current = event.revision
      if (event.kind === 'machine-paired' || event.kind === 'machine-forgotten') {
        void window.api
          .fleetListConnections()
          .then((connections) => {
            if (!cancelled) setFleet(connections)
          })
          .catch(() => {})
        if (event.kind === 'machine-forgotten') {
          setFleetAttachments((current) => {
            const next = new Map(current)
            for (const [attachId, attachment] of current) {
              if (attachment.connectionId === event.connectionId) next.delete(attachId)
            }
            return next.size === current.size ? current : next
          })
          setFleetReachability((current) => {
            if (!current.has(event.connectionId)) return current
            const next = new Map(current)
            next.delete(event.connectionId)
            return next
          })
          setFleetRemoteChanges((current) => {
            if (!current.has(event.connectionId)) return current
            const next = new Map(current)
            next.delete(event.connectionId)
            return next
          })
        }
        return
      }
      if (event.kind === 'pair-request') {
        // Only `waiting` is a request to show; every other phase ends it.
        setFleetRequests((current) => {
          const rest = current.filter((entry) => entry.requestId !== event.request.requestId)
          return event.phase === 'waiting' ? [...rest, event.request] : rest
        })
        return
      }
      if (event.kind === 'machine-reachability') {
        setFleetReachability((current) => {
          const { kind: _kind, revision: _revision, ...entry } = event
          const next = new Map(current)
          next.set(entry.connectionId, entry)
          return next
        })
        return
      }
      if (event.kind === 'remote-changed') {
        setFleetRemoteChanges((current) => {
          const next = new Map(current)
          next.set(event.connectionId, { what: event.what, revision: event.revision, at: Date.now() })
          return next
        })
        return
      }
      // Keyed by attachId: two panes on one session are two links, and one
      // closing must not retract the other's "live".
      setFleetAttachments((current) => {
        const next = new Map(current)
        if (event.state === 'closed') {
          if (!next.delete(event.attachId)) return current
          return next
        }
        const { kind: _kind, revision: _revision, ...attachment } = event
        next.set(event.attachId, attachment)
        return next
      })
    })
    return () => {
      cancelled = true
      offTailnet()
      offFleet()
    }
  }, [])

  const fleetLiveSessions = useMemo(() => fleetLiveSessionsOf(fleetAttachments), [fleetAttachments])
  return { status, live, fleet, fleetAttachments, fleetLiveSessions, fleetRequests, fleetReachability, fleetRemoteChanges }
}
