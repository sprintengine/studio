import { useEffect, useRef, useState } from 'react'

import type { TailnetLiveState, TailnetRemoteStatus } from '../../../../../shared/tailnet'
import type { MeshConnection, MeshMachineReachability, MeshPairRequestView } from '../../../../../shared/tailnet-mesh'

// The Remote glyph's one data source (remote-sessions-ux /
// remote-glyph-topbar): the pushed tailnet payloads plus the mesh's
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
  mesh: MeshConnection[]
  /** Requests this machine made that are still waiting to be answered (phase 3). Main owns the wait. */
  meshRequests: readonly MeshPairRequestView[]
  /** connectionId → main's last reachability answer for that machine (phase 4). */
  meshReachability: ReadonlyMap<string, MeshMachineReachability>
  /**
   * connectionId → the last change that machine pushed (the change feed,
   * 2026-09-05). A surface showing that machine re-reads when this moves;
   * `revision` is the mesh's own stamp, so a consumer can tell a new push
   * from a re-render.
   */
  meshRemoteChanges: ReadonlyMap<string, MeshRemoteChange>
}

type MeshRemoteChange = { what: 'workspaces' | 'conversations'; revision: number; at: number }

const EMPTY_LIVE_STATE: TailnetLiveState = { revision: 0, devices: [] }

/** The bridge functions presence needs; a host missing any of them gets a quiet, absent glyph. */
function hasTailnetPresenceBridge(api: Partial<Window['api']> | undefined): boolean {
  return (
    !!api &&
    typeof api.onTailnetEvent === 'function' &&
    typeof api.onMeshEvent === 'function' &&
    typeof api.tailnetGetStatus === 'function' &&
    typeof api.tailnetGetLiveState === 'function' &&
    typeof api.meshListConnections === 'function' &&
    typeof api.meshGetLiveState === 'function'
  )
}

export function useTailnetPresence(): TailnetPresence {
  const [status, setStatus] = useState<TailnetRemoteStatus | null>(null)
  const [live, setLive] = useState<TailnetLiveState>(EMPTY_LIVE_STATE)
  const [mesh, setMesh] = useState<MeshConnection[]>([])
  const [meshRequests, setMeshRequests] = useState<readonly MeshPairRequestView[]>([])
  const [meshReachability, setMeshReachability] = useState<ReadonlyMap<string, MeshMachineReachability>>(new Map())
  const [meshRemoteChanges, setMeshRemoteChanges] = useState<ReadonlyMap<string, MeshRemoteChange>>(new Map())
  // The newest revision applied on each channel. Refs, not state: they gate
  // what becomes state and must be read synchronously inside callbacks.
  const tailnetRevision = useRef(0)
  const meshRevision = useRef(0)
  // Whether a PUSHED payload has set status. The initial live-state read also
  // advances `tailnetRevision`, and status carries no revision of its own, so
  // the status read must yield only to a push — never to its sibling read
  // resolving first, which would leave status null on a quiet system.
  const statusPushed = useRef(false)

  useEffect(() => {
    // A host without the complete tailnet/mesh bridge (partial test
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
      .meshListConnections()
      .then((connections) => {
        if (!cancelled) setMesh(connections)
      })
      .catch(() => {})
    void window.api
      .meshGetLiveState()
      .then((initial) => {
        if (cancelled || initial.revision < meshRevision.current) return
        meshRevision.current = initial.revision
        // Tolerant of a main that predates these fields (a partial bridge in
        // a test): an absent list is an empty one, not a throw at mount.
        setMeshRequests(initial.requests ?? [])
        setMeshReachability(new Map((initial.reachability ?? []).map((entry) => [entry.connectionId, entry])))
      })
      .catch(() => {})

    const offTailnet = window.api.onTailnetEvent((payload) => {
      if (payload.revision < tailnetRevision.current) return
      tailnetRevision.current = payload.revision
      statusPushed.current = true
      setStatus(payload.status)
      setLive(payload.live)
    })
    const offMesh = window.api.onMeshEvent((event) => {
      if (event.revision < meshRevision.current) return
      meshRevision.current = event.revision
      if (event.kind === 'machine-paired' || event.kind === 'machine-forgotten') {
        void window.api
          .meshListConnections()
          .then((connections) => {
            if (!cancelled) setMesh(connections)
          })
          .catch(() => {})
        if (event.kind === 'machine-forgotten') {
          setMeshReachability((current) => {
            if (!current.has(event.connectionId)) return current
            const next = new Map(current)
            next.delete(event.connectionId)
            return next
          })
          setMeshRemoteChanges((current) => {
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
        setMeshRequests((current) => {
          const rest = current.filter((entry) => entry.requestId !== event.request.requestId)
          return event.phase === 'waiting' ? [...rest, event.request] : rest
        })
        return
      }
      if (event.kind === 'machine-reachability') {
        setMeshReachability((current) => {
          const { kind: _kind, revision: _revision, ...entry } = event
          const next = new Map(current)
          next.set(entry.connectionId, entry)
          return next
        })
        return
      }
      setMeshRemoteChanges((current) => {
        const next = new Map(current)
        next.set(event.connectionId, { what: event.what, revision: event.revision, at: Date.now() })
        return next
      })
    })
    return () => {
      cancelled = true
      offTailnet()
      offMesh()
    }
  }, [])

  return {
    status,
    live,
    mesh,
    meshRequests,
    meshReachability,
    meshRemoteChanges,
  }
}
