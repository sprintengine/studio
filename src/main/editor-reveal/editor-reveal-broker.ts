// The main half of "show the person this": asks the windows, and remembers what
// nobody could be shown.
//
// Main does not know which window shows which workspace — only the renderer
// does — so a reveal is ASKED of every workspace window at once, and each one
// answers: the window whose active workspace it is opens it and says how
// (`opened`, with what the person could see), every other window says
// `declined`. A workspace is shown by at most one window, so asking them all at
// once cannot open it twice; the dock-diff hand-off asks one at a time because
// a workspace can be RETAINED by several windows, and there any of them could
// take it.
//
// Nobody answering `opened` is the `not_visible` case, and it is not a failure:
// the request is kept for that workspace — latest wins, because the newest
// thing an agent wanted to show is the one worth showing — and the sidebar row
// says something is waiting. The first window that shows the workspace claims
// it and opens it then. Nothing switches workspace, raises a window or posts an
// OS notification to make the person look sooner (owner ruling 2026-09-22: an
// agent reveal must not take the window away).
//
// Electron-free: a target is anything that can be sent a message and
// recognised again when it answers, so the rules are testable with strings.

import { randomUUID } from 'node:crypto'

import {
  EDITOR_REVEAL_REQUEST_CHANNEL,
  EDITOR_STATE_QUERY_CHANNEL,
  type EditorRevealAck,
  type EditorRevealRequest,
  type EditorRevealShown,
  type EditorStateReply,
  type EditorWindowState,
} from '../../shared/editor-reveal'
import { isRecord } from '../../shared/records'

export type EditorRevealTarget = {
  /** Identity, compared with the sender of an answer. */
  id: unknown
  isDestroyed(): boolean
  send(channel: string, payload: unknown): void
}

/**
 * How long the windows get to answer. A window that is merely busy answers in
 * well under this; one that never answers is treated as not showing the
 * workspace, which is the honest reading of silence.
 */
export const EDITOR_REVEAL_WAIT_MS = 1_500

export type EditorRevealBrokerDeps = {
  targets: () => EditorRevealTarget[]
  /** Told the set of workspaces holding an unseen reveal, whenever it changes. */
  broadcastPending: (workspaceIds: string[]) => void
  newRequestId?: () => string
  waitMs?: number
}

export type EditorRevealBroker = {
  reveal(request: Omit<EditorRevealRequest, 'requestId'>): Promise<{ shown: EditorRevealShown }>
  /** A window now shows `workspaceId`: the reveal that waited for it, once. */
  claimPending(workspaceId: string): EditorRevealRequest | null
  pendingWorkspaceIds(): string[]
  hasPending(workspaceId: string): boolean
  /** What the window showing the workspace is showing; null when none answers. */
  queryState(workspaceId: string): Promise<EditorWindowState | null>
  /** Wired to the renderer's answers. `from` is the answering window, resolved by the transport. */
  handleAck(from: unknown, payload: unknown): void
  handleStateReply(from: unknown, payload: unknown): void
  dispose(): void
}

type Waiter<T> = {
  expected: Set<unknown>
  settle: (value: T) => void
}

export function createEditorRevealBroker(deps: EditorRevealBrokerDeps): EditorRevealBroker {
  const newRequestId = deps.newRequestId ?? randomUUID
  const waitMs = deps.waitMs ?? EDITOR_REVEAL_WAIT_MS
  const pending = new Map<string, EditorRevealRequest>()
  const revealWaiters = new Map<string, Waiter<EditorRevealShown | null>>()
  const stateWaiters = new Map<string, Waiter<EditorWindowState | null>>()
  // Requests that were queued because nobody answered in time. A window that
  // answers `opened` late did open it, so the queued copy must go, or the
  // person would see it twice.
  const queuedRequestIds = new Map<string, string>()
  let disposed = false

  const publishPending = (): void => deps.broadcastPending([...pending.keys()])

  function liveTargets(): EditorRevealTarget[] {
    return deps.targets().filter((target) => !target.isDestroyed())
  }

  /**
   * Send one question to every window and wait for the first positive answer,
   * or for every window to decline, or for the clock. Resolves with the
   * positive answer, or null.
   */
  function ask<T>(
    waiters: Map<string, Waiter<T | null>>,
    requestId: string,
    channel: string,
    payload: unknown,
  ): Promise<T | null> {
    const targets = liveTargets()
    if (targets.length === 0 || disposed) return Promise.resolve(null)
    return new Promise<T | null>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null
      const settle = (value: T | null): void => {
        if (!waiters.has(requestId)) return
        waiters.delete(requestId)
        if (timer) clearTimeout(timer)
        resolve(value)
      }
      // In place before anything is sent: a window answering in the same tick
      // must find someone listening.
      waiters.set(requestId, { expected: new Set(targets.map((target) => target.id)), settle })
      timer = setTimeout(() => settle(null), waitMs)
      for (const target of targets) target.send(channel, payload)
    })
  }

  function decline<T>(waiters: Map<string, Waiter<T | null>>, requestId: string, from: unknown): void {
    const waiter = waiters.get(requestId)
    if (!waiter || !waiter.expected.has(from)) return
    waiter.expected.delete(from)
    if (waiter.expected.size === 0) waiter.settle(null)
  }

  return {
    async reveal(input) {
      const request: EditorRevealRequest = { ...input, requestId: newRequestId() }
      const shown = await ask<EditorRevealShown>(
        revealWaiters,
        request.requestId,
        EDITOR_REVEAL_REQUEST_CHANNEL,
        request,
      )
      if (shown) return { shown }
      if (disposed) return { shown: 'not_visible' }
      const replaced = pending.get(request.workspaceId)
      if (replaced) queuedRequestIds.delete(replaced.requestId)
      pending.set(request.workspaceId, request)
      queuedRequestIds.set(request.requestId, request.workspaceId)
      publishPending()
      return { shown: 'not_visible' }
    },

    claimPending(workspaceId) {
      const request = pending.get(workspaceId) ?? null
      if (!request) return null
      pending.delete(workspaceId)
      queuedRequestIds.delete(request.requestId)
      publishPending()
      return request
    },

    pendingWorkspaceIds: () => [...pending.keys()],
    hasPending: (workspaceId) => pending.has(workspaceId),

    async queryState(workspaceId) {
      const requestId = newRequestId()
      return ask<EditorWindowState>(stateWaiters, requestId, EDITOR_STATE_QUERY_CHANNEL, { requestId, workspaceId })
    },

    handleAck(from, payload) {
      const ack = readAck(payload)
      if (!ack) return
      const waiter = revealWaiters.get(ack.requestId)
      if (!waiter) {
        // A late `opened` for a request already queued: the window did show
        // it, so the queued copy is withdrawn.
        const queuedFor = queuedRequestIds.get(ack.requestId)
        if (ack.outcome === 'opened' && queuedFor && pending.get(queuedFor)?.requestId === ack.requestId) {
          pending.delete(queuedFor)
          queuedRequestIds.delete(ack.requestId)
          publishPending()
        }
        return
      }
      // Only a window this question went to may answer it.
      if (!waiter.expected.has(from)) return
      if (ack.outcome === 'opened') waiter.settle(ack.shown)
      else decline(revealWaiters, ack.requestId, from)
    },

    handleStateReply(from, payload) {
      const reply = readStateReply(payload)
      if (!reply) return
      const waiter = stateWaiters.get(reply.requestId)
      if (!waiter || !waiter.expected.has(from)) return
      if (reply.outcome === 'answered') waiter.settle(reply.state)
      else decline(stateWaiters, reply.requestId, from)
    },

    dispose() {
      disposed = true
      for (const waiter of [...revealWaiters.values()]) waiter.settle(null)
      for (const waiter of [...stateWaiters.values()]) waiter.settle(null)
      pending.clear()
      queuedRequestIds.clear()
    },
  }
}

function readAck(payload: unknown): EditorRevealAck | null {
  if (!isRecord(payload) || typeof payload.requestId !== 'string') return null
  if (payload.outcome === 'declined') return { requestId: payload.requestId, outcome: 'declined' }
  if (payload.outcome !== 'opened') return null
  const shown = payload.shown
  if (shown !== 'foreground' && shown !== 'background' && shown !== 'not_visible') return null
  return { requestId: payload.requestId, outcome: 'opened', shown }
}

function readStateReply(payload: unknown): EditorStateReply | null {
  if (!isRecord(payload) || typeof payload.requestId !== 'string') return null
  if (payload.outcome === 'declined') return { requestId: payload.requestId, outcome: 'declined' }
  if (payload.outcome !== 'answered' || !isRecord(payload.state)) return null
  const state = payload.state
  return {
    requestId: payload.requestId,
    outcome: 'answered',
    state: {
      windowVisible: state.windowVisible === true,
      active: isRecord(state.active) ? (state.active as EditorWindowState['active']) : null,
      openFiles: Array.isArray(state.openFiles)
        ? state.openFiles.filter((path): path is string => typeof path === 'string').slice(0, 200)
        : [],
      awaitingOwner: typeof state.awaitingOwner === 'number' && state.awaitingOwner >= 0 ? state.awaitingOwner : 0,
      ...(state.fileSurface === 'app' || state.fileSurface === 'popout' ? { fileSurface: state.fileSurface } : {}),
    },
  }
}
