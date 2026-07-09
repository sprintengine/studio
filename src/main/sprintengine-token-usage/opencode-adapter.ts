import { emptyModelUsage, tokenCount, type FetchLike, type ModelTokenUsage } from './types'

// OpenCode keeps session data in its local server, not flat transcripts, so
// usage is read over HTTP: GET <base>/session/:id/message returns the session's
// messages as `{ info, parts }` objects; each assistant `info.tokens` is
// `{ input, output, reasoning, cache: { read, write } }`. We sum per
// `info.modelID`, mapping cache.read -> cacheRead and cache.write ->
// cacheCreation. ModelTokenUsage has no reasoning field, so reasoning tokens
// fold into `output` (consistent with how Phase 1 totals consume perModel and
// with cost math in T8). See knowledge/multicode/sprint-engine.md.
//
// The server picks a port at launch (`--port 0`), so there is no port to
// hardcode: the base URL is resolved from the OPENCODE_SERVER env var (the
// runtime/host sets it alongside OPENCODE_SERVER_PASSWORD). When it is not set,
// or the server is unreachable, or the session is unknown, the reader reports
// unmeasured (null) rather than fabricating a zero.

type OpenCodeTokens = {
  input?: unknown
  output?: unknown
  reasoning?: unknown
  cache?: { read?: unknown; write?: unknown } | null
}

type OpenCodeMessageInfo = {
  role?: unknown
  modelID?: unknown
  tokens?: OpenCodeTokens | null
}

// A reachable server returns 200 with this username; the password is the
// OPENCODE_SERVER_PASSWORD the server was started with (HTTP Basic auth).
const OPENCODE_BASIC_AUTH_USER = 'opencode'

// The server is always a local loopback process, and the request carries the
// Basic-auth password. Restrict the base URL to loopback hosts so a misconfigured
// OPENCODE_SERVER can never send those credentials to a remote origin; anything
// else reports unmeasured (null). URL parsing also rejects malformed values.
// URL.hostname serializes IPv6 with brackets, so [::1] is matched as written.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

function resolveBaseUrl(env: NodeJS.ProcessEnv): string | null {
  const raw = env.OPENCODE_SERVER?.trim()
  if (!raw) return null
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return null
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) return null
  return raw.replace(/\/+$/, '')
}

function authHeaders(env: NodeJS.ProcessEnv): Record<string, string> {
  const password = env.OPENCODE_SERVER_PASSWORD?.trim()
  if (!password) return {}
  const credentials = Buffer.from(`${OPENCODE_BASIC_AUTH_USER}:${password}`).toString('base64')
  return { Authorization: `Basic ${credentials}` }
}

// Returns null when no server is configured/reachable or the session is unknown
// (caller reports measured:false); otherwise the per-model usage summed from the
// session's assistant messages.
export async function readOpenCodeUsage(
  cliSessionId: string,
  env: NodeJS.ProcessEnv,
  fetchImpl: FetchLike,
): Promise<ModelTokenUsage[] | null> {
  const baseUrl = resolveBaseUrl(env)
  if (!baseUrl) return null

  const url = `${baseUrl}/session/${encodeURIComponent(cliSessionId)}/message`
  let response
  try {
    // redirect:'error' keeps the credentialed request on the loopback origin —
    // a 3xx cannot bounce the Basic-auth header to another host.
    response = await fetchImpl(url, { headers: authHeaders(env), redirect: 'error' })
  } catch {
    return null // server unreachable
  }
  if (!response.ok) return null // 404 session not found, 401 unauthorized, etc.

  let messages: unknown
  try {
    messages = await response.json()
  } catch {
    return null
  }
  if (!Array.isArray(messages)) return null

  const perModel = new Map<string, ModelTokenUsage>()
  for (const message of messages) {
    // The endpoint wraps each message as { info, parts }; tolerate a flat shape.
    const info = (message && typeof message === 'object' && 'info' in message
      ? (message as { info?: unknown }).info
      : message) as OpenCodeMessageInfo | undefined
    if (!info || typeof info !== 'object' || info.role !== 'assistant') continue
    const tokens = info.tokens
    if (!tokens || typeof tokens !== 'object') continue
    const model = typeof info.modelID === 'string' && info.modelID ? info.modelID : 'unknown'
    const bucket = perModel.get(model) ?? emptyModelUsage(model)
    bucket.input += tokenCount(tokens.input)
    // Reasoning folds into output (no distinct field in ModelTokenUsage).
    bucket.output += tokenCount(tokens.output) + tokenCount(tokens.reasoning)
    const cache = tokens.cache ?? {}
    bucket.cacheRead += tokenCount(cache.read)
    bucket.cacheCreation += tokenCount(cache.write)
    perModel.set(model, bucket)
  }
  return [...perModel.values()]
}
