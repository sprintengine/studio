import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import type { ConversationEvent } from '../shared/conversation-runtime'
import { ConversationRuntime } from './conversation-runtime'
import { createMockConversationProvider, type MockAdapterTurnInput } from './providers/mock-conversation-provider'

// A message Studio sends a chat itself is recorded as Studio's: its
// `user_message` carries the origin, the agent is handed the plain text, and
// the chat's clocks and excerpts read it as no word from the person.
test('a message Studio sends is recorded with its origin and is not the person writing', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'conversation-origin-runtime-'))
  const turns: MockAdapterTurnInput[] = []
  const mock = createMockConversationProvider()
  let clock = 1_000_000
  const runtime = new ConversationRuntime({
    now: () => clock,
    adapters: [
      {
        ...mock,
        sendTurn(input) {
          turns.push(input)
          // A turn that completes on its own, with no approval to answer.
          return mock.sendTurn({ ...input, message: '/tools' })
        },
      },
    ],
    getProviderById: () => undefined,
  })
  try {
    const key = { workspaceRoot, workspaceId: 'workspace', agentId: 'agent' }
    const started = await runtime.startSession({ ...key, providerId: 'mock-provider', modelId: 'mock-model' })
    assert.ok(started.ok)
    const sessionId = started.session.sessionId
    assert.equal((await runtime.sendTurn({ sessionId, message: 'Start the scout' })).ok, true)
    const personAt = clock
    clock += 60_000
    const notice = '[SprintEngine Studio] Agent Scout, which you launched, finished its turn.'
    const sent = await runtime.sendTurn({
      sessionId,
      message: notice,
      origin: { kind: 'studio', reason: 'agent-notice' },
    })
    assert.equal(sent.ok, true)

    // The agent reads words, as from any sender.
    assert.equal(turns.at(-1)?.message, notice)
    const transcript = await runtime.readTranscript(key)
    assert.ok(transcript.ok)
    const messages = transcript.events.filter((event) => event.type === 'user_message')
    assert.equal(messages[0]?.payload?.origin, undefined, 'the person’s message carries no origin')
    assert.deepEqual(messages[1]?.payload?.origin, { kind: 'studio', reason: 'agent-notice' })

    const [session] = (() => {
      const listed = runtime.listSessions({ workspaceId: 'workspace' })
      return listed.ok ? listed.sessions : []
    })()
    assert.equal(session?.lastUserMessageAt, personAt, 'Studio’s message does not move the person’s clock')
    assert.equal(session?.lastUserText, 'Start the scout')
    assert.equal(session?.firstUserText, 'Start the scout')
  } finally {
    await runtime.shutdown()
    await rm(workspaceRoot, { recursive: true, force: true })
  }
})

// The sidebar previews the opening of a reply; a launch notice quotes its end,
// where an agent puts its conclusion. A long reply keeps both, and a new
// message, the person's or Studio's, clears both.
test('a long reply keeps its opening for the sidebar and its end for a launch notice', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'conversation-tail-runtime-'))
  const mock = createMockConversationProvider()
  const chunks = ['Opening words. ', ...Array.from({ length: 60 }, (_, index) => `Step ${index} done. `), 'All green.']
  const runtime = new ConversationRuntime({
    adapters: [
      {
        ...mock,
        sendTurn(input) {
          const events = mock.sendTurn({ ...input, message: '/tools' }) as ConversationEvent[]
          if (input.message !== 'Work') return events
          const started = events[0]!
          const deltas = chunks.map((text): ConversationEvent => ({
            ...started,
            type: 'content_delta',
            payload: { turnId: input.turnId, text },
          }))
          return [started, ...deltas, events.at(-1)!]
        },
      },
    ],
    getProviderById: () => undefined,
  })
  const summary = () => {
    const listed = runtime.listSessions({ workspaceId: 'workspace' })
    return listed.ok ? listed.sessions[0] : undefined
  }
  try {
    const key = { workspaceRoot, workspaceId: 'workspace', agentId: 'agent' }
    const started = await runtime.startSession({ ...key, providerId: 'mock-provider', modelId: 'mock-model' })
    assert.ok(started.ok)
    const sessionId = started.session.sessionId
    assert.equal((await runtime.sendTurn({ sessionId, message: 'Work' })).ok, true)
    const reply = chunks.join('')
    assert.ok(reply.length > 600)
    assert.equal(summary()?.lastAssistantText, reply.slice(0, 240), 'the opening, for the sidebar')
    assert.ok(summary()?.lastAssistantText?.startsWith('Opening words.'))
    assert.equal(summary()?.lastAssistantTail, reply.slice(-320), 'the end, for a launch notice')
    assert.ok(summary()?.lastAssistantTail?.endsWith('Step 59 done. All green.'))

    await runtime.sendTurn({ sessionId, message: 'notice', origin: { kind: 'studio', reason: 'agent-notice' } })
    assert.equal(summary()?.lastAssistantTail, '', 'a new message starts a new reply')
    assert.equal(summary()?.lastAssistantText, '')
  } finally {
    await runtime.shutdown()
    await rm(workspaceRoot, { recursive: true, force: true })
  }
})
