import type { ConversationWireKey } from './conversation.js'

// How a request names a conversation: its workspace and its agent, as on the
// tailnet. A chat started in a run worktree is kept in that worktree rather
// than in its workspace's folder, so an owner may name the folder too
// (`workspaceRoot`, behind the `conversation-folders` capability); a Studio
// refuses it from anyone else, since a folder is a path on its disk.

/** The conversation a request addresses. */
export type StudioConversationKey = ConversationWireKey & {
  /** Owners only: the folder the conversation is kept in, when it is not its workspace's. */
  workspaceRoot?: string
}

/** The longest path a request may name. */
export const STUDIO_MAX_PATH_CHARS = 4096

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function id(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200
}

/** A path a request may carry: non-empty, bounded, without a NUL. */
export function isStudioPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= STUDIO_MAX_PATH_CHARS && !value.includes('\0')
}

/** A conversation key, or null. A `workspaceRoot` that is not a path makes the key no key. */
export function parseStudioConversationKey(value: unknown): StudioConversationKey | null {
  if (!record(value) || !id(value.workspaceId) || !id(value.agentId)) return null
  if (value.workspaceRoot === undefined) return { workspaceId: value.workspaceId, agentId: value.agentId }
  if (!isStudioPath(value.workspaceRoot)) return null
  return { workspaceId: value.workspaceId, agentId: value.agentId, workspaceRoot: value.workspaceRoot }
}
