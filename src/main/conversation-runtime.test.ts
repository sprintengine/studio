import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ConversationRuntime } from './conversation-runtime'
import type { LoadedConversationProvider } from '../shared/plugin-manifest'
import type { ProviderSecretStore } from './secret-store'
import type {
  ConversationProviderAdapter,
  MockAdapterSessionInput,
  MockAdapterTurnInput,
} from './providers/mock-conversation-provider'
import type { ConversationEvent, ConversationEventType } from '../shared/conversation-runtime'

async function main(): Promise<void> {
  await testMockSessionTurnApprovalInterruptStopAndPersistence()
  await testStartFailuresAreExplicit()
  await testProviderWithAuthRequiresConfiguredSecret()
  await testBlockedExecutableProviderTrustErrorSurfaces()
  await testOpenAiCompatibleRuntimeTurnCompletesThroughLocalEndpoint()
  await testInterruptSuppressesLateAsyncProviderEvents()
  await testStopSessionSuppressesLateAsyncProviderEvents()

  console.log('conversation-runtime tests passed')
}

async function testInterruptSuppressesLateAsyncProviderEvents(): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-conversation-runtime-'))
  try {
    let id = 0
    const gate = createDeferred<void>()
    const runtime = new ConversationRuntime({
      randomId: () => `${++id}`,
      getProviderById: () => undefined,
      secretStore: unusedSecretStore(),
      adapters: [createSlowProvider(gate)],
    })
    const events: string[] = []
    runtime.onEvent((event) => events.push(event.type))
    const started = await runtime.startSession({
      workspaceRoot,
      workspaceId: 'workspace',
      agentId: 'agent',
      providerId: 'slow-provider',
      modelId: 'slow-model',
    })
    assert.equal(started.ok, true)
    if (!started.ok) return

    const sentPromise = runtime.sendTurn({ sessionId: started.session.sessionId, message: 'slow' })
    await waitForEvent(events, 'turn_started')
    const interrupted = await runtime.interrupt({ sessionId: started.session.sessionId })
    assert.equal(interrupted.ok, true)
    if (!interrupted.ok) return
    assert.equal(interrupted.session.status, 'ready')
    gate.resolve()
    const sent = await sentPromise
    assert.equal(sent.ok, true)
    if (!sent.ok) return
    assert.equal(sent.session.status, 'ready')
    assert.deepEqual(events, ['session_started', 'session_ready', 'turn_started', 'turn_failed'])
    const persisted = await readConversationEvents(workspaceRoot, 'workspace', 'agent')
    assert.deepEqual(persisted.map((event) => event.type), events)
    assert.equal(JSON.stringify(persisted).includes('late output'), false)
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true })
  }
}

async function testStopSessionSuppressesLateAsyncProviderEvents(): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-conversation-runtime-'))
  try {
    let id = 0
    const gate = createDeferred<void>()
    const runtime = new ConversationRuntime({
      randomId: () => `${++id}`,
      getProviderById: () => undefined,
      secretStore: unusedSecretStore(),
      adapters: [createSlowProvider(gate)],
    })
    const events: string[] = []
    runtime.onEvent((event) => events.push(event.type))
    const started = await runtime.startSession({
      workspaceRoot,
      workspaceId: 'workspace',
      agentId: 'agent',
      providerId: 'slow-provider',
      modelId: 'slow-model',
    })
    assert.equal(started.ok, true)
    if (!started.ok) return

    const sentPromise = runtime.sendTurn({ sessionId: started.session.sessionId, message: 'slow' })
    await waitForEvent(events, 'turn_started')
    const stopped = await runtime.stopSession({ sessionId: started.session.sessionId })
    assert.equal(stopped.ok, true)
    if (!stopped.ok) return
    assert.equal(stopped.session.status, 'stopped')
    gate.resolve()
    const sent = await sentPromise
    assert.equal(sent.ok, true)
    if (!sent.ok) return
    assert.equal(sent.session.status, 'stopped')
    assert.deepEqual(events, ['session_started', 'session_ready', 'turn_started', 'turn_failed', 'session_closed'])
    const persisted = await readConversationEvents(workspaceRoot, 'workspace', 'agent')
    assert.deepEqual(persisted.map((event) => event.type), events)
    assert.equal(JSON.stringify(persisted).includes('late output'), false)
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true })
  }
}

async function testOpenAiCompatibleRuntimeTurnCompletesThroughLocalEndpoint(): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-conversation-runtime-'))
  const server = createServer(handleOpenAiCompatibleRequest)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const provider = openAiProvider(`http://127.0.0.1:${address.port}`)
  try {
    let id = 0
    let now = 1000
    const runtime = new ConversationRuntime({
      randomId: () => `${++id}`,
      now: () => ++now,
      getProviderById: () => provider,
      secretStore: {
        getStatus: async () => ({
          ok: true,
          status: {
            providerId: provider.manifest.id,
            configured: true,
            source: 'environment',
            persistence: 'environment',
            encryptionAvailable: false,
            label: 'API key',
          },
        }),
        resolveSecret: async () => ({ ok: true, providerId: provider.manifest.id, value: 'sk-test', source: 'environment' }),
      },
    })
    const events: string[] = []
    runtime.onEvent((event) => events.push(event.type))

    const started = await runtime.startSession({
      workspaceRoot,
      workspaceId: 'workspace',
      agentId: 'agent',
      providerId: provider.manifest.id,
      modelId: 'test-model',
    })
    assert.equal(started.ok, true)
    if (!started.ok) return
    const sent = await runtime.sendTurn({ sessionId: started.session.sessionId, message: 'hello' })
    assert.equal(sent.ok, true)
    if (!sent.ok) return
    assert.equal(sent.session.status, 'ready')
    assert.deepEqual(events, [
      'session_started',
      'session_ready',
      'turn_started',
      'content_delta',
      'content_delta',
      'usage_updated',
      'turn_completed',
    ])

    const persisted = await readConversationEvents(workspaceRoot, 'workspace', 'agent')
    assert.equal(JSON.stringify(persisted).includes('sk-test'), false)
    assert.deepEqual(persisted.at(-2)?.payload, {
      turnId: 'turn_2',
      inputTokens: 3,
      outputTokens: 2,
      totalTokens: 5,
    })
  } finally {
    server.close()
    await once(server, 'close')
    await rm(workspaceRoot, { recursive: true, force: true })
  }
}

async function testMockSessionTurnApprovalInterruptStopAndPersistence(): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-conversation-runtime-'))
  try {
    let id = 0
    let now = 100
    const runtime = new ConversationRuntime({
      randomId: () => `${++id}`,
      now: () => ++now,
      getProviderById: () => undefined,
      secretStore: unusedSecretStore(),
    })
    const events: string[] = []
    runtime.onEvent((event) => events.push(event.type))

    const started = await runtime.startSession({
      workspaceRoot,
      workspaceId: 'workspace/one',
      agentId: 'agent-one',
      providerId: 'mock-provider',
      modelId: 'mock-model',
    })
    assert.equal(started.ok, true)
    if (!started.ok) return
    assert.equal(started.session.status, 'ready')

    const sent = await runtime.sendTurn({ sessionId: started.session.sessionId, message: 'hello' })
    assert.equal(sent.ok, true)
    if (!sent.ok) return
    assert.equal(sent.session.status, 'awaiting_approval')

    const requestEvent = await readLastEvent(workspaceRoot, 'workspace/one', 'agent-one')
    assert.equal(requestEvent.type, 'approval_requested')
    assert.equal(JSON.stringify(requestEvent).includes('secret'), false)

    const resolved = await runtime.respondToRequest({
      sessionId: started.session.sessionId,
      requestId: requestEvent.payload?.requestId as string,
      approved: true,
    })
    assert.equal(resolved.ok, true)
    if (!resolved.ok) return
    assert.equal(resolved.session.status, 'ready')

    await runtime.sendTurn({ sessionId: started.session.sessionId, message: 'interrupt me' })
    const interrupted = await runtime.interrupt({ sessionId: started.session.sessionId })
    assert.equal(interrupted.ok, true)
    if (!interrupted.ok) return
    assert.equal(interrupted.session.status, 'ready')

    const stopped = await runtime.stopSession({ sessionId: started.session.sessionId })
    assert.equal(stopped.ok, true)
    assert.deepEqual(runtime.listSessions({ workspaceId: 'workspace/one' }).ok, true)
    assert.deepEqual(events, [
      'session_started',
      'session_ready',
      'turn_started',
      'content_delta',
      'approval_requested',
      'approval_resolved',
      'usage_updated',
      'turn_completed',
      'turn_started',
      'content_delta',
      'approval_requested',
      'turn_failed',
      'session_closed',
    ])
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true })
  }
}

async function testStartFailuresAreExplicit(): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-conversation-runtime-'))
  try {
    const runtime = new ConversationRuntime({
      getProviderById: () => undefined,
      secretStore: unusedSecretStore(),
    })

    assert.deepEqual(
      await runtime.startSession({
        workspaceRoot: join(workspaceRoot, 'missing'),
        workspaceId: 'workspace',
        agentId: 'agent',
        providerId: 'mock-provider',
        modelId: 'mock-model',
      }),
      { ok: false, message: 'Workspace path is unavailable.' }
    )
    assert.deepEqual(
      await runtime.startSession({
        workspaceRoot,
        workspaceId: 'workspace',
        agentId: 'agent',
        providerId: 'missing-provider',
        modelId: 'mock-model',
      }),
      { ok: false, message: 'Conversation provider is not installed.' }
    )
    assert.deepEqual(
      await runtime.startSession({
        workspaceRoot,
        workspaceId: 'workspace',
        agentId: 'agent',
        providerId: 'mock-provider',
        modelId: 'bad-model',
      }),
      { ok: false, message: 'Conversation model is invalid.' }
    )
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true })
  }
}

async function testProviderWithAuthRequiresConfiguredSecret(): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-conversation-runtime-'))
  try {
    const runtime = new ConversationRuntime({
      adapters: [],
      getProviderById: () => ({
        manifest: {
          kind: 'provider',
          id: 'openai-compatible',
          displayName: 'OpenAI Compatible',
          version: 1,
          providerType: 'model-provider',
          models: [{ id: 'gpt-5' }],
          auth: { type: 'api-key', label: 'API key', env: 'OPENAI_API_KEY' },
        },
        source: 'bundled',
        manifestPath: '/fixtures/openai-compatible/plugin.json',
        pluginRoot: '/fixtures/openai-compatible',
        adapter: { kind: 'declarative', execution: 'declarative', trust: 'not_required' },
      }),
      secretStore: {
        getStatus: async () => ({
          ok: true,
          status: {
            providerId: 'openai-compatible',
            configured: false,
            source: 'none',
            persistence: 'encrypted',
            encryptionAvailable: true,
            label: 'API key',
          },
        }),
      },
    })

    assert.deepEqual(
      await runtime.startSession({
        workspaceRoot,
        workspaceId: 'workspace',
        agentId: 'agent',
        providerId: 'openai-compatible',
        modelId: 'gpt-5',
      }),
      { ok: false, message: 'Conversation provider secret is not configured.' }
    )
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true })
  }
}

async function testBlockedExecutableProviderTrustErrorSurfaces(): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-conversation-runtime-'))
  try {
    const runtime = new ConversationRuntime({
      adapters: [],
      getProviderById: () => ({
        manifest: {
          kind: 'provider',
          id: 'unsigned-adapter',
          displayName: 'Unsigned Adapter',
          version: 1,
          providerType: 'model-provider',
          models: [{ id: 'demo' }],
          adapter: {
            kind: 'trusted-executable',
            entry: 'dist/provider.js',
            sha256: '0'.repeat(64),
          },
        },
        source: 'user',
        manifestPath: '/fixtures/unsigned-adapter/plugin.json',
        pluginRoot: '/fixtures/unsigned-adapter',
        adapter: {
          kind: 'trusted-executable',
          execution: 'blocked',
          trust: 'unsigned',
          entry: 'dist/provider.js',
          trustError: 'Unsigned executable provider adapters cannot run in production mode.',
        },
      }),
      secretStore: unusedSecretStore(),
    })

    assert.deepEqual(
      await runtime.startSession({
        workspaceRoot,
        workspaceId: 'workspace',
        agentId: 'agent',
        providerId: 'unsigned-adapter',
        modelId: 'demo',
      }),
      { ok: false, message: 'Unsigned executable provider adapters cannot run in production mode.' }
    )
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true })
  }
}

function unusedSecretStore(): Pick<ProviderSecretStore, 'getStatus'> & Partial<Pick<ProviderSecretStore, 'resolveSecret'>> {
  return {
    getStatus: async () => ({ ok: false, message: 'unused' }),
    resolveSecret: async () => ({ ok: false, message: 'unused' }),
  }
}

function createSlowProvider(gate: { promise: Promise<void> }): ConversationProviderAdapter {
  return {
    id: 'slow-provider',
    listModels: () => ['slow-model'],
    startSession(input) {
      return [runtimeEvent(input, 'session_started'), runtimeEvent(input, 'session_ready')]
    },
    async *sendTurn(input: MockAdapterTurnInput) {
      yield runtimeEvent(input, 'turn_started', { turnId: input.turnId })
      await gate.promise
      yield runtimeEvent(input, 'content_delta', { turnId: input.turnId, text: 'late output' })
      yield runtimeEvent(input, 'usage_updated', { turnId: input.turnId, inputTokens: 1, outputTokens: 2 })
      yield runtimeEvent(input, 'turn_completed', { turnId: input.turnId })
    },
    resolveApproval() {
      return []
    },
    interrupt(input) {
      return [runtimeEvent(input, 'turn_failed', { reason: 'interrupted' })]
    },
    stopSession(input) {
      return [runtimeEvent(input, 'session_closed')]
    },
  }
}

function runtimeEvent(
  input: MockAdapterSessionInput,
  type: ConversationEventType,
  payload?: Record<string, unknown>
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

function createDeferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function waitForEvent(events: string[], type: string): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (events.includes(type)) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error(`Timed out waiting for ${type}`)
}

async function readLastEvent(workspaceRoot: string, workspaceId: string, agentId: string): Promise<Record<string, any>> {
  const events = await readConversationEvents(workspaceRoot, workspaceId, agentId)
  return events[events.length - 1] ?? {}
}

async function readConversationEvents(workspaceRoot: string, workspaceId: string, agentId: string): Promise<Record<string, any>[]> {
  const content = await readFile(
    join(workspaceRoot, '.multi-code', 'conversations', encodeURIComponent(workspaceId.replace(/[\\/]/g, '-')), `${agentId}.jsonl`),
    'utf-8'
  )
  return content.trim().split('\n').map((line) => JSON.parse(line) as Record<string, any>)
}

function openAiProvider(baseUrl: string): LoadedConversationProvider {
  return {
    manifest: {
      kind: 'provider',
      id: 'openai-compatible-api',
      displayName: 'OpenAI Compatible API',
      version: 1,
      providerType: 'model-provider',
      models: [{ id: 'test-model' }],
      auth: { type: 'api-key', label: 'API key', env: 'OPENAI_API_KEY' },
      adapter: { kind: 'declarative' },
      openaiCompatible: { baseUrl, chatCompletionsPath: '/v1/chat/completions' },
    },
    source: 'bundled',
    manifestPath: '/fixtures/openai-compatible-api/plugin.json',
    pluginRoot: '/fixtures/openai-compatible-api',
    adapter: { kind: 'declarative', execution: 'declarative', trust: 'not_required' },
  }
}

function handleOpenAiCompatibleRequest(req: IncomingMessage, res: ServerResponse): void {
  if (req.url !== '/v1/chat/completions' || req.headers.authorization !== 'Bearer sk-test') {
    res.writeHead(req.headers.authorization === 'Bearer sk-test' ? 404 : 401)
    res.end()
    return
  }
  const chunks: Buffer[] = []
  req.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
  req.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { stream?: boolean }
    assert.equal(body.stream, true)
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write('data: {"choices":[{"delta":{"content":"hello "}}]}\n\n')
    res.write('data: {"choices":[{"delta":{"content":"world"}}]}\n\n')
    res.write('data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n')
    res.end('data: [DONE]\n\n')
  })
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
