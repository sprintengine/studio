import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import { registerConversationIpc, type ConversationIpcHandlers } from './conversation-ipc'
import { ConversationRuntime } from '../conversation-runtime'
import { ConversationSessionApi } from '../conversation-session-api'
import { createMockConversationProvider } from '../providers/mock-conversation-provider'
import type { ConversationSessionFrame } from '../../shared/conversation-runtime'

type Handler = (event: unknown, input: unknown) => unknown

function harness(runtime: ConversationRuntime) {
  const handlers = new Map<string, Handler>()
  const sessions = new ConversationSessionApi(runtime)
  const unused = async () => ({ ok: false as const, message: 'unused' })
  registerConversationIpc(
    { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) } as unknown as Parameters<
      typeof registerConversationIpc
    >[0],
    {
      listProviders: unused,
      getSecretStatus: unused,
      setSecret: unused,
      clearSecret: unused,
      listProviderModels: unused,
      startSession: unused,
      sendTurn: unused,
      interrupt: unused,
      respondToRequest: unused,
      setPermission: unused,
      stopSession: unused,
      listSessions: () => ({ ok: true, sessions: [] }),
      readTranscript: unused,
      onEvent: () => () => undefined,
      subscribe: (input, listener) => sessions.subscribe(input, listener),
    } as ConversationIpcHandlers,
  )
  const frames = new Map<string, ConversationSessionFrame[]>()
  const sender = {
    id: 1,
    isDestroyed: () => false,
    send: (_channel: string, payload: { subscriptionId: string; frame: ConversationSessionFrame }) =>
      frames.get(payload.subscriptionId)?.push(payload.frame),
    once: () => undefined,
    on: () => undefined,
    removeListener: () => undefined,
  }
  return {
    async subscribe(subscriptionId: string, input: Record<string, unknown>) {
      const received: ConversationSessionFrame[] = []
      frames.set(subscriptionId, received)
      const result = await handlers.get('conversation:session:subscribe')!({ sender }, { subscriptionId, ...input })
      return { result, received }
    },
  }
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400 && !predicate(); attempt++) await new Promise((r) => setTimeout(r, 5))
  assert.ok(predicate())
}

test('a desktop reconnect with its cursor and generation is caught up without a reset', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'conversation-subscribe-ipc-'))
  const adapter = createMockConversationProvider()
  const runtime = new ConversationRuntime({ adapters: [adapter], getProviderById: () => undefined })
  try {
    const key = { workspaceRoot, workspaceId: 'workspace', agentId: 'agent' }
    const started = await runtime.startSession({ ...key, providerId: adapter.id, modelId: adapter.listModels()[0] })
    assert.ok(started.ok)
    const ipc = harness(runtime)

    const first = await ipc.subscribe('first', { key })
    assert.deepEqual(first.result, { ok: true, subscriptionId: 'first' })
    await until(() => first.received.some((frame) => frame.type === 'synchronized'))
    const synchronized = first.received.find((frame) => frame.type === 'synchronized')
    assert.ok(synchronized?.type === 'synchronized' && synchronized.generation)

    // Missed while the window was away.
    await runtime.sendTurn({ sessionId: started.session.sessionId, message: '/tools' })
    await until(() => first.received.some((frame) => frame.type === 'event' && frame.event.type === 'turn_completed'))

    const again = await ipc.subscribe('again', {
      key,
      afterSeq: synchronized.seq,
      generation: synchronized.generation,
    })
    await until(() => again.received.some((frame) => frame.type === 'synchronized'))
    assert.equal(
      again.received.some((frame) => frame.type === 'snapshot'),
      false,
      'a cursor the log can vouch for is answered with the missed events, not a reset',
    )
    const missed = again.received.flatMap((frame) => (frame.type === 'event' ? [frame.event] : []))
    assert.ok(missed.length > 0)
    assert.ok(missed.every((event) => event.seq! > synchronized.seq))
    assert.ok(missed.some((event) => event.type === 'turn_completed'))

    for (const generation of ['', 'g'.repeat(201), 7])
      assert.equal(((await ipc.subscribe('bad', { key, afterSeq: 1, generation })).result as { ok: boolean }).ok, false)
  } finally {
    await runtime.shutdown()
    await rm(workspaceRoot, { recursive: true, force: true })
  }
})

test('a tool result reaches the window once, as its preview, and draws the same', async () => {
  const { eventForWindow, frameForWindow } = await import('./conversation-ipc')
  const { projectConversation } = await import('../../../packages/conversation-timeline/src/conversationProjection')
  const base = { sessionId: 's', workspaceId: 'w', agentId: 'a', providerId: 'p', modelId: 'm', createdAt: 1 }
  const text = 'line one\nline two'
  const events = [
    { ...base, id: '1', seq: 1, type: 'user_message', payload: { turnId: 't', text: 'go' } },
    {
      ...base,
      id: '2',
      seq: 2,
      type: 'tool_started',
      payload: { turnId: 't', toolUseId: 'u', name: 'Bash', input: {} },
    },
    {
      ...base,
      id: '3',
      seq: 3,
      type: 'tool_output',
      payload: { turnId: 't', toolUseId: 'u', preview: text, output: text, status: 'ok', totalBytes: 17 },
    },
    // Output that is not a copy of the preview is the window's to read.
    { ...base, id: '4', seq: 4, type: 'tool_output', payload: { turnId: 't', toolUseId: 'v', output: 'only' } },
    { ...base, id: '5', seq: 5, type: 'turn_completed', payload: { turnId: 't' } },
  ] as Parameters<typeof eventForWindow>[0][]
  const shown = events.map(eventForWindow)
  assert.equal(shown[2].payload?.output, undefined)
  assert.equal(shown[2].payload?.preview, text)
  assert.equal(shown[3], events[3])
  assert.equal(events[2].payload?.output, text, 'the stored event is left as it was')
  assert.deepEqual(projectConversation(shown), projectConversation(events))
  const frame = frameForWindow({ type: 'snapshot', page: { events, hasMore: false, beforeCursor: null } })
  assert.ok(frame.type === 'snapshot')
  assert.deepEqual(frame.page.events, shown)
})
