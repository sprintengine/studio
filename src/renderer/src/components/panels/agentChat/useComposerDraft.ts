import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from 'react'
import { composerDraftStore, MAX_DRAFT_CHARS, type ComposerDraft } from './draftStore'

type DraftValue = Omit<ComposerDraft, 'updatedAt'>
export type ComposerDraftMetadata = Pick<DraftValue, 'skillIds' | 'mentions'>
const empty = (): DraftValue => ({ text: '', skillIds: [], mentions: [] })
const isEmpty = (value: DraftValue) => !value.text && !value.skillIds.length && !value.mentions.length

/** UI clears optimistically; persisted text remains recoverable until send is acknowledged. */
export function useComposerDraft(workspaceId: string, agentId: string, prefill = '') {
  const store = useMemo(() => composerDraftStore(), [])
  const key = JSON.stringify([workspaceId, agentId])
  const initial = useMemo(() => {
    const saved = store.getState().read(workspaceId, agentId)
    return {
      text: saved.updatedAt ? saved.text : prefill.slice(0, MAX_DRAFT_CHARS),
      skillIds: saved.skillIds,
      mentions: saved.mentions,
    }
  }, [store, workspaceId, agentId, prefill])
  const [state, setState] = useState({ key, value: initial })
  const current = state.key === key ? state.value : initial
  const values = useRef(new Map<string, DraftValue>())
  values.current.set(key, current)
  const pending = useRef(new Map<string, { token: symbol; snapshot: DraftValue }>())
  const activeKeys = useRef(new Set<string>())
  const [persistenceError, setPersistenceError] = useState<string | null>(null)
  const write = useCallback(
    (target: string, workspace: string, agent: string) => {
      const value = values.current.get(target) ?? empty()
      const protectedSend = pending.current.get(target)
      try {
        store.getState().put(workspace, agent, protectedSend && isEmpty(value) ? protectedSend.snapshot : value)
        setPersistenceError(null)
      } catch {
        setPersistenceError(
          'This draft could not be saved on this device. Keep this tab open or copy the text before closing it.',
        )
      }
    },
    [store],
  )
  const flushDraft = useCallback(() => write(key, workspaceId, agentId), [key, workspaceId, agentId, write])
  const update = useCallback(
    (value: DraftValue) => {
      values.current.set(key, value)
      setState({ key, value })
    },
    [key],
  )
  const setDraft = useCallback(
    (value: SetStateAction<string>) => {
      const previous = values.current.get(key) ?? initial
      update({
        ...previous,
        text: (typeof value === 'function' ? value(previous.text) : value).slice(0, MAX_DRAFT_CHARS),
      })
    },
    [key, initial, update],
  )
  const setDraftMetadata = useCallback(
    (metadata: SetStateAction<ComposerDraftMetadata>) => {
      const previous = values.current.get(key) ?? initial
      update({ ...previous, ...(typeof metadata === 'function' ? metadata(previous) : metadata) })
    },
    [key, initial, update],
  )
  useEffect(() => {
    const timer = window.setTimeout(flushDraft, 400)
    return () => window.clearTimeout(timer)
  }, [current, flushDraft])
  useEffect(() => {
    activeKeys.current.add(key)
    const flush = () => write(key, workspaceId, agentId)
    window.addEventListener('pagehide', flush)
    return () => {
      flush()
      activeKeys.current.delete(key)
      window.removeEventListener('pagehide', flush)
    }
  }, [key, workspaceId, agentId, write])

  const beginDraftSend = useCallback(
    (message: string): symbol | null => {
      const snapshot = values.current.get(key) ?? initial
      // A queued message is not the user's newer draft.
      if (snapshot.text.trim() !== message.trim()) return null
      const token = Symbol('draft-send')
      pending.current.set(key, { token, snapshot })
      update(empty())
      flushDraft()
      return token
    },
    [key, initial, update, flushDraft],
  )
  const finishDraftSend = useCallback(
    (token: symbol | null, succeeded: boolean) => {
      const attempt = pending.current.get(key)
      if (!token || attempt?.token !== token) return
      pending.current.delete(key)
      if (!activeKeys.current.has(key)) {
        const saved = store.getState().read(workspaceId, agentId)
        if (
          succeeded &&
          saved.text === attempt.snapshot.text &&
          JSON.stringify(saved.skillIds) === JSON.stringify(attempt.snapshot.skillIds) &&
          JSON.stringify(saved.mentions) === JSON.stringify(attempt.snapshot.mentions)
        ) {
          store.getState().remove(workspaceId, agentId)
        }
        return
      }
      if (!succeeded && isEmpty(values.current.get(key) ?? empty())) update(attempt.snapshot)
      flushDraft()
    },
    [key, update, flushDraft, store, workspaceId, agentId],
  )
  const clearDraft = useCallback(() => {
    pending.current.delete(key)
    update(empty())
    flushDraft()
  }, [key, update, flushDraft])
  return {
    draft: current.text,
    setDraft,
    draftMetadata: { skillIds: current.skillIds, mentions: current.mentions },
    setDraftMetadata,
    flushDraft,
    persistenceError,
    beginDraftSend,
    finishDraftSend,
    clearDraft,
  }
}
