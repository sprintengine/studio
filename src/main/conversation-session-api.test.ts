import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { test } from 'vitest'
import { ConversationRuntime } from './conversation-runtime'
import { ConversationSessionApi } from './conversation-session-api'
import { createMockConversationProvider } from './providers/mock-conversation-provider'
import type { ConversationProviderAdapter, MockAdapterSessionInput } from './providers/conversation-provider-adapter'
import type { ConversationEvent, ConversationSessionFrame } from '../shared/conversation-runtime'
import { workspaceSidecarPath } from './workspace-sidecar'

function event(
  input: MockAdapterSessionInput,
  type: ConversationEvent['type'],
  payload?: Record<string, unknown>,
): ConversationEvent {
  return {
    id: '',
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    providerId: input.providerId,
    modelId: input.modelId,
    createdAt: 1,
    type,
    payload,
  }
}
async function fixture(adapter = createMockConversationProvider()) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'conversation-session-'))
  const key = { workspaceRoot, workspaceId: 'workspace', agentId: 'agent' }
  const runtime = new ConversationRuntime({ adapters: [adapter], getProviderById: () => undefined })
  const started = await runtime.startSession({ ...key, providerId: adapter.id, modelId: adapter.listModels()[0] })
  assert.equal(started.ok, true)
  return {
    runtime,
    key,
    sessionId: started.session.sessionId,
    cleanup: async () => {
      await runtime.shutdown()
      await rm(workspaceRoot, { recursive: true, force: true })
    },
  }
}

test('tool details preserve large outputs and edit inputs, redact secrets, and disappear with the transcript', async () => {
  const adapter: ConversationProviderAdapter = {
    ...createMockConversationProvider(),
    sendTurn(input) {
      return [
        event(input, 'tool_started', {
          turnId: input.turnId,
          toolCallId: 'edit',
          tool: 'Edit',
          input: { path: 'example.txt', oldText: 'before', newText: 'after', apiKey: 'private-value' },
        }),
        event(input, 'tool_output', {
          turnId: input.turnId,
          toolCallId: 'edit',
          output: 'x'.repeat(50_000),
          isError: false,
        }),
        event(input, 'turn_completed', { turnId: input.turnId }),
      ]
    },
  }
  const f = await fixture(adapter)
  try {
    const events: ConversationEvent[] = []
    f.runtime.onEvent((e) => events.push(e))
    await f.runtime.sendTurn({ sessionId: f.sessionId, message: 'edit' })
    const output = events.find((e) => e.type === 'tool_output')!
    assert.equal(String(output.payload?.preview).length, 4000)
    assert.equal(output.payload?.totalBytes, 50_000)
    assert.equal(output.payload?.truncated, true)
    const result = await f.runtime.getToolDetail({ ...f.key, toolUseId: 'edit' })
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.equal(String(result.detail.output).length, 50_000)
      assert.deepEqual(result.detail.input, {
        path: 'example.txt',
        oldText: 'before',
        newText: 'after',
        apiKey: '[redacted]',
      })
    }
    const path = workspaceSidecarPath(f.key.workspaceRoot, 'conversations', 'workspace', 'agent.tools', 'edit.json')
    assert.equal((await readFile(path, 'utf8')).includes('private-value'), false)
    const missing = await f.runtime.getToolDetail({ ...f.key, toolUseId: 'missing' })
    assert.deepEqual(missing.ok ? null : missing.code, 'not_found')
    await f.runtime.stopSession({ sessionId: f.sessionId })
    await f.runtime.deleteTranscript(f.key)
    assert.equal((await f.runtime.getToolDetail({ ...f.key, toolUseId: 'edit' })).ok, false)
  } finally {
    await f.cleanup()
  }
})

test('large inputs are kept out of events and binary tools carry only metadata', async () => {
  const adapter: ConversationProviderAdapter = {
    ...createMockConversationProvider(),
    sendTurn(input) {
      return [
        event(input, 'tool_started', {
          turnId: input.turnId,
          toolCallId: 'binary',
          tool: 'Read',
          input: { content: 'x'.repeat(70_000) },
        }),
        event(input, 'tool_output', {
          turnId: input.turnId,
          toolCallId: 'binary',
          output: 'encoded-content',
          mime: 'image/png',
          totalBytes: 32,
        }),
        event(input, 'turn_completed', { turnId: input.turnId }),
      ]
    },
  }
  const f = await fixture(adapter)
  try {
    const events: ConversationEvent[] = []
    f.runtime.onEvent((e) => events.push(e))
    await f.runtime.sendTurn({ sessionId: f.sessionId, message: 'read' })
    assert.equal(events.find((e) => e.type === 'tool_started')?.payload?.inputTruncated, true)
    const output = events.find((e) => e.type === 'tool_output')!
    assert.equal(output.payload?.preview, '')
    assert.equal(output.payload?.totalBytes, 32)
    assert.equal(JSON.stringify(events).includes('encoded-content'), false)
  } finally {
    await f.cleanup()
  }
})

test('tool detail files are capped and preserve their head and tail', async () => {
  const adapter: ConversationProviderAdapter = {
    ...createMockConversationProvider(),
    sendTurn(input) {
      return [
        event(input, 'tool_output', {
          turnId: input.turnId,
          toolCallId: 'huge',
          output: 'HEAD' + 'x'.repeat(6 * 1024 * 1024) + 'TAIL',
        }),
        event(input, 'turn_completed', { turnId: input.turnId }),
      ]
    },
  }
  const f = await fixture(adapter)
  try {
    await f.runtime.sendTurn({ sessionId: f.sessionId, message: 'large' })
    const result = await f.runtime.getToolDetail({ ...f.key, toolUseId: 'huge' })
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.equal(result.detail.clipped, true)
      assert.ok(String(result.detail.output).startsWith('HEAD'))
      assert.ok(String(result.detail.output).endsWith('TAIL'))
    }
    const path = workspaceSidecarPath(f.key.workspaceRoot, 'conversations', 'workspace', 'agent.tools', 'huge.json')
    assert.ok((await stat(path)).size <= 5 * 1024 * 1024)
  } finally {
    await f.cleanup()
  }
})

test('concurrent duplicate commands and receipts after restart produce one user message', async () => {
  const f = await fixture()
  try {
    const commandId = randomUUID()
    const input = { sessionId: f.sessionId, message: '/tools', commandId }
    const [first, second] = await Promise.all([f.runtime.sendTurn(input), f.runtime.sendTurn(input)])
    assert.deepEqual(first, second)
    await f.runtime.shutdown()
    const restarted = new ConversationRuntime({
      adapters: [createMockConversationProvider()],
      getProviderById: () => undefined,
    })
    try {
      const session = await restarted.startSession({ ...f.key, providerId: 'mock-provider', modelId: 'mock-model' })
      assert.equal(session.ok, true)
      if (!session.ok) return
      assert.deepEqual(await restarted.sendTurn({ ...input, sessionId: session.session.sessionId }), first)
      const replay = await restarted.readTranscript(f.key)
      assert.equal(replay.ok && replay.events.filter((e) => e.type === 'user_message').length, 1)
      if (replay.ok)
        assert.deepEqual(
          replay.events.map((e) => e.seq),
          replay.events.map((_, i) => i + 1),
        )
    } finally {
      await restarted.shutdown()
    }
  } finally {
    await f.cleanup()
  }
})

test('reconnecting after a sequence returns exactly the missed events and no unrelated agent', async () => {
  const f = await fixture()
  try {
    const api = new ConversationSessionApi(f.runtime)
    const frames: ConversationSessionFrame[] = []
    const joined = api.subscribe({ key: f.key }, (frame) => frames.push(frame))
    await joined.ready
    const afterSeq = frames.filter((frame) => frame.type === 'event').at(-1)
    assert.ok(afterSeq?.type === 'event')
    joined.dispose()
    joined.dispose()
    await f.runtime.sendTurn({ sessionId: f.sessionId, message: '/tools' })
    const rejoined: ConversationSessionFrame[] = []
    const replay = api.subscribe({ key: f.key, afterSeq: afterSeq.event.seq }, (frame) => rejoined.push(frame))
    await replay.ready
    const full = await f.runtime.readTranscript(f.key)
    assert.ok(full.ok)
    assert.deepEqual(
      rejoined.filter((frame) => frame.type === 'event').map((frame) => frame.event),
      full.events.filter((e) => e.seq! > afterSeq.event.seq!),
    )
    const count = rejoined.length
    await f.runtime.startSession({ ...f.key, agentId: 'other', providerId: 'mock-provider', modelId: 'mock-model' })
    assert.equal(rejoined.length, count)
    replay.dispose()
  } finally {
    await f.cleanup()
  }
})

test('legacy 5000-event logs get stable sequences and turn-aligned pages reaching the first event', async () => {
  const f = await fixture()
  try {
    await f.runtime.stopSession({ sessionId: f.sessionId })
    const path = workspaceSidecarPath(f.key.workspaceRoot, 'conversations', 'workspace', 'agent.jsonl')
    const events = Array.from({ length: 5000 }, (_, index) => ({
      id: `legacy_${index}`,
      sessionId: 'old',
      workspaceId: 'workspace',
      agentId: 'agent',
      providerId: 'mock-provider',
      modelId: 'mock-model',
      createdAt: index,
      type: index % 5 === 0 ? 'user_message' : index % 5 === 4 ? 'turn_completed' : 'tool_started',
      payload: { turnId: `turn_${Math.floor(index / 5)}`, tool: 'Bash' },
    }))
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, events.map((e) => JSON.stringify(e)).join('\n') + '\n')
    const api = new ConversationSessionApi(f.runtime)
    const frames: ConversationSessionFrame[] = []
    const subscription = api.subscribe({ key: f.key }, (frame) => frames.push(frame))
    await subscription.ready
    const snapshot = frames.find((frame) => frame.type === 'snapshot')
    assert.ok(snapshot?.type === 'snapshot')
    assert.equal(snapshot.page.hasMore, true)
    assert.equal(snapshot.page.events.length, 50)
    let page = snapshot.page
    while (page.hasMore) {
      const prior = await api.loadEarlier({ key: f.key, beforeCursor: page.beforeCursor!, turnLimit: 100 })
      assert.ok(prior.ok)
      page = prior.page
      assert.equal(page.events[0].type, 'user_message')
    }
    assert.equal(page.events[0].seq, 1)
    assert.equal(page.events[1].payload?.kind, 'command')
    subscription.dispose()
  } finally {
    await f.cleanup()
  }
})

test('throwing providers and listeners leave a retryable session', async () => {
  let fail = true
  const mock = createMockConversationProvider()
  const f = await fixture({
    ...mock,
    sendTurn(input) {
      if (fail) {
        fail = false
        throw new Error('provider failed')
      }
      return mock.sendTurn(input)
    },
  })
  try {
    let healthy = 0
    f.runtime.onEvent(() => {
      throw new Error('listener failed')
    })
    f.runtime.onEvent(() => healthy++)
    assert.equal((await f.runtime.sendTurn({ sessionId: f.sessionId, message: '/tools' })).ok, false)
    assert.equal((await f.runtime.sendTurn({ sessionId: f.sessionId, message: '/tools' })).ok, true)
    assert.ok(healthy > 2)
  } finally {
    await f.cleanup()
  }
})

test('subscribe joins a racing replay without gaps or duplicates and disposes synchronously', async () => {
  let resolveRead!: (value: { ok: true; events: ConversationEvent[] }) => void
  const listeners = new Set<(event: ConversationEvent) => void>()
  const read = new Promise<{ ok: true; events: ConversationEvent[] }>((resolve) => {
    resolveRead = resolve
  })
  const runtime = {
    onEvent(listener: (event: ConversationEvent) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    readTranscript: () => read,
  } as unknown as ConversationRuntime
  const api = new ConversationSessionApi(runtime)
  const key = { workspaceRoot: '/workspace', workspaceId: 'workspace', agentId: 'agent' }
  const envelope = { ...key, sessionId: 'session', providerId: 'mock-provider', modelId: 'mock-model' }
  const first = { ...event(envelope, 'content_delta', { text: 'a' }), seq: 1 }
  const second = { ...event(envelope, 'content_delta', { text: 'b' }), seq: 2 }
  const frames: ConversationSessionFrame[] = []
  const subscription = api.subscribe({ key }, (frame) => frames.push(frame))
  for (const listener of listeners) listener(second)
  resolveRead({ ok: true, events: [first, second] })
  await subscription.ready
  for (const listener of listeners) listener({ ...second, seq: 3 })
  assert.deepEqual(
    frames.map((frame) => (frame.type === 'event' ? frame.event.seq : frame.type)),
    [1, 2, 'synchronized', 3],
  )
  subscription.dispose()
  subscription.dispose()
  assert.equal(listeners.size, 0)
  const throwing = api.subscribe({ key }, () => {
    throw new Error('renderer disappeared')
  })
  await throwing.ready
  assert.equal(listeners.size, 0)
})

test('failed startup does not leave a zombie and a rejecting persister clears a busy turn', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'conversation-failure-'))
  const key = {
    workspaceRoot,
    workspaceId: 'workspace',
    agentId: 'agent',
    providerId: 'mock-provider',
    modelId: 'mock-model',
  }
  const brokenStart = new ConversationRuntime({
    adapters: [
      {
        ...createMockConversationProvider(),
        startSession() {
          throw new Error('start failed')
        },
      },
    ],
    getProviderById: () => undefined,
  })
  let writes = 0
  const brokenWrite = new ConversationRuntime({
    adapters: [createMockConversationProvider()],
    getProviderById: () => undefined,
    eventLog: {
      openStream: async () => ({
        write: async () => {
          if (++writes === 3) throw new Error('disk failed')
        },
        close: async () => {},
      }),
      onError: (_path, error) => {
        throw error
      },
    },
  })
  try {
    assert.equal((await brokenStart.startSession(key)).ok, false)
    assert.deepEqual(brokenStart.listSessions(), { ok: true, sessions: [] })
    const session = await brokenWrite.startSession(key)
    assert.ok(session.ok)
    assert.equal((await brokenWrite.sendTurn({ sessionId: session.session.sessionId, message: '/tools' })).ok, false)
    const listed = brokenWrite.listSessions()
    assert.ok(listed.ok)
    assert.equal(listed.sessions[0].status, 'failed')
  } finally {
    await brokenStart.shutdown()
    await brokenWrite.shutdown().catch(() => undefined)
    await rm(workspaceRoot, { recursive: true, force: true })
  }
})
