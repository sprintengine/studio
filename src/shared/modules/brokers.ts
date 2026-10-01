// Brokered credentials for modules: the host uses a secret on a module's behalf
// so the module never holds it. The SDK mirrors these shapes by hand and the
// drift guard pins the two together.

// ── Secrets (permission `secrets`) ───────────────────────────────────────────

export type ModuleSecretsError =
  'permission_missing' | 'invalid_name' | 'not_set' | 'origin_not_allowed' | 'network_error' | 'storage_unavailable'

export type ModuleSecretFetchInit = {
  method?: string
  headers?: Record<string, string>
  body?: string
  placement: { header: string; scheme?: 'Bearer' | 'token' | 'Basic' | '' } | { query: string }
  timeoutMs?: number
}

export type ModuleSecretFetchResult =
  | { ok: true; status: number; headers: Record<string, string>; body: string }
  | { ok: false; code: ModuleSecretsError; message: string }

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

// What the host provides under 'module-secrets.module-service': the published
// service with the calling module's id first, which the SDK helper closes over.
export type ModuleSecretsRegistry = {
  [K in keyof ModuleSecretsService]: (
    moduleId: string,
    ...args: Parameters<ModuleSecretsService[K]>
  ) => ReturnType<ModuleSecretsService[K]>
}

// ── GitHub (permission `github`) ─────────────────────────────────────────────

export type ModuleGitHubRequest = {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
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

export type ModuleGitHubService = {
  request(request: ModuleGitHubRequest): Promise<ModuleGitHubResponse>
  status(): Promise<{ signedIn: boolean; login?: string }>
}

// Provided under 'github.module-service', moduleId first like the secrets registry.
export type ModuleGitHubRegistry = {
  [K in keyof ModuleGitHubService]: (
    moduleId: string,
    ...args: Parameters<ModuleGitHubService[K]>
  ) => ReturnType<ModuleGitHubService[K]>
}
