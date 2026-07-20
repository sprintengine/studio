import { TrackerProviderError, type TrackerConnection } from '../../../shared/tracker/types'

// The Jira REST v2 request layer. Cloud and Data Center share this exact surface;
// the ONLY difference is the Authorization header (plan D2): Cloud sends Basic
// (email + API token), Data Center sends a Bearer PAT. Every non-2xx response
// degrades to a typed TrackerProviderError carrying Jira's own message — a stack
// trace never escapes this module (plan §3.3).

export const JIRA_API_BASE = '/rest/api/2'

export type JiraRequest = {
  connection: TrackerConnection
  secret: string
  path: string // relative to the site root, e.g. '/rest/api/2/search'
  query?: Record<string, string | number | undefined>
  method?: 'GET' | 'POST'
  body?: unknown
}

// Performs a Jira request and returns the parsed JSON (or `undefined` for an
// empty 2xx body, e.g. a 204 from adding a comment).
export async function jiraFetch(request: JiraRequest, fetchImpl: typeof fetch): Promise<unknown> {
  const { connection } = request
  if (!connection.baseUrl) {
    throw new TrackerProviderError('not_configured', 'This Jira connection has no server address.', {
      provider: 'jira',
      connectionId: connection.id,
    })
  }

  const url = buildUrl(connection.baseUrl, request.path, request.query)
  const method = request.method ?? 'GET'
  const headers: Record<string, string> = {
    Accept: 'application/json',
    Authorization: buildAuthHeader(connection, request.secret),
    'User-Agent': 'multicode-tracker',
  }
  if (request.body !== undefined) headers['Content-Type'] = 'application/json'

  let response: Response
  try {
    response = await fetchImpl(url, {
      method,
      headers,
      ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}),
    })
  } catch (err) {
    throw new TrackerProviderError('network', err instanceof Error ? err.message : 'Could not reach the Jira server.', {
      provider: 'jira',
      connectionId: connection.id,
    })
  }

  if (!response.ok) throw await toProviderError(response, connection)

  if (response.status === 204) return undefined
  const raw = await response.text()
  if (!raw.trim()) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    throw new TrackerProviderError('unknown', 'Jira returned a response that could not be parsed.', {
      provider: 'jira',
      connectionId: connection.id,
    })
  }
}

// The one auth branch (plan D2): Cloud Basic packs `email:token` — the connection
// secret is stored colon-joined — into base64; Data Center sends the PAT as a
// Bearer token. Both against the identical REST v2 paths.
function buildAuthHeader(connection: TrackerConnection, secret: string): string {
  if (connection.authMode === 'jira_pat') return `Bearer ${secret}`
  // jira_basic: the secret is the `email:api_token` pair; base64 of `user:pass`
  // is exactly HTTP Basic. A secret missing the colon yields a malformed Basic
  // header and an honest 401 rather than a silent wrong-auth guess.
  return `Basic ${Buffer.from(secret).toString('base64')}`
}

function buildUrl(baseUrl: string, path: string, query?: JiraRequest['query']): string {
  const root = baseUrl.replace(/\/+$/, '')
  const url = new URL(`${root}${path}`)
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }
  }
  return url.toString()
}

// Maps a Jira error response to a typed error, preserving Jira's human-readable
// message. Jira error bodies carry `errorMessages: string[]` and/or `errors: {}`.
async function toProviderError(response: Response, connection: TrackerConnection): Promise<TrackerProviderError> {
  const message = await extractJiraMessage(response)
  const context = { provider: 'jira' as const, connectionId: connection.id }

  if (response.status === 401 || response.status === 403) {
    return new TrackerProviderError('auth', message ?? 'Jira rejected the credentials for this connection.', context)
  }
  if (response.status === 429) {
    const retryAfter = parseRetryAfter(response.headers.get('retry-after'))
    return new TrackerProviderError('rate_limit', message ?? 'Jira rate limit reached. Try again shortly.', {
      ...context,
      ...(retryAfter !== undefined ? { retryAfterSeconds: retryAfter } : {}),
    })
  }
  if (response.status === 404) {
    return new TrackerProviderError('not_found', message ?? 'That Jira issue could not be found.', context)
  }
  return new TrackerProviderError('unknown', message ?? `Jira request failed with HTTP ${response.status}.`, context)
}

async function extractJiraMessage(response: Response): Promise<string | undefined> {
  let raw: string
  try {
    raw = await response.text()
  } catch {
    return undefined
  }
  if (!raw.trim()) return undefined
  try {
    const parsed = JSON.parse(raw) as { errorMessages?: unknown; errors?: unknown; message?: unknown }
    const fromMessages = Array.isArray(parsed.errorMessages)
      ? parsed.errorMessages.filter((m): m is string => typeof m === 'string')
      : []
    const fromErrors =
      parsed.errors && typeof parsed.errors === 'object'
        ? Object.values(parsed.errors as Record<string, unknown>).filter((m): m is string => typeof m === 'string')
        : []
    const combined = [...fromMessages, ...fromErrors]
    if (combined.length > 0) return combined.join(' ')
    if (typeof parsed.message === 'string' && parsed.message.trim()) return parsed.message.trim()
  } catch {
    // Non-JSON error body (e.g. an HTML 502 from a proxy): fall back to a slice.
    const snippet = raw.trim().slice(0, 200)
    if (snippet && !snippet.startsWith('<')) return snippet
  }
  return undefined
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined
  const seconds = Number(header.trim())
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined
}
