import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import type { ConversationEvent, ConversationEventType } from '../shared/conversation-runtime'
import { ConversationRuntime } from './conversation-runtime'
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

/**
 * A provider that streams `tokens` one delta at a time and parks before the
 * turn ends until `release` is called, so a test can look at the transcript
 * while a message is still streaming.
 */
function streamingProvider(tokens: string[]) {
  let release!: () => void
  const parked = new Promise<void>((resolve) => {
    release = resolve
  })
  let reachedPark!: () => void
  const atPark = new Promise<void>((resolve) => {
    reachedPark = resolve
  })
  const adapter: ConversationProviderAdapter = {
    id: 'streaming-provider',
    listModels: () => ['model'],
    startSession: (input) => [runtimeEvent(input, 'session_started'), runtimeEvent(input, 'session_ready')],
    sendTurn: (input) =>
      (async function* () {
        yield runtimeEvent(input, 'turn_started', { turnId: input.turnId })
        for (const text of tokens) yield runtimeEvent(input, 'content_delta', { turnId: input.turnId, text })
        reachedPark()
        await parked
        yield runtimeEvent(input, 'turn_completed', { turnId: input.turnId })
      })(),
    resolveApproval: () => [],
    interrupt: (input) => [runtimeEvent(input, 'turn_failed', { reason: 'interrupted' })],
    stopSession: (input) => [runtimeEvent(input, 'session_closed')],
  }
  return { adapter, release, atPark }
}

async function withRuntime(
  tokens: string[],
  body: (context: {
    runtime: ConversationRuntime
    workspaceRoot: string
    provider: ReturnType<typeof streamingProvider>
    delivered: ConversationEvent[]
    start: () => Promise<string>
  }) => Promise<void>,
): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-conversation-persistence-'))
  const provider = streamingProvider(tokens)
  const runtime = new ConversationRuntime({
    adapters: [provider.adapter],
    getProviderById: () => undefined,
    secretStore: {
      getStatus: async () => ({ ok: false, message: 'unused' }),
      resolveSecret: async () => ({ ok: false, message: 'unused' }),
    },
    // Long enough that only boundaries and explicit flushes write in these tests.
    eventLog: { flushDelayMs: 60_000 },
  })
  const delivered: ConversationEvent[] = []
  runtime.onEvent((event) => delivered.push(event))
  const start = async (): Promise<string> => {
    const started = await runtime.startSession({
      workspaceRoot,
      workspaceId: 'workspace',
      agentId: 'agent',
      providerId: 'streaming-provider',
      modelId: 'model',
    })
    assert.equal(started.ok, true)
    if (!started.ok) throw new Error('start failed')
    return started.session.sessionId
  }
  try {
    await body({ runtime, workspaceRoot, provider, delivered, start })
  } finally {
    await runtime.shutdown()
    await rm(workspaceRoot, { recursive: true, force: true })
  }
}

function transcriptFile(workspaceRoot: string): string {
  return join(workspaceRoot, '.sprintengine', 'conversations', 'workspace', 'agent.jsonl')
}

async function readLines(workspaceRoot: string): Promise<Record<string, unknown>[]> {
  const raw = await readFile(transcriptFile(workspaceRoot), 'utf-8')
  return raw
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

test('streamed deltas reach listeners without a write per token', async () => {
  await withRuntime(['Hel', 'lo ', 'there'], async ({ runtime, workspaceRoot, provider, delivered, start }) => {
    const sessionId = await start()
    const turn = runtime.sendTurn({ sessionId, message: 'hi' })
    await provider.atPark
    const deltas = delivered.filter((event) => event.type === 'content_delta')
    assert.equal(deltas.length, 3, 'every token is delivered live')
    const onDisk = await readLines(workspaceRoot)
    assert.equal(
      onDisk.some((line) => line.type === 'content_delta'),
      false,
      'the message in flight has not been written token by token',
    )
    provider.release()
    await turn
    const after = await readLines(workspaceRoot)
    const written = after.filter((line) => line.type === 'content_delta')
    assert.equal(written.length, 1, 'the run is one record')
    assert.equal((written[0].payload as { text: string }).text, 'Hello there')
    assert.deepEqual(
      after.map((line) => line.type).slice(-2),
      ['content_delta', 'turn_completed'],
      'the run lands before the boundary that ended it',
    )
  })
})

test('a reload mid-stream replays exactly the events delivered live', async () => {
  await withRuntime(['a', 'b', 'c'], async ({ runtime, workspaceRoot, provider, delivered, start }) => {
    const sessionId = await start()
    const turn = runtime.sendTurn({ sessionId, message: 'hi' })
    await provider.atPark
    const replay = await runtime.readTranscript({ workspaceRoot, workspaceId: 'workspace', agentId: 'agent' })
    assert.equal(replay.ok, true)
    if (!replay.ok) return
    const liveIds = delivered.map((event) => event.id)
    const replayed = replay.events.filter((event) => !event.id.startsWith('conv_evt_replay_close_'))
    assert.deepEqual(
      replayed.map((event) => event.id),
      liveIds,
      'ids match one for one, so the chat view dedupes a mid-stream mount',
    )
    assert.deepEqual(
      replayed.filter((event) => event.type === 'content_delta').map((event) => event.payload?.text),
      ['a', 'b', 'c'],
    )
    provider.release()
    await turn
  })
})

test('after a completed turn the transcript rebuilds the full message', async () => {
  await withRuntime(['The ', 'whole ', 'answer.'], async ({ runtime, workspaceRoot, provider, delivered, start }) => {
    const sessionId = await start()
    provider.release()
    await runtime.sendTurn({ sessionId, message: 'hi' })
    const replay = await runtime.readTranscript({ workspaceRoot, workspaceId: 'workspace', agentId: 'agent' })
    assert.equal(replay.ok, true)
    if (!replay.ok) return
    // Through JSON, as a transcript line is: an absent payload is `undefined` live.
    assert.deepEqual(replay.events, JSON.parse(JSON.stringify(delivered)))
    const text = replay.events
      .filter((event) => event.type === 'content_delta')
      .map((event) => event.payload?.text)
      .join('')
    assert.equal(text, 'The whole answer.')
  })
})
