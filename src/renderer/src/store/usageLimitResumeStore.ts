import { create } from 'zustand'

import type {
  UsageLimitResumeChat,
  UsageLimitResumeNotice,
  UsageLimitResumeState,
  UsageLimitResumeUpdate,
} from '../../../shared/usage-limit-resume'

// The chats a usage limit stopped and the resume each has, as main last
// reported them (`usage-limit-resumes:*`), with the setting that schedules one
// for every such chat. Held once per window so every chat's tray and Settings
// read one answer. Not persisted: main keeps them, in a file of its own.
//
// Subscribed only while something draws it: every Claude or Codex chat
// retains it as it mounts, and Settings while its switch is on screen.

type UsageLimitResumeStore = {
  state: UsageLimitResumeState | null
  setState: (state: UsageLimitResumeState) => void
}

export const useUsageLimitResumeStore = create<UsageLimitResumeStore>()((set) => ({
  state: null,
  setState: (state) => set({ state }),
}))

type UsageLimitResumeApi = Partial<
  Pick<Window['api'], 'usageLimitResumes' | 'updateUsageLimitResume' | 'onUsageLimitResumesChanged'>
>

const defaultApi = (): UsageLimitResumeApi | null => (typeof window === 'undefined' ? null : window.api)

let holders = 0
let release: (() => void) | null = null

function subscribe(api: UsageLimitResumeApi): () => void {
  let pushed = false
  let cancelled = false
  const unsubscribe =
    typeof api.onUsageLimitResumesChanged === 'function'
      ? api.onUsageLimitResumesChanged((state) => {
          pushed = true
          useUsageLimitResumeStore.getState().setState(state)
        })
      : () => {}
  if (typeof api.usageLimitResumes === 'function') {
    void api
      .usageLimitResumes()
      .then((state) => {
        // A push that landed first is the newer of the two.
        if (!cancelled && !pushed) useUsageLimitResumeStore.getState().setState(state)
      })
      .catch(() => {})
  }
  return () => {
    cancelled = true
    unsubscribe()
  }
}

/** Keep the store on main's answer while the caller draws it. Returns the release. */
export function retainUsageLimitResumes(api: UsageLimitResumeApi | null = defaultApi()): () => void {
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

/** Ask main for a change; the store takes main's answer, which is the state after it. */
export async function updateUsageLimitResume(
  update: UsageLimitResumeUpdate,
  api: UsageLimitResumeApi | null = defaultApi(),
): Promise<void> {
  if (typeof api?.updateUsageLimitResume !== 'function') return
  try {
    useUsageLimitResumeStore.getState().setState(await api.updateUsageLimitResume(update))
  } catch {
    // Main did not answer: the push that follows a change it made says so.
  }
}

/** The chat's notice, or null when a usage limit has not stopped it. */
export function selectUsageLimitResumeNotice(
  state: UsageLimitResumeState | null,
  chat: UsageLimitResumeChat,
): UsageLimitResumeNotice | null {
  return (
    state?.notices.find((notice) => notice.workspaceId === chat.workspaceId && notice.agentId === chat.agentId) ?? null
  )
}
