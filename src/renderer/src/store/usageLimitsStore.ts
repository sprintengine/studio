import { create } from 'zustand'

import {
  usageLimitProviderOfConversation,
  type UsageLimitProvider,
  type UsageLimitSnapshot,
  type UsageLimitsState,
} from '../../../shared/usage-limits'

// The subscription usage limits as main last reported them (`usage-limits:*`),
// held once per window so the chat strips and the palette's dialog read one
// answer. Not persisted: main keeps the reading, and its cache, and answers
// the first read.
//
// Subscribed only while something draws it. Every chat strip of a Claude or
// Codex chat retains it as it mounts, and the last one to go lets the push go,
// so a window with no such chat open is never woken for a reading.

type UsageLimitsStore = {
  state: UsageLimitsState | null
  setState: (state: UsageLimitsState) => void
}

export const useUsageLimitsStore = create<UsageLimitsStore>()((set) => ({
  state: null,
  setState: (state) => set({ state }),
}))

type UsageLimitsApi = Partial<Pick<Window['api'], 'usageLimits' | 'onUsageLimitsChanged'>>

let holders = 0
let release: (() => void) | null = null

function subscribe(api: UsageLimitsApi): () => void {
  let pushed = false
  let cancelled = false
  const unsubscribe =
    typeof api.onUsageLimitsChanged === 'function'
      ? api.onUsageLimitsChanged((state) => {
          pushed = true
          useUsageLimitsStore.getState().setState(state)
        })
      : () => {}
  if (typeof api.usageLimits === 'function') {
    void api
      .usageLimits()
      .then((state) => {
        // A push that landed first is the newer of the two.
        if (!cancelled && !pushed) useUsageLimitsStore.getState().setState(state)
      })
      .catch(() => {})
  }
  return () => {
    cancelled = true
    unsubscribe()
  }
}

/** Keep the store on main's reading while the caller draws it. Returns the release. */
export function retainUsageLimits(
  api: UsageLimitsApi | null = typeof window === 'undefined' ? null : window.api,
): () => void {
  if (!api) return () => {}
  holders += 1
  if (holders === 1) release = subscribe(api)
  let released = false
  return () => {
    if (released) return
    released = true
    holders -= 1
    if (holders === 0) {
      release?.()
      release = null
    }
  }
}

/** The usage-limit provider a conversation provider reports as, or null for one with no plan limits here. */
export const usageLimitProviderOf = usageLimitProviderOfConversation

/** One provider's reading, or null when it has none to show. */
export function selectUsageLimitSnapshot(
  state: UsageLimitsState | null,
  provider: UsageLimitProvider | null,
): UsageLimitSnapshot | null {
  if (!state || !provider) return null
  return state.snapshots.find((snapshot) => snapshot.provider === provider) ?? null
}
