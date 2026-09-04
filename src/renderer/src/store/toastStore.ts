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

// A button on a toast. ONE toast carries these: the CLI-update toast (owner
// ruling 2026-09-04 — "Update available: Codex 0.153.3" with Settings and
// Update). Every other toast stays button-free; the design-system toast
// spec names this variant and the lint pins it.
export type ToastAction = {
  id: string
  label: string
  primary?: boolean
  run: () => void
}

export type AppToast = {
  id: string
  tone: Tone
  title: string
  description?: string
  /** True when the producer supplied the id (it may retract); such toasts never title-dedupe. */
  stableId?: boolean
  actions?: ToastAction[]
  /** An agent CLI's glyph in place of the tone dot (the CLI-update toast). */
  cli?: string
  /** Override the tone's auto-dismiss: `false` keeps the toast until acted on. */
  autoDismissMs?: number | false
}

export type ShowToastInput = {
  tone: Tone
  title: string
  description?: string
  /**
   * A stable identity for a toast that a producer will later RETRACT
   * (`pair-request:<id>`, `fleet:<connectionId>`). Showing again under the
   * same id replaces the toast in place and keeps the id, so the producer's
   * handle never goes stale. Id-less toasts dedupe on (tone, title) instead.
   * A replaced toast keeps its React key, so a polite tone's auto-dismiss
   * clock is NOT restarted by a re-show; producers that retract use warn.
   */
  id?: string
  actions?: ToastAction[]
  cli?: string
  autoDismissMs?: number | false
}

interface ToastStore {
  /** Oldest first: the region renders top-to-bottom, so newest lands at the bottom (spec). */
  toasts: AppToast[]
  showToast: (input: ShowToastInput) => string
  dismissToast: (id: string) => void
}

let nextToastId = 0

/**
 * The stack stays a report, not a backlog: a repeat of the SAME report
 * (the same stable id, or for id-less toasts the same tone + title) replaces
 * its predecessor in place — a drag that fails five times is one "File
 * action failed", freshly worded, exactly what the old self-replacing inline
 * toast did — and the region holds at most this many,
 * shedding the OLDEST auto-dismissing toast first. Persistent tones
 * (warn/error) are only ever shed by another persistent one arriving, so an
 * error cannot be pushed out by a parade of successes.
 */
const MAX_TOASTS = 6
const PERSISTENT_TONES: ReadonlySet<AppToast['tone']> = new Set(['warn', 'error'])

export const useToastStore = create<ToastStore>()((set) => ({
  toasts: [],

  showToast: (input) => {
    const id = input.id ?? `toast-${++nextToastId}`
    set((state) => {
      // A stable id replaces ONLY its own predecessor and keeps the id — a
      // producer holding it must still be able to retract. Title-dedupe is
      // for id-less reports alone, so two machines' "Connection lost" never
      // collapse into one.
      const replaced = input.id
        ? state.toasts.find((toast) => toast.id === input.id)
        : state.toasts.find((toast) => !toast.stableId && toast.tone === input.tone && toast.title === input.title)
      const stableId = input.id !== undefined
      let toasts = replaced
        ? state.toasts.map((toast) => (toast === replaced ? { ...toast, ...input, id, stableId } : toast))
        : [...state.toasts, { ...input, id, stableId }]
      if (toasts.length > MAX_TOASTS) {
        const shed =
          toasts.find((toast) => !PERSISTENT_TONES.has(toast.tone)) ?? toasts[0]
        toasts = toasts.filter((toast) => toast !== shed)
      }
      return { toasts }
    })
    return id
  },

  dismissToast: (id) =>
    set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) })),
}))

/** Imperative door for non-component producers (event bridges, utilities). */
export function showToast(input: ShowToastInput): string {
  return useToastStore.getState().showToast(input)
}
