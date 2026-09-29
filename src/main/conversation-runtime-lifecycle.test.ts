import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import type { ConversationEvent, ConversationEventType } from '../shared/conversation-runtime'
import { ConversationRuntime } from './conversation-runtime'
import { createConversationPeekService } from './conversation-peek/service'
import type { ConversationProviderAdapter, MockAdapterSessionInput } from './providers/mock-conversation-provider'

function runtimeEvent(
  input: MockAdapterSessionInput,
  type: ConversationEventType,
  payload?: Record<string, unknown>,
): ConversationEvent {
  return {
    id: '',
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    providerId: input.providerId,
    modelId: input.modelId,
    type,
    createdAt: 0,
    payload,
  }
}

/** A provider that answers each message at once, echoing it with `padding` after. */
function echoProvider(options: { padding?: string } = {}): ConversationProviderAdapter {
  return {
    id: 'echo-provider',
    listModels: () => ['model'],
    startSession: (input) => [runtimeEvent(input, 'session_started'), runtimeEvent(input, 'session_ready')],
    sendTurn: (input) => [
      runtimeEvent(input, 'turn_started', { turnId: input.turnId }),
      runtimeEvent(input, 'content_delta', { turnId: input.turnId, text: `Echo: ${input.message}` }),
      runtimeEvent(input, 'content_delta', { turnId: input.turnId, text: options.padding ?? '' }),
      runtimeEvent(input, 'turn_completed', { turnId: input.turnId }),
    ],
    resolveApproval: () => [],
    interrupt: (input) => [runtimeEvent(input, 'turn_failed', { reason: 'interrupted' })],
    stopSession: (input) => [runtimeEvent(input, 'session_closed')],
  }
}

async function withRuntime(
  adapters: ConversationProviderAdapter[],
  body: (context: { runtime: ConversationRuntime; workspaceRoot: string }) => Promise<void>,
  options: { now?: () => number } = {},
): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-conversation-lifecycle-'))
  const runtime = new ConversationRuntime({
    adapters,
    getProviderById: () => undefined,
    secretStore: {
      getStatus: async () => ({ ok: false, message: 'unused' }),
      resolveSecret: async () => ({ ok: false, message: 'unused' }),
    },
    ...(options.now ? { now: options.now } : {}),
  })
  try {
    await body({ runtime, workspaceRoot })
  } finally {
    await runtime.shutdown()
    await rm(workspaceRoot, { recursive: true, force: true })
  }
}

test('the hover card reads the first message and the newest turn, never the chat between', async () =>
  withRuntime([echoProvider({ padding: 'x'.repeat(16 * 1024) })], async ({ runtime, workspaceRoot }) => {
    const key = { workspaceRoot, workspaceId: 'workspace', agentId: 'agent' }
    const started = await runtime.startSession({ ...key, providerId: 'echo-provider', modelId: 'model' })
    assert.ok(started.ok)
    const sessionId = started.session.sessionId
    const messages = ['First question', ...Array.from({ length: 40 }, (_, index) => `Middle ${index}`), 'Last one']
    for (const message of messages) assert.ok((await runtime.sendTurn({ sessionId, message })).ok)

    const events = await runtime.readPeekTranscript(key)
    const said = events.filter((event) => event.type === 'user_message').map((event) => event.payload?.text)
    assert.deepEqual(said, ['First question', 'Last one'])
    assert.ok(!events.some((event) => String(event.payload?.text ?? '').includes('Middle')))

    const peek = await createConversationPeekService({
      readSessionState: async () => null,
      readConversationEvents: async () => events,
    }).readConversationPeek(sessionId)
    assert.equal(peek.first?.text, 'First question')
    assert.deepEqual(
      peek.since.map((message) => message.text.slice(0, 14)),
      ['Last one', 'Echo: Last one'],
    )
  }))
