import type {
  ConversationEvent,
  ConversationSubscribeInput,
  ConversationSessionFrame,
  ConversationLoadEarlierInput,
  ConversationPageResult,
  ConversationSendTurnInput,
  ConversationInterruptInput,
  ConversationRespondToRequestInput,
  ConversationSetModelInput,
  ConversationSetPermissionInput,
  ConversationTurnDiffInput,
  ConversationRevertInput,
  ConversationRewindInput,
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
  rewindToTurn(input: ConversationRewindInput) {
    return this.runtime.rewindToTurn(input)
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
    // An event is published only after it is on disk, so each one either is in
    // the read below or arrives here afterwards; the sequence filter drops the
    // overlap.
    unsubscribe = this.runtime.onEvent(live)
    const ready = (async () => {
      await this.runtime.recoverTranscript(input.key)
      const sync = await this.runtime.readConversationSync(input.key, {
        afterSeq: input.afterSeq,
        generation: input.generation,
        turnLimit: input.turnLimit,
      })
      if (disposed) return
      if (!sync.ok) {
        deliver({ type: 'error', message: sync.message })
        dispose()
        return
      }
      if (sync.kind === 'events') {
        for (const event of sync.events) deliver({ type: 'event', event })
      } else {
        deliver({
          type: 'snapshot',
          page: sync.page,
          generation: sync.generation,
          ...(input.afterSeq !== undefined ? { reset: true as const } : {}),
        })
      }
      seen = sync.head
      deliver({ type: 'synchronized', seq: seen, generation: sync.generation })
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
    await this.runtime.recoverTranscript(input.key)
    return this.runtime.readConversationPage(input.key, input.beforeCursor, input.turnLimit)
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
  setModel(input: ConversationSetModelInput & { commandId: string }) {
    return this.runtime.setModel(input)
  }
}
