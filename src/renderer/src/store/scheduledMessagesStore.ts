import { create } from 'zustand'

import type { ScheduledMessagesState, ScheduledMessageUpdate } from '../../../shared/scheduled-messages'

// The messages a person scheduled into their chats, as main last reported
// them (`scheduled-messages:*`). Held once per window so every chat's tray
// reads one answer. Not persisted: main keeps them, in a file of its own.
//
// Subscribed only while something draws it: every chat that can schedule a
// message retains it as it mounts.

type ScheduledMessagesStore = {
  state: ScheduledMessagesState | null
  setState: (state: ScheduledMessagesState) => void
}

export const useScheduledMessagesStore = create<ScheduledMessagesStore>()((set) => ({
  state: null,
  setState: (state) => set({ state }),
}))

type ScheduledMessagesApi = Partial<
  Pick<Window['api'], 'scheduledMessages' | 'updateScheduledMessage' | 'onScheduledMessagesChanged'>
>

const defaultApi = (): ScheduledMessagesApi | null => (typeof window === 'undefined' ? null : window.api)

let holders = 0
let release: (() => void) | null = null

function subscribe(api: ScheduledMessagesApi): () => void {
  let pushed = false
  let cancelled = false
  const unsubscribe =
    typeof api.onScheduledMessagesChanged === 'function'
      ? api.onScheduledMessagesChanged((state) => {
          pushed = true
          useScheduledMessagesStore.getState().setState(state)
        })
      : () => {}
  if (typeof api.scheduledMessages === 'function') {
    void api
      .scheduledMessages()
      .then((state) => {
        // A push that landed first is the newer of the two.
        if (!cancelled && !pushed) useScheduledMessagesStore.getState().setState(state)
      })
      .catch(() => {})
  }
  return () => {
    cancelled = true
    unsubscribe()
  }
}

/** Keep the store on main's answer while the caller draws it. Returns the release. */
export function retainScheduledMessages(api: ScheduledMessagesApi | null = defaultApi()): () => void {
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

/** Whether this window can schedule a message at all: main answers the channel. */
export function canScheduleMessages(api: ScheduledMessagesApi | null = defaultApi()): boolean {
  return typeof api?.updateScheduledMessage === 'function'
}

/**
 * Ask main for a change; the store takes main's answer, which is the state
 * after it. False when main could not be asked or did not answer.
 */
export async function updateScheduledMessage(
  update: ScheduledMessageUpdate,
  api: ScheduledMessagesApi | null = defaultApi(),
): Promise<boolean> {
  if (typeof api?.updateScheduledMessage !== 'function') return false
  try {
    useScheduledMessagesStore.getState().setState(await api.updateScheduledMessage(update))
    return true
  } catch {
    // Main did not answer: the push that follows a change it made says so.
    return false
  }
}
