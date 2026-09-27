import { createStore } from 'zustand/vanilla'
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware'

export const MAX_DRAFT_CHARS = 120_000
export const MAX_COMPOSER_DRAFTS = 200
// All drafts together stay well inside the origin's storage quota, which other
// renderer stores share: at 200 × 120k characters the blob alone would exceed it.
export const MAX_TOTAL_DRAFT_CHARS = 1_000_000
// Writes rewrite the whole blob, so a burst of edits and reads lands as one.
const WRITE_DELAY_MS = 250
export type { ConversationMentionRef as ComposerMentionRef } from '../../../../../shared/conversation/mentions'
import {
  parseConversationMentions,
  type ConversationMentionRef as ComposerMentionRef,
} from '../../../../../shared/conversation/mentions'
export type ComposerDraft = { text: string; skillIds: string[]; mentions: ComposerMentionRef[]; updatedAt: number }
export const EMPTY_DRAFT: ComposerDraft = { text: '', skillIds: [], mentions: [], updatedAt: 0 }
const keyOf = (workspaceId: string, agentId: string) => JSON.stringify([workspaceId, agentId])

function normalizeDraft(value: unknown): ComposerDraft | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Partial<ComposerDraft>
  if (typeof raw.text !== 'string' || typeof raw.updatedAt !== 'number' || !Number.isFinite(raw.updatedAt)) return null
  return {
    text: raw.text.slice(0, MAX_DRAFT_CHARS),
    skillIds: Array.isArray(raw.skillIds)
      ? raw.skillIds.filter((id): id is string => typeof id === 'string' && id.length <= 4096).slice(0, 32)
      : [],
    mentions: parseConversationMentions(raw.mentions) ?? [],
    updatedAt: raw.updatedAt,
  }
}
// Most recently used first, dropping the rest once either the draft count or
// the character budget is spent. The newest draft is always kept.
function bounded(records: Record<string, ComposerDraft>): Record<string, ComposerDraft> {
  let chars = 0
  const kept: [string, ComposerDraft][] = []
  for (const entry of Object.entries(records).sort((a, b) => b[1].updatedAt - a[1].updatedAt)) {
    chars += draftChars(entry[1])
    if (kept.length >= MAX_COMPOSER_DRAFTS || (kept.length > 0 && chars > MAX_TOTAL_DRAFT_CHARS)) break
    kept.push(entry)
  }
  return Object.fromEntries(kept)
}
const draftChars = (draft: ComposerDraft) =>
  draft.text.length + JSON.stringify(draft.skillIds).length + JSON.stringify(draft.mentions).length

/**
 * Storage that coalesces writes, and when the quota refuses one gives up the
 * least recently used drafts until the rest fit. `failed` reports whether the
 * last write landed, for the composer's warning; `flush` writes now.
 */
function draftStorage(storage: StateStorage) {
  let pending: { name: string; value: string } | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let failed = false
  const listeners = new Set<() => void>()
  const report = (next: boolean) => {
    if (next === failed) return
    failed = next
    for (const listener of listeners) listener()
  }
  const write = (name: string, value: string) => {
    let blob = value
    for (;;) {
      try {
        storage.setItem(name, blob)
        report(false)
        return
      } catch {
        const smaller = withoutOldestDraft(blob)
        if (smaller === null) break
        blob = smaller
      }
    }
    report(true)
  }
  const flush = () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
    const next = pending
    pending = null
    if (next) write(next.name, next.value)
  }
  const wrapped: StateStorage = {
    getItem: (name) => (pending?.name === name ? pending.value : storage.getItem(name)),
    setItem: (name, value) => {
      pending = { name, value }
      timer ??= setTimeout(flush, WRITE_DELAY_MS)
    },
    removeItem: (name) => {
      if (pending?.name === name) pending = null
      storage.removeItem(name)
    },
  }
  return {
    storage: wrapped,
    flush,
    failed: () => failed,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

// The persisted envelope minus its least recently used draft; null when only
// one is left (the one being edited) or the envelope is not ours.
function withoutOldestDraft(blob: string): string | null {
  try {
    const envelope = JSON.parse(blob) as { state?: { drafts?: Record<string, ComposerDraft> } }
    const drafts = envelope.state?.drafts
    if (!drafts || Object.keys(drafts).length <= 1) return null
    const oldest = Object.entries(drafts).sort((a, b) => a[1].updatedAt - b[1].updatedAt)[0][0]
    const rest = { ...drafts }
    delete rest[oldest]
    return JSON.stringify({ ...envelope, state: { ...envelope.state, drafts: rest } })
  } catch {
    return null
  }
}

type DraftState = {
  drafts: Record<string, ComposerDraft>
  read(workspaceId: string, agentId: string): ComposerDraft
  put(workspaceId: string, agentId: string, draft: Omit<ComposerDraft, 'updatedAt'>): void
  remove(workspaceId: string, agentId: string): void
}

/** Like other renderer view stores, only a validated, versioned data envelope persists. */
export function createComposerDraftStore(storage: StateStorage, now = Date.now) {
  // Keep a total access order even when several drafts are touched in one
  // millisecond, or the device clock moves backwards after a restart.
  const nextAccess = (records: Record<string, ComposerDraft>) =>
    Math.max(now(), ...Object.values(records).map((draft) => draft.updatedAt + 1))
  const persisted = draftStorage(storage)
  const store = createStore<DraftState>()(
    persist(
      (set, get) => ({
        drafts: {},
        read: (workspaceId, agentId) => {
          const key = keyOf(workspaceId, agentId)
          const records = get().drafts
          const saved = records[key]
          if (!saved) return EMPTY_DRAFT
          const touched = { ...saved, updatedAt: nextAccess(records) }
          set({ drafts: { ...records, [key]: touched } })
          return touched
        },
        put: (workspaceId, agentId, draft) => {
          const value = normalizeDraft({ ...draft, updatedAt: nextAccess(get().drafts) })!
          if (!value.text && !value.skillIds.length && !value.mentions.length) {
            get().remove(workspaceId, agentId)
            return
          }
          set((state) => ({ drafts: bounded({ ...state.drafts, [keyOf(workspaceId, agentId)]: value }) }))
        },
        remove: (workspaceId, agentId) =>
          set((state) => {
            const drafts = { ...state.drafts }
            delete drafts[keyOf(workspaceId, agentId)]
            return { drafts }
          }),
      }),
      {
        name: 'sprintengine-conversation-drafts',
        version: 1,
        storage: createJSONStorage(() => persisted.storage),
        partialize: (state) => ({ drafts: state.drafts }),
        merge: (persisted, current) => {
          const raw = persisted && typeof persisted === 'object' && 'drafts' in persisted ? persisted.drafts : null
          const drafts: Record<string, ComposerDraft> = Object.create(null)
          if (raw && typeof raw === 'object')
            for (const [key, candidate] of Object.entries(raw)) {
              const value = normalizeDraft(candidate)
              if (value) drafts[key] = value
            }
          return { ...current, drafts: bounded(drafts) }
        },
      },
    ),
  )
  return Object.assign(store, {
    flushDrafts: persisted.flush,
    draftWriteFailed: persisted.failed,
    subscribeDraftWrites: persisted.subscribe,
  })
}
let sharedStore: ReturnType<typeof createComposerDraftStore> | undefined
export function composerDraftStore() {
  return (sharedStore ??= createComposerDraftStore(window.localStorage))
}
