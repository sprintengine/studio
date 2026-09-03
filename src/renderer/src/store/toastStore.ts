import { create } from 'zustand'

import type { Tone } from '../components/ui/tokens'

// The transient-report store behind the app's ONE toast region
// (design-system/components/toast — MC: remote-sessions-ux / toast-host-region).
//
// Deliberately not persisted and deliberately tiny: a toast is the answer to
// "did it work?" in one line, and whatever it announces must also be readable
// somewhere persistent — the row's status, the detail pane, the notification
// bell. A person who missed a toast lost nothing they cannot find, so nothing
// here survives a reload.
//
// Auto-dismiss stays the PRIMITIVE's policy (polite tones 5s, warn/error never)
// — the store only holds what is showing and removes what was dismissed.

export type AppToast = {
  id: string
  tone: Tone
  title: string
  description?: string
}

export type ShowToastInput = {
  tone: Tone
  title: string
  description?: string
}

interface ToastStore {
  /** Oldest first: the region renders top-to-bottom, so newest lands at the bottom (spec). */
  toasts: AppToast[]
  showToast: (input: ShowToastInput) => string
  dismissToast: (id: string) => void
}

let nextToastId = 0

export const useToastStore = create<ToastStore>()((set) => ({
  toasts: [],

  showToast: (input) => {
    const id = `toast-${++nextToastId}`
    set((state) => ({ toasts: [...state.toasts, { id, ...input }] }))
    return id
  },

  dismissToast: (id) =>
    set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) })),
}))

/** Imperative door for non-component producers (event bridges, utilities). */
export function showToast(input: ShowToastInput): string {
  return useToastStore.getState().showToast(input)
}
