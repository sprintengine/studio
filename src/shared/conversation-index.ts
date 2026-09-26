import type { ConversationKey } from './conversation-runtime'

export type ConversationWorkspaceKey = Pick<ConversationKey, 'workspaceRoot' | 'workspaceId'>
export type ConversationThread = {
  agentId: string
  title: string
  titleSource: 'first-message' | 'generated' | 'user'
  createdAt: number
  updatedAt: number
  turnCount: number
  model: string
  providerId: string
  lastSeq: number
  firstUserText: string
  totalCostUsd?: number
}
export type ConversationSearchInput = ConversationWorkspaceKey & { query: string; requestId?: string }
export type ConversationSearchHit = { agentId: string; seq: number; turnId?: string; snippet: string }
export type ConversationRenameInput = ConversationKey & { title: string }
export type ConversationThreadsResult = { ok: true; threads: ConversationThread[] } | { ok: false; message: string }
export type ConversationSearchResult = { ok: true; hits: ConversationSearchHit[] } | { ok: false; message: string }
