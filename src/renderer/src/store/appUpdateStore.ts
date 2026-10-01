import { create } from 'zustand'

import type { AppUpdateState } from '../../../shared/electron-api'

// The app update as main last reported it (update-service's `update:state-changed`),
// held once per window so everything that reads it reads the same answer: the
// General tab's version row, and the badges on the Settings rail glyph and on
// General in the Settings nav (owner ruling 2026-09-25). Before this each reader
// kept its own copy — the version row in the panel's local state, the ready
// toast in a closure — which is two answers to one question the moment a badge
// needs a third.
//
// Not persisted: main is the source, and it answers `update:get-state` on every
// window's first read.

type AppUpdateStore = {
  state: AppUpdateState | null
  setState: (state: AppUpdateState) => void
}

export const useAppUpdateStore = create<AppUpdateStore>()((set) => ({
  state: null,
  setState: (state) => set({ state }),
}))

type AppUpdateApi = Partial<Pick<Window['api'], 'updateGetState' | 'onUpdateStateChanged'>>

/**
 * Keep the store on main's answer: the current state once, then every change
 * main pushes. Returns the unsubscribe. Safe to call from more than one place
 * (the window's shell and the Settings panel both do, so a panel mounted on
 * its own still has the state) — every call writes the same value.
 *
 * The first read never overwrites a push that landed before it: the read was
 * asked first, so its answer is the older of the two.
 */
export function subscribeAppUpdateState(
  api: AppUpdateApi | null = typeof window === 'undefined' ? null : window.api,
): () => void {
  if (!api) return () => {}
  let pushed = false
  let cancelled = false
  const unsubscribe =
    typeof api.onUpdateStateChanged === 'function'
      ? api.onUpdateStateChanged((state) => {
          pushed = true
          useAppUpdateStore.getState().setState(state)
        })
      : () => {}
  if (typeof api.updateGetState === 'function') {
    void api
      .updateGetState()
      .then((state) => {
        if (!cancelled && !pushed) useAppUpdateStore.getState().setState(state)
      })
      .catch(() => {})
  }
  return () => {
    cancelled = true
    unsubscribe()
  }
}
