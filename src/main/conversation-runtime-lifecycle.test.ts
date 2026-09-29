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

test('a chat child in the process tree is labelled with the CLI it runs', async () => {
  const runtime = new ConversationRuntime({
    getProviderById: () => undefined,
    adapters: [
      {
        ...echoProvider(),
        id: 'codex-agent',
        listLiveSessions: () => [
          {
            sessionId: 'conv_codex',
            workspaceId: 'workspace',
            agentId: 'agent',
            workspaceRoot: '/Users/dev/project',
            providerSessionId: 'thread',
            hasChildProcess: true,
            childPid: 4242,
            turnActive: false,
            pendingApproval: false,
            lastActivityAt: 5,
            spawnedAt: 3,
          },
        ],
      },
    ],
  })
  assert.deepEqual(
    runtime.listLiveConversationRoots().map((root) => [root.sessionId, root.cli, root.activityKind]),
    [['conv_codex', 'codex', 'idle']],
  )
})

/**
 * A stateful provider whose child can be disposed, and which reports an agent
 * it spawned in the background through the session's continuation channel.
 */
function backgroundAgentProvider() {
  const disposed: string[] = []
  let sink: ((event: ConversationEvent) => void) | undefined
  let session: MockAdapterSessionInput | undefined
  const adapter: ConversationProviderAdapter = {
    ...echoProvider(),
    id: 'agent-provider',
    sessions: 'stateful',
    startSession: (input) => {
      sink = input.onSessionEvent
      session = input
      return [runtimeEvent(input, 'session_started'), runtimeEvent(input, 'session_ready')]
    },
    disposeChildProcess: (sessionId) => {
      disposed.push(sessionId)
      return true
    },
  }
  const agent = (status: 'running' | 'completed') =>
    sink!(
      runtimeEvent(session!, 'subagent_status', {
        toolUseId: 'task_1',
        status,
        background: true,
        description: 'Run the long suite',
      }),
    )
  return { adapter, disposed, agent }
}

function backgroundAgents(runtime: ConversationRuntime): number | undefined {
  const listed = runtime.listSessions()
  return listed.ok ? listed.sessions[0]?.backgroundAgents : undefined
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400 && !predicate(); attempt++) await new Promise((r) => setTimeout(r, 5))
  assert.ok(predicate())
}

test('the idle sweep leaves a chat whose background agent is still running', async () => {
  let clock = 1_000_000
  const provider = backgroundAgentProvider()
  await withRuntime(
    [provider.adapter],
    async ({ runtime, workspaceRoot }) => {
      runtime.setIdleThresholdMs(60_000)
      const started = await runtime.startSession({
        workspaceRoot,
        workspaceId: 'workspace',
        agentId: 'agent',
        providerId: 'agent-provider',
        modelId: 'model',
      })
      assert.ok(started.ok)
      const sessionId = started.session.sessionId
      assert.ok((await runtime.sendTurn({ sessionId, message: 'start the suite in the background' })).ok)
      provider.agent('running')
      await until(() => backgroundAgents(runtime) === 1)

      assert.deepEqual(runtime.sweepIdleSessions(clock + 10 * 60_000), [])
      assert.deepEqual(provider.disposed, [])

      provider.agent('completed')
      await until(() => !backgroundAgents(runtime))
      assert.deepEqual(runtime.sweepIdleSessions(clock + 10 * 60_000), [sessionId])
      assert.deepEqual(provider.disposed, [sessionId])
    },
    { now: () => clock },
  )
})

test('the idle sweep rests while the machine sleeps', async () => {
  const listeners = { suspend: new Set<() => void>(), resume: new Set<() => void>() }
  let suspended = false
  const activity = {
    isSuspended: () => suspended,
    onSuspend: (listener: () => void) => {
      listeners.suspend.add(listener)
      return () => listeners.suspend.delete(listener)
    },
    onResume: (listener: () => void) => {
      listeners.resume.add(listener)
      return () => listeners.resume.delete(listener)
    },
  }
  const timers = new Set<unknown>()
  const realSetInterval = globalThis.setInterval
  const realClearInterval = globalThis.clearInterval
  globalThis.setInterval = ((handler: () => void, ms: number) => {
    const timer = realSetInterval(handler, ms)
    timers.add(timer)
    return timer
  }) as typeof setInterval
  globalThis.clearInterval = ((timer: NodeJS.Timeout) => {
    timers.delete(timer)
    realClearInterval(timer)
  }) as typeof clearInterval
  try {
    const runtime = new ConversationRuntime({ getProviderById: () => undefined, adapters: [echoProvider()] })
    runtime.startIdleSweep(activity)
    assert.equal(timers.size, 1)
    suspended = true
    for (const listener of listeners.suspend) listener()
    assert.equal(timers.size, 0)
    suspended = false
    for (const listener of listeners.resume) listener()
    assert.equal(timers.size, 1)
    runtime.stopIdleSweep()
    assert.equal(timers.size, 0)
    assert.equal(listeners.suspend.size + listeners.resume.size, 0)
  } finally {
    globalThis.setInterval = realSetInterval
    globalThis.clearInterval = realClearInterval
  }
})
