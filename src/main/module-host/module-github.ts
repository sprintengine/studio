// The signed-in user's GitHub, brokered for modules (SDK `getGitHubService`,
// permission `github`).
//
// A module names a REST route and its parameters; the host attaches the token
// the app itself uses (github-token-store.ts) and sends the request to
// https://api.github.com — nowhere else. The token never reaches module code:
// not in a response, not in an error.
//
// A route is a `/`-prefixed template (`/repos/{owner}/{repo}/pulls`). The
// template is literal path characters and `{name}` placeholders only; each
// placeholder is filled from `params` URL-encoded, so a value cannot add a
// segment, a query or a host. Parameters no placeholder used become the query
// string. Anything that could move the request off api.github.com — a scheme,
// `//`, a backslash, `..`, a percent-escape in the template — is `invalid_route`,
// and the built URL is checked once more against the origin and the path it
// was meant to have.
//
// Permissions are read per call from the module's declared list. `request`
// answers `permission_missing`; `status` has no failure shape and rejects.
//
// Three additions keep a module from working around the broker:
// - Answers carry an allow-list of response headers (rate limit, pagination,
//   the etag) and a request may send `If-None-Match` and one of GitHub's own
//   media types, so polling is cheap and a diff is one call.
// - `graphql` is a read: a document with a `mutation` or `subscription`
//   operation is refused before anything is sent.
// - `download` follows the one redirect GitHub answers a log or archive with,
//   only to GitHub's storage hosts and only after taking the token off.

import type {
  ModuleGitHubDownloadRequest,
  ModuleGitHubDownloadResponse,
  ModuleGitHubMediaType,
  ModuleGitHubRegistry,
  ModuleGitHubRequest,
  ModuleGitHubResponse,
  ModuleGitHubService,
} from '../../shared/modules/brokers'
import { brokerRequest, redactSecret, type BrokerFetch, type BrokerHttpResponse } from './broker-http'

export type ModuleGitHubDeps = {
  /** The app's GitHub token store; an empty string means nobody is signed in. */
  tokenStore: { resolveToken(): Promise<string> }
  /** The permissions the module declared in its manifest. */
  getModulePermissions: (moduleId: string) => readonly string[] | undefined
  /** Defaults to the global fetch. */
  fetch?: BrokerFetch
  /** Clock for the signed-in login cache; tests only. */
  now?: () => number
}

export type ModuleGitHubModuleRegistry = {
  forModule(moduleId: string): ModuleGitHubService
  /** The moduleId-first shape the `github.module-service` token carries. */
  registry: ModuleGitHubRegistry
}

type Failure = Extract<ModuleGitHubResponse, { ok: false }>

export const GITHUB_API_ORIGIN = 'https://api.github.com'
// A page of 100 pull requests runs past 1 MiB; this still bounds what one
// module call can make the host hold.
export const MODULE_GITHUB_RESPONSE_LIMIT_BYTES = 8 * 1024 * 1024
// A job's log or a small archive, read whole; base64 adds a third on top.
export const MODULE_GITHUB_DOWNLOAD_LIMIT_BYTES = 16 * 1024 * 1024
const GITHUB_TIMEOUT_MS = 30_000
const GITHUB_DOWNLOAD_TIMEOUT_MS = 60_000
const DEFAULT_ACCEPT = 'application/vnd.github+json'
// GitHub's own media types, and nothing else: a module asks for a format the
// host has looked at, never a header of its choosing.
const MEDIA_TYPES: ReadonlySet<ModuleGitHubMediaType> = new Set<ModuleGitHubMediaType>([
  'application/vnd.github+json',
  'application/vnd.github.raw+json',
  'application/vnd.github.text+json',
  'application/vnd.github.html+json',
  'application/vnd.github.full+json',
  'application/vnd.github.base64+json',
  'application/vnd.github.object+json',
  'application/vnd.github.raw',
  'application/vnd.github.diff',
  'application/vnd.github.patch',
  'application/vnd.github.sha',
])
// The response headers a module may read: enough to page, poll and back off.
const RESPONSE_HEADERS = new Set(['link', 'etag', 'retry-after'])
const RESPONSE_HEADER_PREFIX = 'x-ratelimit-'
// Where GitHub sends a log, archive or artifact download. Exact host or a
// `.suffix` that matches a subdomain.
const STORAGE_HOSTS = ['codeload.github.com', '.githubusercontent.com', '.blob.core.windows.net']
// An etag is a short quoted token; anything with a control character could
// split a header.
const ETAG_PATTERN = /^(?:W\/)?"[\x21\x23-\x7e]{0,200}"$/
const LOGIN_CACHE_MS = 5 * 60_000
const METHODS = new Set(['GET', 'POST', 'PATCH', 'PUT', 'DELETE'])
// Literal characters a GitHub REST path uses, plus `{` `}` for placeholders.
const TEMPLATE_PATTERN = /^\/[A-Za-z0-9\-._~/{}]*$/
const PLACEHOLDER_PATTERN = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g

function failure(code: Failure['code'], message: string, status?: number, headers?: Record<string, string>): Failure {
  return {
    ok: false,
    code,
    message,
    ...(status !== undefined ? { status } : {}),
    ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
  }
}

/** The allow-listed response headers a module may read, names lowercased. */
export function pickGitHubResponseHeaders(headers: Record<string, string>): Record<string, string> {
  const picked: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase()
    if (RESPONSE_HEADERS.has(lower) || lower.startsWith(RESPONSE_HEADER_PREFIX)) picked[lower] = value
  }
  return picked
}

/**
 * The operation kinds a GraphQL document defines, read with a small lexer
 * that skips strings, block strings and comments and looks only at top-level
 * tokens — so a field named `mutation` inside a selection, or the word in a
 * string argument, is not mistaken for one. Null for a document with no
 * selection at all. A top-level `mutation` or `subscription` anywhere is
 * reported, even as an operation's NAME: refusing the odd legal query is the
 * safe side of this check.
 */
export function graphqlTopLevelKeywords(query: string): string[] | null {
  const keywords: string[] = []
  let depth = 0
  let sawSelection = false
  let index = 0
  while (index < query.length) {
    const char = query[index]!
    if (char === '#') {
      while (index < query.length && query[index] !== '\n' && query[index] !== '\r') index += 1
      continue
    }
    if (query.startsWith('"""', index)) {
      index += 3
      while (index < query.length && !query.startsWith('"""', index)) {
        index += query.startsWith('\\"""', index) ? 4 : 1
      }
      index += 3
      continue
    }
    if (char === '"') {
      index += 1
      while (index < query.length && query[index] !== '"' && query[index] !== '\n') {
        index += query[index] === '\\' ? 2 : 1
      }
      index += 1
      continue
    }
    if (char === '{' || char === '(' || char === '[') {
      if (char === '{') sawSelection = true
      depth += 1
      index += 1
      continue
    }
    if (char === '}' || char === ')' || char === ']') {
      depth = Math.max(0, depth - 1)
      index += 1
      continue
    }
    if (/[_A-Za-z]/.test(char)) {
      const start = index
      while (index < query.length && /[_0-9A-Za-z]/.test(query[index]!)) index += 1
      if (depth === 0) keywords.push(query.slice(start, index))
      continue
    }
    index += 1
  }
  return sawSelection ? keywords : null
}

/** Whether a URL GitHub redirected to is one of its own storage hosts, over https on the default port. */
export function isGitHubStorageUrl(location: string): boolean {
  let url: URL
  try {
    url = new URL(location)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false
  const host = url.hostname.toLowerCase()
  return STORAGE_HOSTS.some((entry) => (entry.startsWith('.') ? host.endsWith(entry) : host === entry))
}

/**
 * The path a route template names once its placeholders are filled, plus the
 * parameters left over for the query string; or why the route is refused.
 */
export function buildGitHubPath(
  route: unknown,
  params: Record<string, string | number | boolean> = {},
): { ok: true; path: string; query: Array<[string, string]> } | { ok: false; message: string } {
  if (typeof route !== 'string' || !route.startsWith('/')) {
    return { ok: false, message: 'A route is a "/"-prefixed GitHub REST path such as "/repos/{owner}/{repo}".' }
  }
  if (route.startsWith('//') || route.includes('://') || !TEMPLATE_PATTERN.test(route)) {
    return {
      ok: false,
      message: 'A route may hold only path characters and {placeholders}; put query parameters in params.',
    }
  }
  const templateSegments = route.split('/').slice(1)
  if (
    templateSegments.some(
      (segment, index) =>
        segment === '.' || segment === '..' || (segment === '' && index < templateSegments.length - 1),
    )
  ) {
    return { ok: false, message: 'A route may not hold empty, "." or ".." segments.' }
  }
  if (typeof params !== 'object' || params === null) return { ok: false, message: 'params must be an object.' }

  const used = new Set<string>()
  let unfilled: string | null = null
  const path = route.replace(PLACEHOLDER_PATTERN, (_match, name: string) => {
    const value = Object.hasOwn(params, name) ? params[name] : undefined
    if (value === undefined || value === null || String(value) === '') {
      unfilled ??= name
      return ''
    }
    used.add(name)
    return encodeURIComponent(String(value))
  })
  if (unfilled !== null) return { ok: false, message: `The route's {${unfilled}} has no value in params.` }
  if (/[{}]/.test(path)) return { ok: false, message: 'A route placeholder is written {name}.' }
  // A value of "." or ".." encodes to itself and would climb the path.
  if (path.split('/').some((segment) => segment === '.' || segment === '..')) {
    return { ok: false, message: 'A route parameter may not be "." or "..".' }
  }

  const query: Array<[string, string]> = []
  for (const [name, value] of Object.entries(params)) {
    if (used.has(name) || value === undefined || value === null) continue
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      return { ok: false, message: `Parameter "${name}" must be a string, number or boolean.` }
    }
    query.push([name, String(value)])
  }
  return { ok: true, path, query }
}

export function createModuleGitHubRegistry(deps: ModuleGitHubDeps): ModuleGitHubModuleRegistry {
  const fetchImpl: BrokerFetch = deps.fetch ?? ((input, init) => fetch(input, init))
  const now = deps.now ?? (() => Date.now())
  // The login for the token in use, so `status` does not ask GitHub every
  // call. Keyed by the token itself (in memory only) so a sign-in as someone
  // else is never answered with the previous login.
  let loginCache: { token: string; login: string | null; at: number } | null = null

  function hasPermission(moduleId: string): boolean {
    return (deps.getModulePermissions(moduleId) ?? []).includes('github')
  }
  function missingMessage(moduleId: string): string {
    return `Module "${moduleId}" must declare the "github" permission.`
  }
  async function readToken(): Promise<string> {
    try {
      return (await deps.tokenStore.resolveToken()).trim()
    } catch {
      return ''
    }
  }

  function send(
    token: string,
    method: string,
    url: string,
    body: string | undefined,
    extra: {
      accept?: string
      ifNoneMatch?: string
      redirect?: 'error' | 'manual'
      bodyEncoding?: 'utf8' | 'base64'
    } = {},
  ) {
    const headers: Record<string, string> = {
      Accept: extra.accept ?? DEFAULT_ACCEPT,
      Authorization: `Bearer ${token}`,
      'User-Agent': 'SprintEngine-Studio',
      'X-GitHub-Api-Version': '2022-11-28',
    }
    if (extra.ifNoneMatch) headers['If-None-Match'] = extra.ifNoneMatch
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    return brokerRequest(
      fetchImpl,
      url,
      { method, headers, ...(body !== undefined ? { body } : {}) },
      {
        timeoutMs: GITHUB_TIMEOUT_MS,
        maxBytes: extra.bodyEncoding ? MODULE_GITHUB_DOWNLOAD_LIMIT_BYTES : MODULE_GITHUB_RESPONSE_LIMIT_BYTES,
        label: GITHUB_API_ORIGIN,
        ...(extra.redirect ? { redirect: extra.redirect } : {}),
        ...(extra.bodyEncoding ? { bodyEncoding: extra.bodyEncoding } : {}),
      },
    )
  }

  // The URL a route names on api.github.com, or why it is refused.
  function routeUrl(
    route: unknown,
    params: Record<string, string | number | boolean> | undefined,
  ): { ok: true; url: string } | Failure {
    const built = buildGitHubPath(route, params)
    if (!built.ok) return failure('invalid_route', built.message)
    const url = new URL(built.path, GITHUB_API_ORIGIN)
    for (const [name, value] of built.query) url.searchParams.append(name, value)
    // Belt and braces: whatever the template checks missed, the request
    // still goes to api.github.com and to exactly the path that was built.
    if (url.origin !== GITHUB_API_ORIGIN || url.pathname !== built.path) {
      return failure('invalid_route', 'The route does not name a GitHub REST path.')
    }
    return { ok: true, url: url.toString() }
  }

  function mediaType(accept: unknown): { ok: true; accept?: string } | Failure {
    if (accept === undefined) return { ok: true }
    if (typeof accept !== 'string' || !MEDIA_TYPES.has(accept as ModuleGitHubMediaType)) {
      return failure('invalid_route', `"${String(accept)}" is not one of the GitHub media types a request may ask for.`)
    }
    return { ok: true, accept }
  }

  // A GitHub answer as the module sees it: parsed, redacted, its headers
  // narrowed to the allow-list; a 304 is an answer, not an error.
  function answer(response: BrokerHttpResponse, token: string): ModuleGitHubResponse {
    const { status } = response
    const headers = pickGitHubResponseHeaders(response.headers)
    if (status === 304) return { ok: true, status, data: null, headers }
    const text = redactSecret(response.body, token)
    const data = parseBody(text, response.headers['content-type'])
    if (status < 200 || status >= 300) {
      const detail =
        typeof data === 'object' && data !== null && typeof (data as { message?: unknown }).message === 'string'
          ? (data as { message: string }).message.slice(0, 500)
          : null
      return failure(
        'http_error',
        detail ? `GitHub answered ${status}: ${detail}` : `GitHub answered ${status}.`,
        status,
        headers,
      )
    }
    return { ok: true, status, data, headers }
  }

  function forModule(moduleId: string): ModuleGitHubService {
    return {
      async request(request: ModuleGitHubRequest): Promise<ModuleGitHubResponse> {
        if (!hasPermission(moduleId)) return failure('permission_missing', missingMessage(moduleId))
        if (typeof request !== 'object' || request === null) {
          return failure('invalid_route', 'request needs a route.')
        }
        const method = (request.method ?? 'GET').toUpperCase()
        if (!METHODS.has(method))
          return failure('invalid_route', `Method "${request.method}" is not one GitHub's REST API takes.`)
        const target = routeUrl(request.route, request.params)
        if (!target.ok) return target
        const media = mediaType(request.accept)
        if (!media.ok) return media
        if (request.ifNoneMatch !== undefined) {
          if (typeof request.ifNoneMatch !== 'string' || !ETAG_PATTERN.test(request.ifNoneMatch)) {
            return failure(
              'invalid_route',
              "ifNoneMatch takes an etag exactly as an earlier answer's headers.etag carried it.",
            )
          }
        }

        let body: string | undefined
        if (request.body !== undefined) {
          if (method === 'GET') return failure('invalid_route', 'A GET request carries no body; use params.')
          try {
            body = JSON.stringify(request.body)
          } catch {
            return failure('invalid_route', 'The request body could not be sent as JSON.')
          }
        }

        const token = await readToken()
        if (!token) return failure('not_signed_in', 'Sign in to GitHub in Settings to let extensions use it.')

        const outcome = await send(token, method, target.url, body, {
          ...(media.accept ? { accept: media.accept } : {}),
          ...(request.ifNoneMatch ? { ifNoneMatch: request.ifNoneMatch } : {}),
        })
        if (!outcome.ok) return failure('network_error', outcome.message)
        return answer(outcome.response, token)
      },

      async graphql(query: string, variables?: Record<string, unknown>): Promise<ModuleGitHubResponse> {
        if (!hasPermission(moduleId)) return failure('permission_missing', missingMessage(moduleId))
        if (typeof query !== 'string' || query.trim() === '') {
          return failure('invalid_query', 'graphql needs a query document.')
        }
        const keywords = graphqlTopLevelKeywords(query)
        if (keywords === null) return failure('invalid_query', 'The document selects nothing.')
        const writes = keywords.filter((keyword) => keyword === 'mutation' || keyword === 'subscription')
        if (writes.length > 0) {
          return failure(
            'invalid_query',
            `graphql is read-only; a ${writes[0]} is refused. Use request() for a write, on an explicit action of the person's.`,
          )
        }
        if (
          variables !== undefined &&
          (typeof variables !== 'object' || variables === null || Array.isArray(variables))
        ) {
          return failure('invalid_query', 'variables must be an object.')
        }
        let body: string
        try {
          body = JSON.stringify(variables === undefined ? { query } : { query, variables })
        } catch {
          return failure('invalid_query', 'The variables could not be sent as JSON.')
        }
        const token = await readToken()
        if (!token) return failure('not_signed_in', 'Sign in to GitHub in Settings to let extensions use it.')
        const outcome = await send(token, 'POST', `${GITHUB_API_ORIGIN}/graphql`, body)
        if (!outcome.ok) return failure('network_error', outcome.message)
        return answer(outcome.response, token)
      },

      async download(request: ModuleGitHubDownloadRequest): Promise<ModuleGitHubDownloadResponse> {
        if (!hasPermission(moduleId)) return failure('permission_missing', missingMessage(moduleId))
        if (typeof request !== 'object' || request === null) {
          return failure('invalid_route', 'download needs a route.')
        }
        const target = routeUrl(request.route, request.params)
        if (!target.ok) return target
        const media = mediaType(request.accept)
        if (!media.ok) return media
        const encoding = request.encoding === 'base64' ? 'base64' : 'utf8'
        if (request.encoding !== undefined && request.encoding !== 'utf8' && request.encoding !== 'base64') {
          return failure('invalid_route', 'encoding is "utf8" or "base64".')
        }

        const token = await readToken()
        if (!token) return failure('not_signed_in', 'Sign in to GitHub in Settings to let extensions use it.')

        const first = await send(token, 'GET', target.url, undefined, {
          ...(media.accept ? { accept: media.accept } : {}),
          redirect: 'manual',
          bodyEncoding: encoding,
        })
        if (!first.ok) return failure('network_error', first.message)
        const { status } = first.response
        const headers = pickGitHubResponseHeaders(first.response.headers)
        if (status >= 200 && status < 300) {
          return {
            ok: true,
            status,
            data: encoding === 'utf8' ? redactSecret(first.response.body, token) : first.response.body,
            encoding,
            contentType: first.response.headers['content-type'] ?? null,
            headers,
          }
        }
        if (status < 300 || status >= 400) {
          const settled = answer({ ...first.response, body: encoding === 'utf8' ? first.response.body : '' }, token)
          return settled.ok ? failure('http_error', `GitHub answered ${status}.`, status, headers) : settled
        }

        const location = first.response.headers['location'] ?? ''
        if (!isGitHubStorageUrl(location)) {
          return failure(
            'redirect_not_allowed',
            'GitHub redirected the download somewhere other than its own storage, so the host did not follow it.',
            status,
          )
        }
        // The storage URL is pre-signed: it needs no credential, and must not
        // be handed one. Only the module's own media type travels with it.
        const second = await brokerRequest(
          fetchImpl,
          location,
          { method: 'GET', headers: { 'User-Agent': 'SprintEngine-Studio' } },
          {
            timeoutMs: GITHUB_DOWNLOAD_TIMEOUT_MS,
            maxBytes: MODULE_GITHUB_DOWNLOAD_LIMIT_BYTES,
            label: new URL(location).origin,
            bodyEncoding: encoding,
          },
        )
        if (!second.ok) return failure('network_error', second.message)
        if (second.response.status < 200 || second.response.status >= 300) {
          return failure(
            'http_error',
            `GitHub's storage answered ${second.response.status}.`,
            second.response.status,
            headers,
          )
        }
        return {
          ok: true,
          status: second.response.status,
          data: second.response.body,
          encoding,
          contentType: second.response.headers['content-type'] ?? null,
          headers,
        }
      },

      async status() {
        if (!hasPermission(moduleId)) throw new Error(missingMessage(moduleId))
        const token = await readToken()
        if (!token) return { signedIn: false }
        if (loginCache && loginCache.token === token && now() - loginCache.at < LOGIN_CACHE_MS) {
          return loginCache.login ? { signedIn: true, login: loginCache.login } : { signedIn: true }
        }
        const outcome = await send(token, 'GET', `${GITHUB_API_ORIGIN}/user`, undefined)
        if (!outcome.ok) return { signedIn: true }
        if (outcome.response.status === 401) {
          loginCache = null
          return { signedIn: false }
        }
        const user = parseBody(outcome.response.body, outcome.response.headers['content-type'])
        const login =
          outcome.response.status === 200 && typeof (user as { login?: unknown } | null)?.login === 'string'
            ? (user as { login: string }).login
            : null
        loginCache = { token, login, at: now() }
        return login ? { signedIn: true, login } : { signedIn: true }
      },
    }
  }

  const services = new Map<string, ModuleGitHubService>()
  const serviceFor = (moduleId: string): ModuleGitHubService => {
    let service = services.get(moduleId)
    if (!service) {
      service = forModule(moduleId)
      services.set(moduleId, service)
    }
    return service
  }

  const registry: ModuleGitHubRegistry = {
    request: (moduleId, request) => serviceFor(moduleId).request(request),
    graphql: (moduleId, query, variables) => serviceFor(moduleId).graphql(query, variables),
    download: (moduleId, request) => serviceFor(moduleId).download(request),
    status: (moduleId) => serviceFor(moduleId).status(),
  }

  return { forModule: serviceFor, registry }
}

function parseBody(text: string, contentType: string | undefined): unknown {
  if (text === '') return null
  if (contentType && !/json/i.test(contentType)) return text
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}
