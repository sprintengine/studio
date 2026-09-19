// The diff window's "Show in the app" hand-off, as a protocol.
//
// It lives apart from `window-ipc.ts` because it is the part with rules in it
// and `window-ipc.ts` imports `electron`, which a unit test cannot load. Nothing
// here knows what a BrowserWindow is: a target is something that can be asked
// and can be recognised again when it answers.
//
// Three things it is careful about, each of them a bug it was written to fix:
//
//   1. **One window at a time.** The hand-off used to be a broadcast, and every
//      window holding the workspace opened a Diff tab AND flipped the sticky
//      "diffs open in the app" preference. Two windows, two tabs, one person.
//      The offer goes to the most likely holder first and stops at the first
//      window that says it took it.
//   2. **The id is unguessable.** It was a process-wide counter, so any window
//      could ack a hand-off it was never sent by counting. `randomUUID` costs
//      nothing and ends the question.
//   3. **The ack is checked against the window it was asked of.** Matching the
//      id alone lets a window ack for another; both the sender and the id have
//      to line up.

import { randomUUID } from 'node:crypto'

/** What the receiving renderer is sent. */
export type DockDiffRequest = {
  requestId: string
  workspaceId: string
  repoRoot: string
  focusPath: string | null
  focusKind: 'staged' | 'unstaged' | null
  /** The changelist filter the diff window was showing; carried so the pane
   *  tab opens on the same list. Absent or null: all changes. */
  changelistId?: string | null
}

/** One window that might hold the workspace, as this protocol needs it. */
export type DockDiffTarget = {
  /** Identity, compared with the ack's sender. Opaque here — a BrowserWindow
   *  in the app, a string in a test. */
  id: unknown
  isDestroyed(): boolean
  send(request: DockDiffRequest): void
}

/** Called with the window an ack came FROM and the id it echoed. Returns the
 *  unsubscribe. */
export type DockDiffAckSubscribe = (listener: (from: unknown, requestId: unknown) => void) => () => void

/**
 * How long ONE window is given to answer. Long enough for a renderer that is
 * merely busy — a big status read, a re-layout — short enough that walking
 * three windows is still an answer rather than a hang.
 */
export const DOCK_DIFF_ACK_WAIT_MS = 700

/** The whole hand-off's budget, however many windows are open. Past this the
 *  diff window is told nobody took it and stays up saying so. */
export const DOCK_DIFF_ACK_TOTAL_MS = 2100

export type DockDiffOffer = {
  /** In the order they should be asked: most likely holder first. */
  targets: DockDiffTarget[]
  payload: Omit<DockDiffRequest, 'requestId'>
  subscribe: DockDiffAckSubscribe
  /** Overridable so a test does not have to wait out a real second. */
  waitMs?: number
  totalMs?: number
  newRequestId?: () => string
  now?: () => number
}

/**
 * Offer the diff to each window in turn and stop at the first that takes it.
 *
 * Sequential rather than parallel on purpose: acting on the request is what a
 * receiving window acks, so asking them all at once is a broadcast again — two
 * windows would have opened their tab before either answer came back.
 */
export async function offerDockDiff(offer: DockDiffOffer): Promise<boolean> {
  const newRequestId = offer.newRequestId ?? randomUUID
  const now = offer.now ?? Date.now
  const perWindow = offer.waitMs ?? DOCK_DIFF_ACK_WAIT_MS
  const deadline = now() + (offer.totalMs ?? DOCK_DIFF_ACK_TOTAL_MS)

  for (const target of offer.targets) {
    // A window can close while an earlier one is being waited on.
    if (target.isDestroyed()) continue
    const remaining = deadline - now()
    if (remaining <= 0) break
    const request: DockDiffRequest = { ...offer.payload, requestId: newRequestId() }
    const took = await askOneWindow(target, request, offer.subscribe, Math.min(perWindow, remaining))
    if (took) return true
  }
  return false
}

function askOneWindow(
  target: DockDiffTarget,
  request: DockDiffRequest,
  subscribe: DockDiffAckSubscribe,
  waitMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null
    let unsubscribe: (() => void) | null = null
    let settled = false
    const settle = (value: boolean): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      timer = null
      unsubscribe?.()
      unsubscribe = null
      resolve(value)
    }

    unsubscribe = subscribe((from, requestId) => {
      // BOTH, or it is not this window's answer to this question: the id alone
      // lets one window ack on another's behalf, and the sender alone lets a
      // stale ack from a previous offer land on this one.
      if (from !== target.id) return
      if (requestId !== request.requestId) return
      settle(true)
    })
    // Subscribed first: a renderer that answers inside the same tick must not
    // find nobody listening.
    if (settled) return
    timer = setTimeout(() => settle(false), waitMs)
    target.send(request)
  })
}
