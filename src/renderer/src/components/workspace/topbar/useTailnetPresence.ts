import { useSyncExternalStore } from 'react'

import type { TailnetLiveState, TailnetRemoteStatus } from '../../../../../shared/tailnet'
import type { MeshConnection, MeshMachineReachability, MeshPairRequestView } from '../../../../../shared/tailnet-mesh'

// The Remote glyph's one data source (remote-sessions-ux /
// remote-glyph-topbar): the pushed tailnet payloads plus the mesh's
// broadcast lifecycle, folded into render-ready presence. No polling — the
// initial reads seed it and every later change arrives as an event.
//
// One store per window, however many components ask. The top bar and the
// Remote band (and Settings, when open) each used to run their own copy:
// a set of initial reads and a subscription to both channels apiece, each
// folding every event. The store starts with its first subscriber and stops
// with its last.
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

type MeshChangeKind = 'workspaces' | 'conversations'
type MeshRemoteChange = {
  /** The kind the latest push named. */
  what: MeshChangeKind
  revision: number
  at: number
  /**
   * The mesh revision of the latest push of each kind. Pushes of both kinds
   * can land between two renders; a reader that re-reads by kind compares
   * these rather than `what`, so neither is lost.
   */
  revisions: Partial<Record<MeshChangeKind, number>>
}

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
  return useSyncExternalStore(subscribePresence, readPresence, readPresence)
}

// ── The store ───────────────────────────────────────────────────────────────

const INITIAL_PRESENCE: TailnetPresence = {
  status: null,
  live: EMPTY_LIVE_STATE,
  mesh: [],
  meshRequests: [],
  meshReachability: new Map(),
  meshRemoteChanges: new Map(),
}

let presence: TailnetPresence = INITIAL_PRESENCE
const presenceListeners = new Set<() => void>()
let stopPresence: (() => void) | null = null
// The newest revision applied on each channel. They gate what becomes state
// and must be read synchronously inside the callbacks.
let tailnetRevision = 0
let meshRevision = 0
// Whether a PUSHED payload has set status. The initial live-state read also
// advances `tailnetRevision`, and status carries no revision of its own, so
// the status read must yield only to a push — never to its sibling read
// resolving first, which would leave status null on a quiet system.
let statusPushed = false

const readPresence = (): TailnetPresence => presence

function updatePresence(update: (current: TailnetPresence) => Partial<TailnetPresence> | null): void {
  const patch = update(presence)
  if (!patch) return
  presence = { ...presence, ...patch }
  for (const listener of [...presenceListeners]) listener()
}

function subscribePresence(listener: () => void): () => void {
  presenceListeners.add(listener)
  if (presenceListeners.size === 1) stopPresence = startPresence()
  return () => {
    presenceListeners.delete(listener)
    if (presenceListeners.size > 0) return
    stopPresence?.()
    stopPresence = null
    // The next first subscriber starts from nothing and reads everything
    // again: nothing was listening, so nothing here can be trusted as current.
    presence = INITIAL_PRESENCE
    tailnetRevision = 0
    meshRevision = 0
    statusPushed = false
  }
}

function startPresence(): (() => void) | null {
  // A host without the complete tailnet/mesh bridge (partial test harnesses,
  // narrower preloads) gets a quiet, absent glyph rather than a throw — and
  // the guard covers EVERY function called below, not just the subscriptions.
  if (typeof window === 'undefined' || !hasTailnetPresenceBridge(window.api)) return null
  let cancelled = false
  const readConnections = (): void => {
    void window.api
      .meshListConnections()
      .then((connections) => {
        if (!cancelled) updatePresence(() => ({ mesh: connections }))
      })
      .catch(() => {})
  }
  void window.api
    .tailnetGetStatus()
    .then((initial) => {
      // Every push carries a fresher status, so a push already applied
      // outranks this read; the live-state read does not.
      if (!cancelled && !statusPushed) updatePresence(() => ({ status: initial }))
    })
    .catch(() => {})
  void window.api
    .tailnetGetLiveState()
    .then((initial) => {
      if (cancelled || initial.revision < tailnetRevision) return
      tailnetRevision = initial.revision
      updatePresence(() => ({ live: initial }))
    })
    .catch(() => {})
  readConnections()
  void window.api
    .meshGetLiveState()
    .then((initial) => {
      if (cancelled || initial.revision < meshRevision) return
      meshRevision = initial.revision
      updatePresence(() => ({
        // Tolerant of a main that predates these fields (a partial bridge in
        // a test): an absent list is an empty one, not a throw at mount.
        meshRequests: initial.requests ?? [],
        meshReachability: new Map((initial.reachability ?? []).map((entry) => [entry.connectionId, entry])),
      }))
    })
    .catch(() => {})

  const offTailnet = window.api.onTailnetEvent((payload) => {
    if (payload.revision < tailnetRevision) return
    tailnetRevision = payload.revision
    statusPushed = true
    updatePresence(() => ({ status: payload.status, live: payload.live }))
  })
  const offMesh = window.api.onMeshEvent((event) => {
    if (event.revision < meshRevision) return
    meshRevision = event.revision
    if (event.kind === 'machine-paired' || event.kind === 'machine-forgotten') {
      readConnections()
      if (event.kind === 'machine-forgotten') {
        updatePresence((current) => {
          const meshReachability = new Map(current.meshReachability)
          meshReachability.delete(event.connectionId)
          const meshRemoteChanges = new Map(current.meshRemoteChanges)
          meshRemoteChanges.delete(event.connectionId)
          return {
            meshReachability:
              meshReachability.size === current.meshReachability.size ? current.meshReachability : meshReachability,
            meshRemoteChanges:
              meshRemoteChanges.size === current.meshRemoteChanges.size ? current.meshRemoteChanges : meshRemoteChanges,
          }
        })
      }
      return
    }
    if (event.kind === 'pair-request') {
      // Only `waiting` is a request to show; every other phase ends it.
      updatePresence((current) => {
        const rest = current.meshRequests.filter((entry) => entry.requestId !== event.request.requestId)
        return { meshRequests: event.phase === 'waiting' ? [...rest, event.request] : rest }
      })
      return
    }
    if (event.kind === 'machine-reachability') {
      updatePresence((current) => {
        const { kind: _kind, revision: _revision, ...entry } = event
        const meshReachability = new Map(current.meshReachability)
        meshReachability.set(entry.connectionId, entry)
        return { meshReachability }
      })
      return
    }
    updatePresence((current) => {
      const meshRemoteChanges = new Map(current.meshRemoteChanges)
      const previous = current.meshRemoteChanges.get(event.connectionId)
      meshRemoteChanges.set(event.connectionId, {
        what: event.what,
        revision: event.revision,
        at: Date.now(),
        revisions: { ...previous?.revisions, [event.what]: event.revision },
      })
      return { meshRemoteChanges }
    })
  })
  return () => {
    cancelled = true
    offTailnet()
    offMesh()
  }
}
