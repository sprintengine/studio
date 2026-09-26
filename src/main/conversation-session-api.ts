import type {
  ConversationEvent,
  ConversationSubscribeInput,
  ConversationSessionFrame,
  ConversationLoadEarlierInput,
  ConversationPage,
  ConversationPageResult,
  ConversationSendTurnInput,
  ConversationInterruptInput,
  ConversationRespondToRequestInput,
  ConversationSetPermissionInput,
  ConversationTurnDiffInput,
  ConversationRevertInput,
  ConversationListSessionsInput,
  ConversationToolDetailInput,
} from '../shared/conversation-runtime'
import type { ConversationRuntime } from './conversation-runtime'

/** Transport-independent replay, subscription and command boundary. */
export class ConversationSessionApi {
  constructor(private readonly runtime: ConversationRuntime) {}
  listSessions(input?: ConversationListSessionsInput) {
    return this.runtime.listSessions(input)
  }
  getToolDetail(input: ConversationToolDetailInput) {
    return this.runtime.getToolDetail(input)
  }
  getTurnDiff(input: ConversationTurnDiffInput) {
    return this.runtime.getTurnDiff(input)
  }
  revertToTurn(input: ConversationRevertInput) {
    return this.runtime.revertToTurn(input)
  }

  subscribe(
    input: ConversationSubscribeInput,
    listener: (frame: ConversationSessionFrame) => void,
  ): { dispose: () => void; ready: Promise<void> } {
    let disposed = false
    let joining = true
    let seen = input.afterSeq ?? 0
    const queued: ConversationEvent[] = []
    let unsubscribe = () => {}
    const dispose = () => {
      if (disposed) return
      disposed = true
      unsubscribe()
    }
    const deliver = (frame: ConversationSessionFrame) => {
      if (disposed) return
      try {
        listener(frame)
      } catch {
        dispose()
      }
    }
    const live = (event: ConversationEvent) => {
      if (disposed || event.workspaceId !== input.key.workspaceId || event.agentId !== input.key.agentId) return
      if (joining) {
        queued.push(event)
        return
      }
      if ((event.seq ?? 0) <= seen) return
      seen = event.seq!
      deliver({ type: 'event', event })
    }
    // Subscribe before any asynchronous read so the join has no blind window.
    unsubscribe = this.runtime.onEvent(live)
    const ready = (async () => {
      const transcript = await this.runtime.readTranscript(input.key, { all: true, closeOpenTurns: false })
      if (disposed) return
      if (!transcript.ok) {
        deliver({ type: 'error', message: transcript.message })
        dispose()
        return
      }
      const after = transcript.events.filter((event) => (event.seq ?? 0) > seen)
      if (after.length <= 1000 && Buffer.byteLength(JSON.stringify(after)) <= 8 * 1024 * 1024) {
        for (const event of after) deliver({ type: 'event', event })
      } else {
        deliver({ type: 'snapshot', page: pageTurns(transcript.events, input.turnLimit) })
      }
      seen = Math.max(seen, transcript.events.at(-1)?.seq ?? 0)
      deliver({ type: 'synchronized', seq: seen })
      joining = false
      for (const event of queued.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))) live(event)
      queued.length = 0
    })().catch((error) => {
      deliver({
        type: 'error',
        message: error instanceof Error ? error.message : 'Conversation could not synchronize.',
      })
      dispose()
    })
    return { dispose, ready }
  }

  async loadEarlier(input: ConversationLoadEarlierInput): Promise<ConversationPageResult> {
    const transcript = await this.runtime.readTranscript(input.key, { all: true, closeOpenTurns: false })
    if (!transcript.ok) return transcript
    return {
      ok: true,
      page: pageTurns(
        transcript.events.filter((event) => (event.seq ?? 0) < input.beforeCursor),
        input.turnLimit,
      ),
    }
  }

  send(input: ConversationSendTurnInput & { commandId: string }) {
    return this.runtime.sendTurn(input)
  }
  interrupt(input: ConversationInterruptInput & { commandId: string }) {
    return this.runtime.interrupt(input)
  }
  resolveApproval(input: ConversationRespondToRequestInput & { commandId: string }) {
    return this.runtime.respondToRequest(input)
  }
  answerQuestion(input: ConversationRespondToRequestInput & { commandId: string }) {
    return this.runtime.respondToRequest(input)
  }
  setPermissionPreset(input: ConversationSetPermissionInput & { commandId: string }) {
    return this.runtime.setPermission(input)
  }
}

function pageTurns(events: ConversationEvent[], requested = 10): ConversationPage {
  const limit = Math.max(1, Math.min(100, Math.floor(requested) || 10))
  const starts: number[] = []
  for (let index = 0; index < events.length; index++) if (events[index].type === 'user_message') starts.push(index)
  const start = starts.length > limit ? starts[starts.length - limit] : 0
  const page = events.slice(start)
  return { events: page, hasMore: start > 0, beforeCursor: page[0]?.seq ?? null }
}
