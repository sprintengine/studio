import { TrackerProviderError, type TrackerErrorKind } from '../../../shared/tracker/types'

// Low-level Linear GraphQL transport (plan §3.1, MC-1636). One POST to the Linear
// GraphQL endpoint carrying a personal API key in the `Authorization` header
// (personal keys are sent verbatim — no `Bearer` prefix). Every failure — HTTP
// status, network/timeout, or a GraphQL `errors` array on a 200 — is mapped to a
// typed TrackerProviderError carrying Linear's own human-readable message, so the
// service can redact it to a TrackerError without ever leaking a stack trace.

export const LINEAR_GRAPHQL_ENDPOINT = 'https://api.linear.app/graphql'
export const LINEAR_REQUEST_TIMEOUT_MS = 20_000

export type LinearFetch = (url: string, init: RequestInit) => Promise<Response>

// The subset of a GraphQL error Linear returns. `extensions.type` is the
// structural failure category ('authentication error', 'ratelimited', …) — we map
// on it rather than string-matching the human message.
type LinearGraphQLError = {
  message?: string
  extensions?: { type?: string; code?: string }
}

type LinearGraphQLBody<T> = { data?: T; errors?: LinearGraphQLError[] }

export type PostLinearGraphQLArgs = {
  endpoint: string
  apiKey: string
  query: string
  variables: Record<string, unknown>
  fetchImpl: LinearFetch
  timeoutMs: number
  connectionId: string
}

// Executes one GraphQL operation and returns its `data`, or throws a typed
// TrackerProviderError. Throws (never returns partial data) when the response
// carries a GraphQL `errors` array, matching Linear's convention of returning
// 200 + errors for validation/auth failures alongside non-2xx for transport ones.
export async function postLinearGraphQL<T>(args: PostLinearGraphQLArgs): Promise<T> {
  const { endpoint, apiKey, query, variables, fetchImpl, timeoutMs, connectionId } = args
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  let response: Response
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        authorization: apiKey,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    })
  } catch (err) {
    // fetch rejects on DNS failure, connection reset, or the timeout abort.
    const aborted = err instanceof Error && err.name === 'AbortError'
    throw new TrackerProviderError(
      'network',
      aborted ? 'Linear did not respond in time.' : 'Could not reach Linear.',
      { provider: 'linear', connectionId }
    )
  } finally {
    clearTimeout(timer)
  }

  const body = await readJsonBody<T>(response)

  if (!response.ok) {
    throw statusError(response, body, connectionId)
  }

  if (body?.errors && body.errors.length > 0) {
    throw graphQLError(body.errors, connectionId)
  }

  if (!body || body.data === undefined) {
    throw new TrackerProviderError('unknown', 'Linear returned an empty response.', {
      provider: 'linear',
      connectionId,
    })
  }

  return body.data
}

async function readJsonBody<T>(response: Response): Promise<LinearGraphQLBody<T> | null> {
  try {
    return (await response.json()) as LinearGraphQLBody<T>
  } catch {
    return null
  }
}

// Maps a non-2xx transport response. Prefers a GraphQL error message from the
// parsed body (Linear often includes one on 400/401), else a status-derived line.
function statusError(
  response: Response,
  body: { errors?: LinearGraphQLError[] } | null,
  connectionId: string
): TrackerProviderError {
  const kind = statusKind(response.status)
  const message = body?.errors?.[0]?.message ?? defaultStatusMessage(response.status)
  const retryAfterSeconds = kind === 'rate_limit' ? parseRetryAfter(response) : undefined
  return new TrackerProviderError(kind, message, {
    provider: 'linear',
    connectionId,
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
  })
}

// Maps a GraphQL `errors` array (returned with HTTP 200). Linear tags each error
// with a structural `extensions.type`; we map on that and surface Linear's message.
function graphQLError(errors: LinearGraphQLError[], connectionId: string): TrackerProviderError {
  const first = errors[0]
  const kind = graphQLErrorKind(first?.extensions?.type)
  const message = first?.message ?? 'Linear rejected the request.'
  return new TrackerProviderError(kind, message, { provider: 'linear', connectionId })
}

function statusKind(status: number): TrackerErrorKind {
  if (status === 401 || status === 403) return 'auth'
  if (status === 429) return 'rate_limit'
  if (status === 404) return 'not_found'
  if (status >= 500) return 'network'
  return 'unknown'
}

function graphQLErrorKind(type: string | undefined): TrackerErrorKind {
  switch (type?.trim().toLowerCase()) {
    case 'authentication error':
    case 'authentication':
      return 'auth'
    case 'ratelimited':
      return 'rate_limit'
    case 'entity not found':
      return 'not_found'
    default:
      return 'unknown'
  }
}

function defaultStatusMessage(status: number): string {
  if (status === 401 || status === 403) return 'Linear rejected the API key.'
  if (status === 429) return 'Linear rate limit reached.'
  if (status === 404) return 'The Linear issue could not be found.'
  if (status >= 500) return 'Linear is temporarily unavailable.'
  return `Linear returned an unexpected response (HTTP ${status}).`
}

function parseRetryAfter(response: Response): number | undefined {
  const header = response.headers.get('retry-after')
  if (!header) return undefined
  const seconds = Number.parseInt(header, 10)
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined
}
