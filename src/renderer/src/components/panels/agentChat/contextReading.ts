import type { ConversationUsage } from './conversationProjection'

// How full a conversation's context window is, for the composer strip's ring
// and the tray's "nearly full" row — one reading, so the two cannot disagree.
//
// The window is the runtime's own report first (Claude Code names it on every
// turn's result, Codex on every usage update, an ACP agent on its own), then
// the CLI model catalog's size for the chat's model, then a provider catalog's
// `contextLength` (an OpenAI-compatible provider's). The spend is the runtime's
// `contextUsed` — the latest request's size — where it says it, else the last
// exchange's input and output, which for a provider that makes one request per
// turn is the same thing.

export type ContextReading = { used: number; total: number }

export function conversationContextReading({
  usage,
  catalogWindow,
  providerContextLength,
}: {
  usage: ConversationUsage | null
  /** The CLI model catalog's window for the chat's model, where it lists one. */
  catalogWindow?: number | null
  /** The provider catalog's context length for the chat's model, where it lists one. */
  providerContextLength?: number | null
}): ContextReading | null {
  // No report yet is no reading: a ring at 0% and a ring for a session that
  // has said nothing are the same picture, and one of them is a lie.
  if (!usage) return null
  const total = usage.contextWindow ?? positive(catalogWindow) ?? positive(providerContextLength)
  if (total === undefined) return null
  const used = usage.contextUsed ?? usage.inputTokens + usage.outputTokens
  if (!(used > 0)) return null
  return { used, total }
}

function positive(value: number | null | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}
