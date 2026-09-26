import { useCallback, useSyncExternalStore } from 'react'

const MAX_CONVERSATIONS = 100
const disclosureByConversation = new Map<string, Map<string, boolean>>()
const disclosureListeners = new Map<string, Set<() => void>>()
export type ConversationScrollMemory = { rowId?: string; offset: number; atEnd: boolean }
const scrollByConversation = new Map<string, ConversationScrollMemory>()

function touch<T>(store: Map<string, T>, key: string, create: () => T): T {
  const value = store.get(key) ?? create()
  store.delete(key)
  store.set(key, value)
  if (store.size > MAX_CONVERSATIONS) store.delete(store.keys().next().value!)
  return value
}

export function useConversationDisclosure(
  conversationKey: string,
  id: string,
  defaultOpen: boolean,
): [boolean, (next: boolean) => void] {
  const subscribe = useCallback(
    (notify: () => void) => {
      const listeners = touch(disclosureListeners, conversationKey, () => new Set())
      listeners.add(notify)
      return () => {
        listeners.delete(notify)
      }
    },
    [conversationKey],
  )
  const snapshot = useCallback(
    () => disclosureByConversation.get(conversationKey)?.get(id) ?? defaultOpen,
    [conversationKey, id, defaultOpen],
  )
  const open = useSyncExternalStore(subscribe, snapshot, snapshot)
  const change = useCallback(
    (next: boolean) => {
      touch(disclosureByConversation, conversationKey, () => new Map()).set(id, next)
      for (const notify of disclosureListeners.get(conversationKey) ?? []) notify()
    },
    [conversationKey, id],
  )
  return [open, change]
}

export function rememberConversationScroll(conversationKey: string, memory: ConversationScrollMemory): void {
  touch(scrollByConversation, conversationKey, () => memory)
  scrollByConversation.set(conversationKey, memory)
}

export function recalledConversationScroll(conversationKey: string): ConversationScrollMemory | undefined {
  const value = scrollByConversation.get(conversationKey)
  if (value !== undefined) touch(scrollByConversation, conversationKey, () => value)
  return value
}
