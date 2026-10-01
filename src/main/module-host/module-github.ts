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

import type {
  ModuleGitHubRegistry,
  ModuleGitHubRequest,
  ModuleGitHubResponse,
  ModuleGitHubService,
} from '../../shared/modules/brokers'
import { brokerRequest, redactSecret, type BrokerFetch } from './broker-http'

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
const GITHUB_TIMEOUT_MS = 30_000
const LOGIN_CACHE_MS = 5 * 60_000
const METHODS = new Set(['GET', 'POST', 'PATCH', 'PUT', 'DELETE'])
// Literal characters a GitHub REST path uses, plus `{` `}` for placeholders.
const TEMPLATE_PATTERN = /^\/[A-Za-z0-9\-._~/{}]*$/
const PLACEHOLDER_PATTERN = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g

function failure(code: Failure['code'], message: string, status?: number): Failure {
  return { ok: false, code, message, ...(status !== undefined ? { status } : {}) }
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

  function send(token: string, method: string, url: string, body: string | undefined) {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'SprintEngine-Studio',
      'X-GitHub-Api-Version': '2022-11-28',
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    return brokerRequest(
      fetchImpl,
      url,
      { method, headers, ...(body !== undefined ? { body } : {}) },
      { timeoutMs: GITHUB_TIMEOUT_MS, maxBytes: MODULE_GITHUB_RESPONSE_LIMIT_BYTES, label: GITHUB_API_ORIGIN },
    )
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
        const built = buildGitHubPath(request.route, request.params)
        if (!built.ok) return failure('invalid_route', built.message)

        const url = new URL(built.path, GITHUB_API_ORIGIN)
        for (const [name, value] of built.query) url.searchParams.append(name, value)
        // Belt and braces: whatever the template checks missed, the request
        // still goes to api.github.com and to exactly the path that was built.
        if (url.origin !== GITHUB_API_ORIGIN || url.pathname !== built.path) {
          return failure('invalid_route', 'The route does not name a GitHub REST path.')
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

        const outcome = await send(token, method, url.toString(), body)
        if (!outcome.ok) return failure('network_error', outcome.message)
        const { status } = outcome.response
        const text = redactSecret(outcome.response.body, token)
        const data = parseBody(text, outcome.response.headers['content-type'])

        if (status < 200 || status >= 300) {
          const detail =
            typeof data === 'object' && data !== null && typeof (data as { message?: unknown }).message === 'string'
              ? (data as { message: string }).message.slice(0, 500)
              : null
          return failure(
            'http_error',
            detail ? `GitHub answered ${status}: ${detail}` : `GitHub answered ${status}.`,
            status,
          )
        }
        return { ok: true, status, data }
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
