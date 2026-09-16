import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'

import type { ConversationEvent } from '../../shared/conversation-runtime'
import type { LoadedConversationProvider } from '../../shared/plugin-manifest'
import {
  createOpenAiCompatibleProvider,
  listOpenAiCompatibleModels,
} from './openai-compatible-provider'

async function main(): Promise<void> {
  const server = createServer(handleRequest)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const baseUrl = `http://127.0.0.1:${address.port}`

  try {
    await testLiveModelCatalog(baseUrl)
    await testStreamingTurnProducesCanonicalEvents(baseUrl)
    await testStreamingTurnCancellationReportsInterrupted(baseUrl)
  } finally {
    server.close()
    await once(server, 'close')
  }

  console.log('openai-compatible-provider tests passed')
}

async function testLiveModelCatalog(baseUrl: string): Promise<void> {
  const dynamic = modelsProvider(baseUrl, '/v1/models')

  const ok = await listOpenAiCompatibleModels({
    providerId: dynamic.manifest.id,
    getProviderById: () => dynamic,
    resolveSecret: async () => ({ ok: true, value: 'sk-test' }),
  })
  assert.ok(ok.ok, 'live model catalog fetch succeeds')
  assert.deepEqual(
    ok.models,
    [{ id: 'model-a', displayName: 'Model A', contextLength: 262144 }, { id: 'model-b' }],
    'models parse from { data: [...] }, name → displayName, context_length → contextLength, bad entries dropped',
  )

  // A provider without modelsPath has no live catalog.
  const staticOnly = loadedProvider(baseUrl)
  const noCatalog = await listOpenAiCompatibleModels({
    providerId: staticOnly.manifest.id,
    getProviderById: () => staticOnly,
    resolveSecret: async () => ({ ok: true, value: 'sk-test' }),
  })
  assert.equal(noCatalog.ok, false, 'a provider without modelsPath reports no catalog')

  // A failing endpoint surfaces ok:false (renderer falls back to seed models).
  const failing = modelsProvider(baseUrl, '/missing')
  const failed = await listOpenAiCompatibleModels({
    providerId: failing.manifest.id,
    getProviderById: () => failing,
    resolveSecret: async () => ({ ok: true, value: 'sk-test' }),
  })
  assert.equal(failed.ok, false, 'a non-200 model catalog response fails closed')
}

function modelsProvider(baseUrl: string, modelsPath: string): LoadedConversationProvider {
  const provider = loadedProvider(baseUrl)
  return {
    ...provider,
    manifest: {
      ...provider.manifest,
      openaiCompatible: { baseUrl, chatCompletionsPath: '/v1/chat/completions', modelsPath },
    },
  }
}

async function testStreamingTurnCancellationReportsInterrupted(baseUrl: string): Promise<void> {
  const provider = loadedProvider(baseUrl)
  const controller = new AbortController()
  const adapter = createOpenAiCompatibleProvider({
    getProviderById: () => provider,
    resolveSecret: async () => ({ ok: true, value: 'sk-test' }),
    fetch: async (_url, init) => {
      const signal = init?.signal as AbortSignal | undefined
      await new Promise<void>((_, reject) => {
        if (signal?.aborted) {
          reject(new Error('aborted'))
          return
        }
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
      throw new Error('unreachable')
    },
  })
  const eventsPromise = collectEvents(adapter.sendTurn({
    sessionId: 'conv_1',
    workspaceId: 'workspace',
    agentId: 'agent',
    providerId: provider.manifest.id,
    modelId: 'test-model',
    turnId: 'turn_cancelled',
    requestId: 'approval_cancelled',
    message: 'hello',
    signal: controller.signal,
  }))
  await new Promise((resolve) => setTimeout(resolve, 0))
  controller.abort()
  const events = await eventsPromise
  assert.deepEqual(events.map((event) => event.type), ['turn_started', 'turn_failed'])
  assert.equal(events.at(-1)?.payload?.reason, 'interrupted')
  assert.equal(JSON.stringify(events).includes('sk-test'), false)
}

async function testStreamingTurnProducesCanonicalEvents(baseUrl: string): Promise<void> {
  const provider = loadedProvider(baseUrl)
  const adapter = createOpenAiCompatibleProvider({
    getProviderById: () => provider,
    resolveSecret: async () => ({ ok: true, value: 'sk-test' }),
  })
  const events = await collectEvents(adapter.sendTurn({
    sessionId: 'conv_1',
    workspaceId: 'workspace',
    agentId: 'agent',
    providerId: provider.manifest.id,
    modelId: 'test-model',
    turnId: 'turn_1',
    requestId: 'approval_1',
    message: 'hello',
  }))
  assert.deepEqual(events.map((event) => event.type), [
    'turn_started',
    'content_delta',
    'content_delta',
    'usage_updated',
    'turn_completed',
  ])
  assert.deepEqual(events.find((event) => event.type === 'usage_updated')?.payload, {
    turnId: 'turn_1',
    inputTokens: 3,
    outputTokens: 2,
    totalTokens: 5,
  })
  assert.equal(JSON.stringify(events).includes('sk-test'), false)

  const malformedProvider = loadedProvider(baseUrl, '/malformed-stream')
  const malformedAdapter = createOpenAiCompatibleProvider({
    getProviderById: () => malformedProvider,
    resolveSecret: async () => ({ ok: true, value: 'sk-test' }),
  })
  const malformedEvents = await collectEvents(malformedAdapter.sendTurn({
    sessionId: 'conv_1',
    workspaceId: 'workspace',
    agentId: 'agent',
    providerId: malformedProvider.manifest.id,
    modelId: 'test-model',
    turnId: 'turn_2',
    requestId: 'approval_2',
    message: 'hello',
  }))
  assert.equal(malformedEvents.at(-1)?.type, 'turn_failed')
  assert.equal(malformedEvents.at(-1)?.payload?.reason, 'malformed_stream')
}

async function collectEvents(events: ReturnType<ReturnType<typeof createOpenAiCompatibleProvider>['sendTurn']>): Promise<ConversationEvent[]> {
  const resolved = await events
  if (Array.isArray(resolved)) return resolved
  const collected: ConversationEvent[] = []
  for await (const event of resolved) collected.push(event)
  return collected
}

function loadedProvider(baseUrl: string, path = '/v1/chat/completions'): LoadedConversationProvider {
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
      openaiCompatible: { baseUrl, chatCompletionsPath: path },
    },
    source: 'bundled',
    manifestPath: '/fixtures/openai-compatible-api/plugin.json',
    pluginRoot: '/fixtures/openai-compatible-api',
    adapter: { kind: 'declarative', execution: 'declarative', trust: 'not_required' },
  }
}

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  if (req.headers.authorization !== 'Bearer sk-test') {
    res.writeHead(401, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'invalid key' } }))
    return
  }
  if (req.url === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        data: [
          { id: 'model-a', name: 'Model A', context_length: 262144 },
          { id: 'model-b' },
          { name: 'no id, dropped' },
          { id: '' },
        ],
      }),
    )
    return
  }
  if (req.url === '/missing') {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'missing endpoint' } }))
    return
  }
  if (req.url === '/rate-limit') {
    res.writeHead(429, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'rate limit' } }))
    return
  }
  if (req.url === '/malformed') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('{bad json')
    return
  }
  if (req.url === '/not-chat-completions') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({}))
    return
  }
  if (req.url === '/malformed-stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.end('data: {bad json\n\n')
    return
  }
  if (req.url !== '/v1/chat/completions') {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'not found' } }))
    return
  }

  const chunks: Buffer[] = []
  req.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
  req.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { stream?: boolean }
    if (!body.stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'ok' } }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      }))
      return
    }
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
