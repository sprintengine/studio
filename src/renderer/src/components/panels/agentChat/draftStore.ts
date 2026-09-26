import { createStore } from 'zustand/vanilla'
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware'

export const MAX_DRAFT_CHARS = 120_000
export const MAX_COMPOSER_DRAFTS = 200
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
function bounded(records: Record<string, ComposerDraft>): Record<string, ComposerDraft> {
  return Object.fromEntries(
    Object.entries(records)
      .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
      .slice(0, MAX_COMPOSER_DRAFTS),
  )
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
  return createStore<DraftState>()(
    persist(
      (set, get) => ({
        drafts: {},
        read: (workspaceId, agentId) => {
          const key = keyOf(workspaceId, agentId)
          const records = get().drafts
          const saved = records[key]
          if (!saved) return EMPTY_DRAFT
          const touched = { ...saved, updatedAt: nextAccess(records) }
          try {
            set({ drafts: { ...records, [key]: touched } })
          } catch {
            // Reading an existing draft must still work if storage is full.
            // Actual edits surface persistence failures through the composer.
          }
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
        storage: createJSONStorage(() => storage),
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
}
let sharedStore: ReturnType<typeof createComposerDraftStore> | undefined
export function composerDraftStore() {
  return (sharedStore ??= createComposerDraftStore(window.localStorage))
}
