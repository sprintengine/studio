// Tracker provider seam (MC-1633, plan §3.1–§3.3). Node-free shared contract
// imported by the main-process provider clients (T3 GitHub, T4 Jira, T5 Linear),
// the connection store, and the IPC/preload bridge. Providers FETCH and NORMALIZE
// only; they never write backlog files (that is the T6 writer's job).

export type TrackerProviderId = 'github' | 'jira' | 'linear'

// The credential shape a connection carries. One client per provider covers
// cloud + self-hosted; the only branch is the auth header / base URL:
//   github_pat  → GitHub PAT (github.com or GHES)
//   jira_basic  → Jira Cloud email + API token (Basic)
//   jira_pat    → Jira Data Center Bearer PAT
//   linear_key  → Linear API key (cloud-only)
export type TrackerAuthMode = 'github_pat' | 'jira_basic' | 'jira_pat' | 'linear_key'

// Drives the UI (T2/T11) and write-back gating (T10) — no hardcoded provider
// `if` downstream. `selfHostable` is false for Linear (cloud-only).
export type TrackerCapabilities = {
  canComment: boolean
  canTransition: boolean
  selfHostable: boolean
}

// Persisted connection metadata. NEVER carries a secret — the secret lives in the
// ProviderSecretStore keyed per connection id. `baseUrl === null` ⇒ Linear (no
// server address) or GitHub github.com default; a string ⇒ GHES / Jira site or
// server URL. `envVar`, when set, names an environment variable consulted as a
// fallback credential source (its value is a var NAME, not a secret).
export type TrackerConnection = {
  id: string
  provider: TrackerProviderId
  baseUrl: string | null
  authMode: TrackerAuthMode
  label: string
  envVar?: string | null
}

// The redaction boundary: what crosses to the renderer. Connection metadata plus
// a coarse status and its human-readable reason — never the secret itself.
export type TrackerConnectionStatus = 'connected' | 'expired' | 'unknown'

export type RedactedTrackerConnection = TrackerConnection & {
  status: TrackerConnectionStatus
  statusReason?: string
  // Present only when a provider client is registered for this connection's
  // provider; drives capability-gated UI without a hardcoded provider table.
  capabilities?: TrackerCapabilities
}

// Result of probing a connection. `reason` is the provider's own human-readable
// message (rate-limit / 401 / unreachable), never a stack trace. `kind` carries
// the structural failure class on a failed probe (so a rejected credential is
// classified 'expired', not the never-checked 'unknown' baseline); it is absent
// on success and on failures a provider could not classify.
export type TrackerConnectionProbe = { ok: boolean; reason?: string; summary?: string; kind?: TrackerErrorKind }

// A named workflow transition offered by the tracker (Jira/Linear), used by the
// MC-1640 tier-2 write-back UI. Never guessed — always read from the tracker.
export type TrackerTransition = { id: string; name: string }

// The normalized issue every downstream feature consumes. State is mapped by
// STRUCTURAL CATEGORY (statusCategory / state type / issue state), never by
// display name — see state-mapping.ts.
export type NormalizedIssue = {
  provider: TrackerProviderId
  connectionId: string
  externalId: string // stable provider id: Jira "10023", GH issue number, Linear uuid
  nativeKey: string // displayId verbatim: 'PROJ-17' | '#1234' | 'ENG-423'
  title: string
  bodyMarkdown: string // best-effort markdown
  rawBody?: string // lossless original (Jira wiki/ADF) when the markdown is lossy
  state: { category: 'open' | 'closed'; nativeName: string }
  priority?: string
  labels: string[]
  assignee?: { id?: string; displayName?: string }
  url: string
  comments: Array<{ author?: string; body: string; createdAt?: string }>
  updatedAt?: string
}

// The main-process client every provider implements. Capability-flagged methods
// (postComment / transitionIssue) exist on every provider but are gated by
// `capabilities`; a provider without the capability rejects the call.
export type TrackerProvider = {
  readonly provider: TrackerProviderId
  readonly capabilities: TrackerCapabilities
  searchIssues(args: {
    connectionId: string
    query: string
    cursor?: string
  }): Promise<{ issues: NormalizedIssue[]; nextCursor?: string }>
  fetchIssue(args: { connectionId: string; externalId: string }): Promise<NormalizedIssue>
  listAssignedToMe(args: { connectionId: string }): Promise<NormalizedIssue[]>
  postComment(args: { connectionId: string; externalId: string; body: string }): Promise<void>
  transitionIssue(args: { connectionId: string; externalId: string; transitionId: string }): Promise<void>
  listTransitions?(args: { connectionId: string; externalId: string }): Promise<TrackerTransition[]>
  testConnection(args: { connectionId: string }): Promise<TrackerConnectionProbe>
}

// ---------------------------------------------------------------------------
// Typed provider errors (plan §3.3). Providers throw a TrackerProviderError; the
// service catches it and normalizes to a TrackerError payload for IPC so the
// renderer sees the provider's message and a structural kind — never a stack.
// ---------------------------------------------------------------------------

export type TrackerErrorKind =
  | 'auth' // 401/403: bad or expired credential
  | 'rate_limit' // 429
  | 'not_found' // issue/connection missing
  | 'network' // unreachable / timeout
  | 'not_configured' // no connection or no client for this provider
  | 'unsupported' // capability not offered by this provider
  | 'unknown'

export type TrackerError = {
  kind: TrackerErrorKind
  message: string
  provider?: TrackerProviderId
  connectionId?: string
  retryAfterSeconds?: number
}

export class TrackerProviderError extends Error {
  readonly kind: TrackerErrorKind
  readonly provider?: TrackerProviderId
  readonly connectionId?: string
  readonly retryAfterSeconds?: number

  constructor(
    kind: TrackerErrorKind,
    message: string,
    context: { provider?: TrackerProviderId; connectionId?: string; retryAfterSeconds?: number } = {}
  ) {
    super(message)
    this.name = 'TrackerProviderError'
    this.kind = kind
    this.provider = context.provider
    this.connectionId = context.connectionId
    this.retryAfterSeconds = context.retryAfterSeconds
  }
}

// Normalizes any thrown value into the redacted TrackerError payload. A
// TrackerProviderError passes its structural kind through; anything else is an
// opaque 'unknown' carrying only its message (never a stack trace).
export function toTrackerError(
  err: unknown,
  context: { provider?: TrackerProviderId; connectionId?: string } = {}
): TrackerError {
  if (err instanceof TrackerProviderError) {
    return {
      kind: err.kind,
      message: err.message,
      provider: err.provider ?? context.provider,
      connectionId: err.connectionId ?? context.connectionId,
      retryAfterSeconds: err.retryAfterSeconds,
    }
  }
  return {
    kind: 'unknown',
    message: err instanceof Error ? err.message : 'Unexpected tracker error.',
    provider: context.provider,
    connectionId: context.connectionId,
  }
}

// ---------------------------------------------------------------------------
// IPC input / result contracts (plan §3.3). All node-free so the preload bridge
// and ElectronApi typing import them directly.
// ---------------------------------------------------------------------------

export type TrackerListConnectionsResult =
  | { ok: true; connections: RedactedTrackerConnection[] }
  | { ok: false; error: TrackerError }

// The secret is write-only: it flows IN on add and is never returned.
export type TrackerAddConnectionInput = {
  provider: TrackerProviderId
  baseUrl: string | null
  authMode: TrackerAuthMode
  label: string
  envVar?: string | null
  secret?: string
}

export type TrackerAddConnectionResult =
  | { ok: true; connection: RedactedTrackerConnection }
  | { ok: false; error: TrackerError }

export type TrackerRemoveConnectionInput = { connectionId: string }

export type TrackerRemoveConnectionResult = { ok: true } | { ok: false; error: TrackerError }

// A draft carries the transient secret so the settings form (T2) can test a
// connection before saving it; the draft secret is held in memory only and never
// touches disk.
export type TrackerConnectionDraft = {
  provider: TrackerProviderId
  baseUrl: string | null
  authMode: TrackerAuthMode
  label: string
  envVar?: string | null
  secret?: string
}

export type TrackerTestConnectionInput = { connectionId: string } | { draft: TrackerConnectionDraft }

export type TrackerTestConnectionResult =
  | { ok: true; probe: TrackerConnectionProbe }
  | { ok: false; error: TrackerError }

export type TrackerSearchInput = { connectionId: string; query: string; cursor?: string }

export type TrackerSearchResult =
  | { ok: true; issues: NormalizedIssue[]; nextCursor?: string }
  | { ok: false; error: TrackerError }

export type TrackerFetchIssueInput = { connectionId: string; externalId: string }

export type TrackerFetchIssueResult =
  | { ok: true; issue: NormalizedIssue }
  | { ok: false; error: TrackerError }
