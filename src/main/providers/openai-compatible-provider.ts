import type {
  ConversationEvent,
  ConversationProviderTestResult,
  ConversationProviderTestState,
} from '../../shared/conversation-runtime'
import type { LoadedConversationProvider } from '../../shared/plugin-manifest'
import type {
  ConversationProviderAdapter,
  MockAdapterSessionInput,
  MockAdapterTurnInput,
} from './mock-conversation-provider'

export type ProviderSecretResolver = (
  providerId: string
) => Promise<{ ok: true; value: string } | { ok: false; message: string }>

export type OpenAiCompatibleProviderOptions = {
  getProviderById: (providerId: string) => LoadedConversationProvider | undefined
  resolveSecret: ProviderSecretResolver
  fetch?: typeof fetch
}

type ChatCompletionErrorKind =
  | 'auth'
  | 'invalid_endpoint'
  | 'network'
  | 'rate_limit'
  | 'malformed_stream'
  | 'malformed_response'
  | 'model'
  | 'interrupted'

export function createOpenAiCompatibleProvider(options: OpenAiCompatibleProviderOptions): ConversationProviderAdapter {
  const fetchImpl = options.fetch ?? fetch
  return {
    id: 'openai-compatible-api',
    listModels: () => [],
    startSession(input) {
      return [
        event(input, 'session_started'),
        event(input, 'session_ready'),
      ]
    },
    sendTurn(input) {
      return streamTurn(input, options, fetchImpl)
    },
    resolveApproval() {
      return []
    },
    interrupt(input) {
      return [event(input, 'turn_failed', { reason: 'interrupted' })]
    },
    stopSession(input) {
      return [event(input, 'session_closed')]
    },
  }
}

export async function testOpenAiCompatibleConnection(
  input: {
    providerId: string
    modelId?: string
    getProviderById: (providerId: string) => LoadedConversationProvider | undefined
    resolveSecret: ProviderSecretResolver
    fetch?: typeof fetch
  }
): Promise<ConversationProviderTestResult> {
  const provider = input.getProviderById(input.providerId)
  if (!provider) return testFailure(input.providerId, 'invalid_endpoint', 'Conversation provider is not installed.')
  if (!provider.manifest.openaiCompatible) {
    return testFailure(input.providerId, 'invalid_endpoint', 'Conversation provider is not OpenAI-compatible.')
  }

  const modelId = input.modelId?.trim() || provider.manifest.models[0]?.id
  if (!modelId || !provider.manifest.models.some((model) => model.id === modelId)) {
    return testFailure(input.providerId, 'model_error', 'Conversation model is invalid.')
  }

  const secret = await input.resolveSecret(input.providerId)
  if (!secret.ok) {
    return testFailure(input.providerId, 'missing_key', 'Provider API key is not configured.')
  }

  const endpoint = resolveEndpoint(provider)
  if (!endpoint.ok) return testFailure(input.providerId, 'invalid_endpoint', endpoint.message)

  try {
    const response = await (input.fetch ?? fetch)(endpoint.url, {
      method: 'POST',
      headers: buildHeaders(secret.value),
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content: 'Multicode connection test. Reply briefly.' }],
        max_tokens: 1,
        stream: false,
      }),
    })
    if (!response.ok) return testFailure(input.providerId, mapHttpFailure(response.status), httpFailureMessage(response.status))
    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      return testFailure(input.providerId, 'malformed_response', 'Provider returned a malformed connection-test response.')
    }
    if (!isChatCompletionResponse(payload)) {
      return testFailure(input.providerId, 'malformed_response', 'Provider returned a malformed connection-test response.')
    }
    const usage = extractUsage(payload.usage)
    return {
      ok: true,
      status: {
        providerId: input.providerId,
        state: 'reachable',
        modelId,
        message: 'Provider endpoint is reachable.',
        ...(usage ? { usage } : {}),
      },
    }
  } catch {
    return testFailure(input.providerId, 'network_error', 'Provider endpoint could not be reached.')
  }
}

async function* streamTurn(
  input: MockAdapterTurnInput,
  options: OpenAiCompatibleProviderOptions,
  fetchImpl: typeof fetch
): AsyncIterable<ConversationEvent> {
  yield event(input, 'turn_started', { turnId: input.turnId })
  const provider = options.getProviderById(input.providerId)
  if (!provider?.manifest.openaiCompatible) {
    yield failure(input, 'invalid_endpoint', 'OpenAI-compatible provider descriptor is unavailable.')
    return
  }

  const secret = await options.resolveSecret(input.providerId)
  if (!secret.ok) {
    yield failure(input, 'auth', 'Provider API key is not configured.')
    return
  }

  const endpoint = resolveEndpoint(provider)
  if (!endpoint.ok) {
    yield failure(input, 'invalid_endpoint', endpoint.message)
    return
  }

  try {
    const response = await fetchImpl(endpoint.url, {
      method: 'POST',
      headers: buildHeaders(secret.value),
      signal: input.signal,
      body: JSON.stringify({
        model: input.modelId,
        messages: [{ role: 'user', content: input.message }],
        stream: true,
        stream_options: { include_usage: true },
      }),
    })
    if (!response.ok) {
      yield failure(input, mapHttpTurnFailure(response.status), httpFailureMessage(response.status))
      return
    }
    if (!response.body) {
      yield failure(input, 'malformed_stream', 'Provider did not return a streaming response body.')
      return
    }

    let sawDone = false
    for await (const chunk of parseSse(response.body, input.signal)) {
      if (input.signal?.aborted) {
        yield failure(input, 'interrupted', 'Provider stream was interrupted.')
        return
      }
      if (chunk === '[DONE]') {
        sawDone = true
        break
      }
      let payload: any
      try {
        payload = JSON.parse(chunk)
      } catch {
        yield failure(input, 'malformed_stream', 'Provider returned malformed streaming data.')
        return
      }
      const content = payload?.choices?.[0]?.delta?.content
      if (typeof content === 'string' && content.length > 0) {
        yield event(input, 'content_delta', { turnId: input.turnId, text: content })
      }
      const usage = extractUsage(payload?.usage)
      if (usage) {
        yield event(input, 'usage_updated', {
          turnId: input.turnId,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          totalTokens: usage.totalTokens,
        })
      }
    }
    if (!sawDone) {
      yield failure(input, 'malformed_stream', 'Provider stream ended before completion.')
      return
    }
    yield event(input, 'turn_completed', { turnId: input.turnId })
  } catch {
    if (input.signal?.aborted) {
      yield failure(input, 'interrupted', 'Provider stream was interrupted.')
      return
    }
    yield failure(input, 'network', 'Provider endpoint could not be reached.')
  }
}

async function* parseSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncIterable<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const abort = (): void => {
    void reader.cancel().catch(() => undefined)
  }
  if (signal?.aborted) abort()
  signal?.addEventListener('abort', abort, { once: true })
  try {
    while (true) {
      if (signal?.aborted) break
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed.startsWith('data:')) yield trimmed.slice('data:'.length).trim()
      }
    }
    buffer += decoder.decode()
    for (const line of buffer.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (trimmed.startsWith('data:')) yield trimmed.slice('data:'.length).trim()
    }
  } finally {
    signal?.removeEventListener('abort', abort)
    reader.releaseLock()
  }
}

function resolveEndpoint(provider: LoadedConversationProvider): { ok: true; url: string } | { ok: false; message: string } {
  const config = provider.manifest.openaiCompatible
  if (!config) return { ok: false, message: 'OpenAI-compatible provider config is missing.' }
  try {
    const base = new URL(config.baseUrl)
    if (base.protocol !== 'https:' && base.protocol !== 'http:') {
      return { ok: false, message: 'Provider endpoint must use http or https.' }
    }
    const path = config.chatCompletionsPath ?? '/v1/chat/completions'
    return { ok: true, url: new URL(path, base).toString() }
  } catch {
    return { ok: false, message: 'Provider endpoint URL is invalid.' }
  }
}

function buildHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  }
}

function mapHttpFailure(status: number): Exclude<ConversationProviderTestState, 'missing_key' | 'reachable' | 'network_error' | 'malformed_response' | 'model_error'> {
  if (status === 401 || status === 403) return 'invalid_key'
  if (status === 429) return 'rate_limited'
  return 'invalid_endpoint'
}

function mapHttpTurnFailure(status: number): ChatCompletionErrorKind {
  if (status === 401 || status === 403) return 'auth'
  if (status === 429) return 'rate_limit'
  if (status === 400) return 'model'
  return 'invalid_endpoint'
}

function httpFailureMessage(status: number): string {
  if (status === 401 || status === 403) return 'Provider rejected the API key.'
  if (status === 429) return 'Provider rate limit was reached.'
  if (status === 400) return 'Provider rejected the selected model or request.'
  return 'Provider endpoint did not accept the chat-completions request.'
}

function extractUsage(value: unknown): { inputTokens?: number; outputTokens?: number; totalTokens?: number } | null {
  if (!isObject(value)) return null
  const inputTokens = numberOrUndefined(value.prompt_tokens)
  const outputTokens = numberOrUndefined(value.completion_tokens)
  const totalTokens = numberOrUndefined(value.total_tokens)
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) return null
  return { inputTokens, outputTokens, totalTokens }
}

function isChatCompletionResponse(value: unknown): value is { choices: unknown[]; usage?: unknown } {
  if (!isObject(value) || !Array.isArray(value.choices) || value.choices.length === 0) return false
  return value.choices.some((choice) => {
    if (!isObject(choice)) return false
    const message = choice.message
    if (!isObject(message)) return false
    return typeof message.content === 'string' || Array.isArray(message.content)
  })
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function testFailure(
  providerId: string,
  state: Exclude<ConversationProviderTestResult['status']['state'], 'reachable'>,
  message: string
): ConversationProviderTestResult {
  return { ok: false, status: { providerId, state, message } }
}

function failure(input: MockAdapterTurnInput, reason: ChatCompletionErrorKind, message: string): ConversationEvent {
  return event(input, 'turn_failed', { turnId: input.turnId, reason, message })
}

function event(
  input: MockAdapterSessionInput,
  type: ConversationEvent['type'],
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
