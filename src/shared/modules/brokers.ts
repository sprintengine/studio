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

/** The media types a request may ask GitHub for (`accept`); anything else is refused. */
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
  route: `/${string}`
  params?: Record<string, string | number | boolean>
  body?: unknown
  /** An `etag` from an earlier answer: GitHub answers 304 (not counted against the rate limit) when nothing changed. */
  ifNoneMatch?: string
  /** One of GitHub's own media types, e.g. `application/vnd.github.diff`. */
  accept?: ModuleGitHubMediaType
}

export type ModuleGitHubErrorCode =
  | 'permission_missing'
  | 'not_signed_in'
  | 'invalid_route'
  | 'invalid_query'
  | 'redirect_not_allowed'
  | 'http_error'
  | 'network_error'

/**
 * `headers` carries only `x-ratelimit-*`, `link`, `etag` and `retry-after`,
 * lowercased. A 304 (an `ifNoneMatch` that still matches) is ok with `data: null`.
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

export type ModuleGitHubService = {
  request(request: ModuleGitHubRequest): Promise<ModuleGitHubResponse>
  /**
   * A read-only GraphQL query. A document holding a `mutation` or
   * `subscription` operation is refused (`invalid_query`); `data` is GitHub's
   * whole answer, `{ data, errors? }`.
   */
  graphql(query: string, variables?: Record<string, unknown>): Promise<ModuleGitHubResponse>
  /**
   * A GET whose answer is a redirect to GitHub's own storage (job logs,
   * archives): the host follows it to an allow-listed GitHub storage host with
   * the token stripped.
   */
  download(request: ModuleGitHubDownloadRequest): Promise<ModuleGitHubDownloadResponse>
  status(): Promise<{ signedIn: boolean; login?: string }>
}

// Provided under 'github.module-service', moduleId first like the secrets registry.
export type ModuleGitHubRegistry = {
  [K in keyof ModuleGitHubService]: (
    moduleId: string,
    ...args: Parameters<ModuleGitHubService[K]>
  ) => ReturnType<ModuleGitHubService[K]>
}
