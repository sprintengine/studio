/**
 * Who gets a WebGL context, among this window's terminals.
 *
 * Chromium allows sixteen live WebGL contexts per renderer process and, past
 * that, silently takes one away from the OLDEST. Every terminal used to load
 * WebGL at mount — including the ones in hidden, retained workspace layers —
 * so a window with a few busy workspaces went past sixteen, and the terminal
 * that lost its context was usually the first one opened: the one the person
 * was still typing in. `terminalWebglRenderer.ts` then fell back to the DOM
 * renderer for good, and that pane stayed on the slow path until it was
 * closed.
 *
 * The budget fixes both halves. A terminal holds a context only while it is
 * worth one:
 *
 * - `on-screen` — the active layer's visible tab in a visible window. Acquires
 *   one, evicting another holder if the budget is full.
 * - `parked` — rendered but not seen: a warm layer, a tab behind another tab,
 *   a hidden window. Keeps a context it already has, so flicking back is free,
 *   but never acquires one, and is the first to give it up under pressure
 *   (least recently on screen first).
 * - `off` — a cold layer, or gone from the document. Gives its context back.
 *
 * and a lost context is re-acquired rather than abandoned: a GPU reset or a
 * driver update takes every context at once, and the right answer is a short
 * back-off and a fresh addon, not the DOM renderer forever. A machine that
 * keeps losing them (MAX_RECOVERIES inside LOSS_WINDOW_MS) is left on the DOM
 * renderer, which is correct, merely slower.
 *
 * This module is pure: presence is a callback, attaching and detaching are
 * callbacks, time is injected. `createStudioTerminal.ts` supplies the xterm
 * side and `terminalWebglPresence.ts` the DOM side.
 */

/**
 * The most contexts this window's terminals may hold at once. Under Chromium's
 * sixteen with room to spare for anything else in the page that opens one, so
 * the browser's own eviction — which picks the oldest context, not the least
 * useful — never runs.
 */
export const TERMINAL_WEBGL_CONTEXT_LIMIT = 12

/** Back-off before each re-acquire after a context loss. */
export const WEBGL_RECOVERY_DELAYS_MS = [250, 1_000, 4_000] as const
const MAX_RECOVERIES = WEBGL_RECOVERY_DELAYS_MS.length
const LOSS_WINDOW_MS = 60_000

export type TerminalWebglPresence = 'on-screen' | 'parked' | 'off'

export type WebglBudgetMember = {
  presence(): TerminalWebglPresence
  /**
   * Load the renderer. `'webgl'` when a context is live, `'unavailable'` when
   * the GPU refused, `'lost'` when it was lost before the load finished (the
   * member has already reported that through `contextLost`).
   */
  attach(): 'webgl' | 'unavailable' | 'lost'
  /** Unload it; the DOM renderer takes over. Only called while holding. */
  detach(): void
}

export type WebglBudgetLease = {
  /** Re-read presence and acquire, keep or release accordingly. */
  update(): void
  /** The context was lost (the renderer already fell back). Schedules a re-acquire. */
  contextLost(): void
  holding(): boolean
  /** The terminal is being torn down. Releases without calling `detach`. */
  dispose(): void
}

export type TerminalWebglBudget = {
  join(member: WebglBudgetMember): WebglBudgetLease
  /** Re-read every member — a layer revealed, the window shown or hidden. */
  updateAll(): void
  liveCount(): number
}

type Entry = {
  member: WebglBudgetMember
  holding: boolean
  // Set once this pane's GPU refused (or kept losing contexts), so it never asks again.
  unavailable: boolean
  lastOnScreenAt: number
  losses: number[]
  retryTimer: unknown
  disposed: boolean
}

export type TerminalWebglBudgetDeps = {
  limit?: number
  now?: () => number
  setTimer?: (handler: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export function createTerminalWebglBudget(deps: TerminalWebglBudgetDeps = {}): TerminalWebglBudget {
  const limit = Math.max(1, deps.limit ?? TERMINAL_WEBGL_CONTEXT_LIMIT)
  const now = deps.now ?? (() => performance.now())
  const setTimer = deps.setTimer ?? ((handler, ms) => setTimeout(handler, ms))
  const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  const entries = new Set<Entry>()

  const liveCount = (): number => {
    let count = 0
    for (const entry of entries) if (entry.holding) count += 1
    return count
  }

  const release = (entry: Entry): void => {
    if (!entry.holding) return
    entry.holding = false
    try {
      entry.member.detach()
    } catch (error) {
      console.warn('[terminalWebglBudget] detach failed', error)
    }
  }

  // Make room for one more. Evicts the holder nobody can see that was on screen
  // longest ago — `off` before `parked` — and never one that is on screen.
  const makeRoom = (requester: Entry): boolean => {
    if (liveCount() < limit) return true
    let victim: Entry | null = null
    let victimRank = -1
    for (const entry of entries) {
      if (entry === requester || !entry.holding) continue
      const presence = entry.member.presence()
      if (presence === 'on-screen') continue
      const rank = presence === 'off' ? 1 : 0
      if (
        victim === null ||
        rank > victimRank ||
        (rank === victimRank && entry.lastOnScreenAt < victim.lastOnScreenAt)
      ) {
        victim = entry
        victimRank = rank
      }
    }
    if (!victim) return false
    release(victim)
    return true
  }

  const update = (entry: Entry): void => {
    if (entry.disposed) return
    const presence = entry.member.presence()
    if (presence === 'off') {
      release(entry)
      return
    }
    if (presence === 'parked') return
    entry.lastOnScreenAt = now()
    if (entry.holding || entry.unavailable || entry.retryTimer !== null) return
    if (!makeRoom(entry)) return
    let outcome: 'webgl' | 'unavailable' | 'lost'
    try {
      outcome = entry.member.attach()
    } catch {
      outcome = 'unavailable'
    }
    if (outcome === 'webgl') entry.holding = true
    else if (outcome === 'unavailable') entry.unavailable = true
  }

  // A context came free: an on-screen terminal the budget turned away earlier
  // may have it now.
  const offerFreedContext = (): void => {
    for (const entry of entries) {
      if (liveCount() >= limit) return
      if (entry.holding || entry.disposed) continue
      update(entry)
    }
  }

  const contextLost = (entry: Entry): void => {
    if (entry.disposed) return
    entry.holding = false
    const at = now()
    entry.losses = entry.losses.filter((lostAt) => at - lostAt < LOSS_WINDOW_MS)
    entry.losses.push(at)
    if (entry.losses.length > MAX_RECOVERIES) {
      // Losing it this often is the GPU telling us something. The DOM renderer
      // is correct, only slower; stop asking.
      entry.unavailable = true
      offerFreedContext()
      return
    }
    if (entry.retryTimer !== null) clearTimer(entry.retryTimer)
    const delay = WEBGL_RECOVERY_DELAYS_MS[entry.losses.length - 1] ?? WEBGL_RECOVERY_DELAYS_MS[0]
    entry.retryTimer = setTimer(() => {
      entry.retryTimer = null
      update(entry)
    }, delay)
    offerFreedContext()
  }

  return {
    join(member) {
      const entry: Entry = {
        member,
        holding: false,
        unavailable: false,
        lastOnScreenAt: Number.NEGATIVE_INFINITY,
        losses: [],
        retryTimer: null,
        disposed: false,
      }
      entries.add(entry)
      return {
        update: () => {
          const wasHolding = entry.holding
          update(entry)
          if (wasHolding && !entry.holding) offerFreedContext()
        },
        contextLost: () => contextLost(entry),
        holding: () => entry.holding,
        dispose: () => {
          if (entry.disposed) return
          entry.disposed = true
          if (entry.retryTimer !== null) clearTimer(entry.retryTimer)
          entry.retryTimer = null
          const wasHolding = entry.holding
          entry.holding = false
          entries.delete(entry)
          if (wasHolding) offerFreedContext()
        },
      }
    },
    updateAll() {
      // Releases first, so a reveal that swaps one layer's terminals for
      // another's hands the contexts across instead of evicting for them.
      const ordered = [...entries].sort(
        (a, b) => Number(a.member.presence() === 'on-screen') - Number(b.member.presence() === 'on-screen'),
      )
      for (const entry of ordered) update(entry)
      offerFreedContext()
    },
    liveCount,
  }
}
