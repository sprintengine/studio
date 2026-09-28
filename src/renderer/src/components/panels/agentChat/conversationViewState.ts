import { useCallback, useSyncExternalStore } from 'react'
import {
  createConversationViewWriter,
  MAX_DISCLOSURES_PER_CONVERSATION,
  MAX_REMEMBERED_CONVERSATIONS,
  readConversationViews,
  type ConversationScrollMemory,
  type RememberedConversationView,
} from './conversationViewStorage'

export type { ConversationScrollMemory }

// One LRU over both halves of a conversation's view, keyed by the chat's
// `${workspaceId}:${agentId}`. Both ids are persisted records (the workspace
// store, and the conversation log main keeps per agent), so the key names the
// same conversation after a restart and the remembered view can be read back.
let views: Map<string, RememberedConversationView> | null = null
let writer: ReturnType<typeof createConversationViewWriter> | null = null
const disclosureListeners = new Map<string, Set<() => void>>()

function browserStorage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage
  } catch {
    // A sandboxed or storage-disabled context throws on the accessor itself.
    return undefined
  }
}

// Read on first use rather than at import, so a test (or a window with no
// storage) that never touches the view state never touches storage either.
function state(): Map<string, RememberedConversationView> {
  if (views) return views
  const storage = browserStorage()
  views = new Map(readConversationViews(storage))
  if (storage) {
    writer = createConversationViewWriter(
      storage,
      () => [...views!],
      (keys) => {
        for (const key of keys) forget(key)
      },
    )
    // A quit or reload inside the write delay would otherwise lose the last
    // scroll: `pagehide` is the one the renderer reliably gets on close, and
    // `beforeunload` covers a reload that is not a navigation away.
    window.addEventListener('pagehide', writer.flush)
    window.addEventListener('beforeunload', writer.flush)
  }
  return views
}

function forget(key: string) {
  if (!views?.delete(key)) return
  for (const notify of disclosureListeners.get(key) ?? []) notify()
}

function touch(key: string): RememberedConversationView {
  const all = state()
  const view = all.get(key) ?? { disclosures: new Map() }
  all.delete(key)
  all.set(key, view)
  if (all.size > MAX_REMEMBERED_CONVERSATIONS) forget(all.keys().next().value!)
  return view
}

export function useConversationDisclosure(
  conversationKey: string,
  id: string,
  defaultOpen: boolean,
): [boolean, (next: boolean) => void] {
  const subscribe = useCallback(
    (notify: () => void) => {
      let listeners = disclosureListeners.get(conversationKey)
      if (!listeners) disclosureListeners.set(conversationKey, (listeners = new Set()))
      listeners.add(notify)
      return () => {
        listeners.delete(notify)
        if (!listeners.size) disclosureListeners.delete(conversationKey)
      }
    },
    [conversationKey],
  )
  const snapshot = useCallback(
    () => state().get(conversationKey)?.disclosures.get(id) ?? defaultOpen,
    [conversationKey, id, defaultOpen],
  )
  const open = useSyncExternalStore(subscribe, snapshot, snapshot)
  const change = useCallback(
    (next: boolean) => setConversationDisclosures(conversationKey, [id], next),
    [conversationKey, id],
  )
  return [open, change]
}

/** Sets several disclosures at once — an "expand all" over rows that each own one. */
export function setConversationDisclosures(conversationKey: string, ids: readonly string[], next: boolean): void {
  const { disclosures } = touch(conversationKey)
  for (const id of ids) {
    // Re-inserted, so the map's order is the order things were last toggled
    // and the cap drops what was touched longest ago.
    disclosures.delete(id)
    disclosures.set(id, next)
  }
  for (const id of disclosures.keys()) {
    if (disclosures.size <= MAX_DISCLOSURES_PER_CONVERSATION) break
    disclosures.delete(id)
  }
  writer?.schedule()
  for (const notify of disclosureListeners.get(conversationKey) ?? []) notify()
}

export function rememberConversationScroll(conversationKey: string, memory: ConversationScrollMemory): void {
  const view = touch(conversationKey)
  const previous = view.scroll
  // Whole pixels: a sub-pixel drift is not a new position worth a write.
  const next = { ...memory, offset: Math.round(memory.offset) }
  view.scroll = next
  // Every scroll event lands here; an unchanged position is not a write.
  if (previous?.rowId === next.rowId && previous?.offset === next.offset && previous?.atEnd === next.atEnd) return
  writer?.schedule()
}

export function recalledConversationScroll(conversationKey: string): ConversationScrollMemory | undefined {
  if (!state().has(conversationKey)) return undefined
  return touch(conversationKey).scroll
}
