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

export type ModuleGitHubRequest = {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  /** An API route relative to the GitHub API root, e.g. `/repos/acme/app/pulls`. */
  route: `/${string}`
  params?: Record<string, string | number | boolean>
  body?: unknown
}

export type ModuleGitHubResponse =
  | { ok: true; status: number; data: unknown }
  | {
      ok: false
      code: 'permission_missing' | 'not_signed_in' | 'invalid_route' | 'http_error' | 'network_error'
      status?: number
      message: string
    }

/**
 * The GitHub API with the user's sign-in, for a module's `entry.main`,
 * obtained via `getGitHubService(host)`. The host attaches the token; the
 * module never sees it. Declare the `github` permission.
 */
export type ModuleGitHubService = {
  request(request: ModuleGitHubRequest): Promise<ModuleGitHubResponse>
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
    status: () => registry.status(moduleId),
  }
}
