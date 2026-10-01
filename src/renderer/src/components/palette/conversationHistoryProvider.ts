import type { ConversationThread } from '../../../../shared/conversation-index'
import { commandMatchesQuery } from '../commandPaletteSearch'
import { openConversationHistory } from '../../utils/conversationHistoryNavigation'
import type { PaletteCommand, PaletteResultProvider } from './paletteProvider'

/** Transcript search shares the Chats scope with live tabs and parked workspaces. */
export function createConversationHistoryProvider(): PaletteResultProvider {
  let requestId: string | null = null
  let generation = 0
  let stopBatches: (() => void) | undefined
  const cancel = (): void => {
    generation++
    stopBatches?.()
    stopBatches = undefined
    if (requestId) void window.api.conversationCancelSearch({ requestId }).catch(() => undefined)
    requestId = null
  }
  return {
    id: 'conversation-history',
    group: 'agents',
    debounceMs: 150,
    respondsToEmptyQuery: true,
    cancel,
    async load(query, context, publish) {
      cancel()
      if (!context.workspaceRoot || !context.workspaceId || typeof window.api.conversationThreads !== 'function')
        return []
      const epoch = generation
      const key = { workspaceRoot: context.workspaceRoot, workspaceId: context.workspaceId }
      const result = await window.api.conversationThreads(key)
      if (epoch !== generation) return []
      if (!result.ok) throw new Error(result.message)
      const row = (thread: ConversationThread, snippet?: string, seq?: number): PaletteCommand => ({
        id: `conversation:${key.workspaceId}:${thread.agentId}:${seq ?? 'title'}`,
        label: thread.title,
        searchLabel: thread.title,
        description: snippet ?? `${thread.model} · ${thread.turnCount} turns`,
        keywords: snippet,
        group: 'agents',
        badge: snippet ? 'Message' : 'Saved chat',
        run: () => {
          context.close()
          openConversationHistory(key.workspaceId, thread, seq)
        },
      })
      const titles = result.threads
        .filter((thread) => commandMatchesQuery({ label: thread.title }, query))
        .map((thread) => row(thread))
      if (!query.trim()) return titles.slice(0, 50)
      const id = crypto.randomUUID()
      requestId = id
      const byId = new Map(result.threads.map((thread) => [thread.agentId, thread]))
      const contentRows = (hits: import('../../../../shared/conversation-index').ConversationSearchHit[]) =>
        hits.flatMap((hit) => {
          const thread = byId.get(hit.agentId)
          return thread ? [row(thread, hit.snippet, hit.seq)] : []
        })
      let streamed: PaletteCommand[] = []
      publish?.(titles)
      stopBatches = window.api.onConversationSearchBatch?.((batch) => {
        if (epoch !== generation || batch.requestId !== id) return
        streamed = [...streamed, ...contentRows(batch.hits)].slice(0, 200)
        publish?.([...titles, ...streamed].slice(0, 200))
      })
      try {
        const search = await window.api.conversationSearch({ ...key, query, requestId: id })
        if (epoch !== generation) return []
        if (!search.ok) throw new Error(search.message)
        return [...titles, ...contentRows(search.hits)].slice(0, 200)
      } finally {
        if (epoch === generation) {
          requestId = null
          stopBatches?.()
          stopBatches = undefined
        }
      }
    },
  }
}
