// Brokered credentials: services that use a secret on a module's behalf so the
// module never holds it. A module stores an API key and names the origins it
// may be sent to, or calls the GitHub API with the user's sign-in; neither the
// key nor the token is ever handed back to module code.

import type { MainHost, ServiceToken } from './index.js'

// ── Secrets ──────────────────────────────────────────────────────────────────

export type ModuleSecretsError =
  'permission_missing' | 'invalid_name' | 'not_set' | 'origin_not_allowed' | 'network_error' | 'storage_unavailable'

export type ModuleSecretFetchInit = {
  method?: string
  headers?: Record<string, string>
  body?: string
  /** Where the host puts the secret: a header (with an optional scheme prefix) or a query parameter. */
  placement: { header: string; scheme?: 'Bearer' | 'token' | 'Basic' | '' } | { query: string }
  timeoutMs?: number
}

export type ModuleSecretFetchResult =
  | { ok: true; status: number; headers: Record<string, string>; body: string }
  | { ok: false; code: ModuleSecretsError; message: string }

/**
 * Secrets for a module's `entry.main`, obtained via `getSecretsService(host)`
 * and scoped to that module. A stored value can only leave the host inside a
 * `fetchWithSecret` request to one of the origins it was stored with. Declare
 * the `secrets` permission.
 */
export type ModuleSecretsService = {
  set(
    name: string,
    value: string,
    options: { allowedOrigins: string[] },
  ): Promise<{ ok: true } | { ok: false; code: ModuleSecretsError; message: string }>
  has(name: string): Promise<boolean>
  delete(name: string): Promise<{ ok: true } | { ok: false; code: ModuleSecretsError; message: string }>
  fetchWithSecret(name: string, url: string, init: ModuleSecretFetchInit): Promise<ModuleSecretFetchResult>
}

// The moduleId-first registries the app provides; derived from the published
// services so the two shapes cannot drift.
type ModuleSecretsRegistry = {
  [K in keyof ModuleSecretsService]: (
    moduleId: string,
    ...args: Parameters<ModuleSecretsService[K]>
  ) => ReturnType<ModuleSecretsService[K]>
}

// Literals rather than createServiceToken: index.ts re-exports this file, and
// a value import back into it would be a cycle for nothing (a token is its key).
const secretsModuleServiceToken: ServiceToken<ModuleSecretsRegistry> = { key: 'module-secrets.module-service' }

/** The scoped secrets service for `host`'s module; closes over `host.moduleId` like `getModuleStorage`. */
export function getSecretsService(host: MainHost): ModuleSecretsService {
  const registry = host.requireService(secretsModuleServiceToken)
  const moduleId = host.moduleId
  return {
    set: (name, value, options) => registry.set(moduleId, name, value, options),
    has: (name) => registry.has(moduleId, name),
    delete: (name) => registry.delete(moduleId, name),
    fetchWithSecret: (name, url, init) => registry.fetchWithSecret(moduleId, name, url, init),
  }
}

// ── GitHub ───────────────────────────────────────────────────────────────────

/**
 * The media types a request may ask GitHub for (`accept`). Anything else is
 * refused (`invalid_route`), so a module cannot ask for a preview format the
 * host has not looked at.
 */
export type ModuleGitHubMediaType =
  | 'application/vnd.github+json'
  | 'application/vnd.github.raw+json'
  | 'application/vnd.github.text+json'
  | 'application/vnd.github.html+json'
  | 'application/vnd.github.full+json'
  | 'application/vnd.github.base64+json'
  | 'application/vnd.github.object+json'
  | 'application/vnd.github.raw'
  | 'application/vnd.github.diff'
  | 'application/vnd.github.patch'
  | 'application/vnd.github.sha'

export type ModuleGitHubRequest = {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  /** An API route relative to the GitHub API root, e.g. `/repos/acme/app/pulls`. */
  route: `/${string}`
  params?: Record<string, string | number | boolean>
  body?: unknown
  /**
   * An `etag` from an earlier answer's `headers`. GitHub answers 304 — which
   * does not count against the rate limit — when nothing changed, and the
   * broker hands that back as `{ ok: true, status: 304, data: null }`.
   * Check `host.supports('github-headers')` first.
   */
  ifNoneMatch?: string
  /** One of GitHub's own media types, e.g. `application/vnd.github.diff` for a pull request's diff. */
  accept?: ModuleGitHubMediaType
}

export type ModuleGitHubErrorCode =
  | 'permission_missing'
  | 'not_signed_in'
  | 'invalid_route'
  // `graphql` was handed a document holding a mutation or subscription, or no query at all.
  | 'invalid_query'
  // `download` was redirected somewhere other than GitHub's own storage.
  | 'redirect_not_allowed'
  | 'http_error'
  | 'network_error'

/**
 * `headers` carries only the ones a client needs to behave — `x-ratelimit-*`,
 * `link` (pagination), `etag` (for `ifNoneMatch`) and `retry-after` — with
 * lowercased names. A host older than `supports('github-headers')` omits it.
 */
export type ModuleGitHubResponse =
  | { ok: true; status: number; data: unknown; headers: Record<string, string> }
  | {
      ok: false
      code: ModuleGitHubErrorCode
      status?: number
      message: string
      /** The same allow-listed headers, on an `http_error` (a 403 or 429 carries `retry-after`). */
      headers?: Record<string, string>
    }

export type ModuleGitHubDownloadRequest = {
  /** A GET route whose answer is a redirect to GitHub's storage, e.g. `/repos/{owner}/{repo}/actions/jobs/{job_id}/logs`. */
  route: `/${string}`
  params?: Record<string, string | number | boolean>
  accept?: ModuleGitHubMediaType
  /** `utf8` (the default) for logs and text; `base64` for an archive or other bytes. */
  encoding?: 'utf8' | 'base64'
}

export type ModuleGitHubDownloadResponse =
  | {
      ok: true
      status: number
      data: string
      encoding: 'utf8' | 'base64'
      contentType: string | null
      headers: Record<string, string>
    }
  | Extract<ModuleGitHubResponse, { ok: false }>

/**
 * The GitHub API with the user's sign-in, for a module's `entry.main`,
 * obtained via `getGitHubService(host)`. The host attaches the token; the
 * module never sees it. Declare the `github` permission.
 */
export type ModuleGitHubService = {
  request(request: ModuleGitHubRequest): Promise<ModuleGitHubResponse>
  /**
   * A READ-ONLY GraphQL query against `https://api.github.com/graphql`. It is
   * sent as a POST, but it is a read: a document holding a `mutation` or
   * `subscription` operation is refused (`invalid_query`) before it is sent,
   * so treat it like a GET. `data` is GitHub's whole answer, `{ data, errors? }`
   * — GraphQL reports most failures inside a 200, so check `errors`.
   * Check `host.supports('github-graphql')` first.
   */
  graphql(query: string, variables?: Record<string, unknown>): Promise<ModuleGitHubResponse>
  /**
   * A GET whose answer is a redirect to GitHub's own storage — a job's logs, a
   * repository archive, an Actions artifact. The host follows that one
   * redirect only to a GitHub storage host (`*.githubusercontent.com`,
   * `*.blob.core.windows.net`, `codeload.github.com`), with the token
   * stripped before it follows, and answers the body as text or base64
   * (capped like every answer). A route that answers directly is returned as
   * is. Check `host.supports('github-download')` first.
   */
  download(request: ModuleGitHubDownloadRequest): Promise<ModuleGitHubDownloadResponse>
  status(): Promise<{ signedIn: boolean; login?: string }>
}

type ModuleGitHubRegistry = {
  [K in keyof ModuleGitHubService]: (
    moduleId: string,
    ...args: Parameters<ModuleGitHubService[K]>
  ) => ReturnType<ModuleGitHubService[K]>
}

const gitHubModuleServiceToken: ServiceToken<ModuleGitHubRegistry> = { key: 'github.module-service' }

/** The scoped GitHub service for `host`'s module; closes over `host.moduleId` like `getModuleStorage`. */
export function getGitHubService(host: MainHost): ModuleGitHubService {
  const registry = host.requireService(gitHubModuleServiceToken)
  const moduleId = host.moduleId
  return {
    request: (request) => registry.request(moduleId, request),
    graphql: (query, variables) => registry.graphql(moduleId, query, variables),
    download: (request) => registry.download(moduleId, request),
    status: () => registry.status(moduleId),
  }
}
