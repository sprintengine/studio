import type {
  ConversationEventType,
  ConversationToolOutputPayload,
  ConversationToolStartedPayload,
} from '../../shared/conversation-runtime'

/**
 * One event of an imported chat, before the runtime stamps the identity every
 * transcript event carries (its id, sequence, session and agent).
 */
export type ImportedEvent = {
  type: ConversationEventType
  createdAt: number
  payload: Record<string, unknown>
}

/** A CLI session read back as a chat's history. */
export type ImportedConversation = {
  events: ImportedEvent[]
  /** The title the CLI gave the session, when it gave one. */
  title: string | null
  /** The person's first message, which names the chat when the CLI did not. */
  firstPrompt: string | null
  startedAt: number
  /** The last thing that happened in it. */
  updatedAt: number
}

/**
 * Writes a session's history in the chat's own vocabulary, one turn per
 * message the person sent: each opens with their message and closes when the
 * next one arrives or the history ends. What a CLI recorded before the first
 * message (a resumed session's preamble) belongs to no turn and is left out,
 * and a step still open when its turn closes is marked stopped, since nothing
 * is going to finish it now.
 *
 * Times only move forward, so an entry a CLI stamped out of order still sorts
 * where it was written.
 */
export class ImportedTranscriptBuilder {
  private readonly events: ImportedEvent[] = []
  private turnId: string | null = null
  private turns = 0
  private lastAt = 0
  private lastWasText = false
  private readonly openTools = new Set<string>()
  private firstPrompt: string | null = null
  private startedAt: number | null = null

  constructor(private readonly fallbackAt: number) {}

  get hasTurns(): boolean {
    return this.turns > 0
  }

  userMessage(text: string, at: number | null): void {
    const message = text.trim()
    if (!message) return
    const time = this.stamp(at)
    this.closeTurn(time)
    this.turns += 1
    this.turnId = `turn_import_${this.turns}`
    this.firstPrompt ??= message
    this.startedAt ??= time
    this.push('user_message', time, { turnId: this.turnId, text: message })
    this.push('turn_started', time, { turnId: this.turnId })
  }

  assistantText(text: string, at: number | null): void {
    if (!this.turnId || !text.trim()) return
    // Two replies in a row are two paragraphs, not one run-on sentence.
    this.push('content_delta', this.stamp(at), { turnId: this.turnId, text: this.lastWasText ? `\n\n${text}` : text })
    this.lastWasText = true
  }

  reasoning(text: string, at: number | null): void {
    if (!this.turnId || !text.trim()) return
    this.push('reasoning_delta', this.stamp(at), { turnId: this.turnId, text: `\n\n${text}` })
  }

  toolStarted(payload: Omit<ConversationToolStartedPayload, 'turnId'>, at: number | null): void {
    if (!this.turnId || !payload.toolUseId) return
    this.openTools.add(payload.toolUseId)
    this.push('tool_started', this.stamp(at), { ...payload, turnId: this.turnId })
  }

  toolOutput(payload: Omit<ConversationToolOutputPayload, 'turnId'>, at: number | null): void {
    // Only the answer to a call this history showed: one whose call fell
    // before the first message has no row to land in.
    if (!this.turnId || !payload.toolUseId || !this.openTools.delete(payload.toolUseId)) return
    this.push('tool_output', this.stamp(at), { ...payload, turnId: this.turnId })
  }

  compacted(at: number | null, payload: Record<string, unknown> = {}): void {
    if (!this.turnId) return
    this.push('context_compacted', this.stamp(at), { ...payload, turnId: this.turnId })
  }

  finish(title: string | null): ImportedConversation {
    this.closeTurn(this.lastAt || this.fallbackAt)
    return {
      events: this.events,
      title: title?.trim() || null,
      firstPrompt: this.firstPrompt,
      startedAt: this.startedAt ?? this.fallbackAt,
      updatedAt: this.lastAt || this.fallbackAt,
    }
  }

  private closeTurn(at: number): void {
    if (!this.turnId) return
    for (const toolUseId of this.openTools)
      this.push('tool_output', at, {
        turnId: this.turnId,
        toolUseId,
        toolCallId: toolUseId,
        output: '',
        status: 'stopped',
        isError: false,
      })
    this.openTools.clear()
    this.push('turn_completed', at, { turnId: this.turnId })
    this.turnId = null
  }

  private push(type: ConversationEventType, createdAt: number, payload: Record<string, unknown>): void {
    if (type !== 'content_delta') this.lastWasText = false
    this.events.push({ type, createdAt, payload })
  }

  private stamp(at: number | null): number {
    const time = at !== null && Number.isFinite(at) && at > 0 ? at : this.lastAt || this.fallbackAt
    this.lastAt = Math.max(this.lastAt, time)
    return this.lastAt
  }
}

/** A record's ISO time as epoch milliseconds, or null when it has none. */
export function recordTime(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const time = typeof value === 'number' ? value : Date.parse(value)
  return Number.isFinite(time) && time > 0 ? time : null
}
