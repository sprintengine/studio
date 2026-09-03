import { useEffect, useState } from 'react'

import type { TailnetLiveState, TailnetRemoteStatus } from '../../../../../shared/tailnet'
import type { FleetConnection } from '../../../../../shared/tailnet-fleet'

// The Remote glyph's one data source (remote-sessions-ux /
// remote-glyph-topbar): the pushed tailnet payloads plus the fleet's
// broadcast lifecycle, folded into render-ready presence. No polling — the
// initial reads seed it and every later change arrives as an event.

export type TailnetPresence = {
  /** Null until the first read lands; the glyph stays absent until it has. */
  status: TailnetRemoteStatus | null
  live: TailnetLiveState
  fleet: FleetConnection[]
  /** connectionId → remote session ids with a LIVE attachment in this app. */
  fleetLiveSessions: ReadonlyMap<string, ReadonlySet<string>>
}

export function useTailnetPresence(): TailnetPresence {
  const [status, setStatus] = useState<TailnetRemoteStatus | null>(null)
  const [live, setLive] = useState<TailnetLiveState>({ devices: [] })
  const [fleet, setFleet] = useState<FleetConnection[]>([])
  const [fleetLiveSessions, setFleetLiveSessions] = useState<ReadonlyMap<string, ReadonlySet<string>>>(
    new Map()
  )

  useEffect(() => {
    let cancelled = false
    void window.api
      .tailnetGetStatus()
      .then((initial) => {
        if (!cancelled) setStatus(initial)
      })
      .catch(() => {})
    void window.api
      .tailnetGetLiveState()
      .then((initial) => {
        if (!cancelled) setLive(initial)
      })
      .catch(() => {})
    void window.api
      .fleetListConnections()
      .then((connections) => {
        if (!cancelled) setFleet(connections)
      })
      .catch(() => {})

    const offTailnet = window.api.onTailnetEvent((payload) => {
      setStatus(payload.status)
      setLive(payload.live)
    })
    const offFleet = window.api.onFleetEvent((event) => {
      if (event.kind === 'machine-paired' || event.kind === 'machine-forgotten') {
        void window.api
          .fleetListConnections()
          .then((connections) => {
            if (!cancelled) setFleet(connections)
          })
          .catch(() => {})
        if (event.kind === 'machine-forgotten') {
          setFleetLiveSessions((current) => {
            if (!current.has(event.connectionId)) return current
            const next = new Map(current)
            next.delete(event.connectionId)
            return next
          })
        }
        return
      }
      // Attachment link state: only `live` counts as attached — connecting,
      // reconnecting, and offline are a pane hoping, not a session held.
      setFleetLiveSessions((current) => {
        const sessions = new Set(current.get(event.connectionId) ?? [])
        if (event.state === 'live') sessions.add(event.sessionId)
        else sessions.delete(event.sessionId)
        if ((current.get(event.connectionId)?.size ?? 0) === sessions.size && event.state === 'live') {
          // Adding an id it already had: nothing changed.
          if (current.get(event.connectionId)?.has(event.sessionId)) return current
        }
        const next = new Map(current)
        if (sessions.size === 0) next.delete(event.connectionId)
        else next.set(event.connectionId, sessions)
        return next
      })
    })
    return () => {
      cancelled = true
      offTailnet()
      offFleet()
    }
  }, [])

  return { status, live, fleet, fleetLiveSessions }
}
