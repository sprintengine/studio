import { normalizeIssueState } from '../../../shared/tracker/state-mapping'
import {
  TrackerProviderError,
  type NormalizedIssue,
  type TrackerCapabilities,
  type TrackerConnection,
  type TrackerConnectionProbe,
  type TrackerProvider,
} from '../../../shared/tracker/types'
import type { ProviderSecretValueResult } from '../../secret-store'

// GitHub tracker provider (MC-1634, plan §3.1). One REST v3 client covers
// github.com and GitHub Enterprise Server — the ONLY difference is the API base
// URL derived from the connection (github.com ⇒ https://api.github.com, GHES ⇒
// the connection's https://<host>/api/v3). No other code path branches on host.
//
// The normalization + pagination SHAPES are lifted from the dev-only Switchboard
// client (src/main/switchboard-github.ts githubIssueToImportItem / nextGitHubPageUrl)
// per the plan's "lift, don't import" rule; Switchboard stays untouched.
//
// Providers FETCH and NORMALIZE only — they never write backlog files (T6's job).

// The subset of the connection store a provider needs: connection metadata (for
// the base URL) and the per-connection secret. Never crosses IPC.
export type TrackerConnectionAccess = {
  getConnection(id: string): Promise<TrackerConnection | undefined>
  resolveSecret(id: string): Promise<ProviderSecretValueResult>
}

export type GitHubTrackerProviderOptions = {
  connections: TrackerConnectionAccess
  // Injectable for tests; defaults to the runtime's global fetch.
  fetchImpl?: typeof fetch
}

const GITHUB_COM_API_BASE = 'https://api.github.com'
const PAGE_SIZE = 100
// Safety cap for cursor-less multi-page collection (assigned-to-me, comments).
// GitHub search itself caps at 1000 results; this bounds unbounded following.
const MAX_PAGES = 20

// GitHub's raw issue/search-item shape. Every field is `unknown`-guarded because
// this is an untrusted external boundary.
type GitHubApiIssue = {
  number?: unknown
  title?: unknown
  body?: unknown
  html_url?: unknown
  state?: unknown
  labels?: unknown
  assignee?: unknown
  assignees?: unknown
  updated_at?: unknown
  pull_request?: unknown
  repository_url?: unknown // present on /search/issues items; the repo the issue belongs to
}

type GitHubApiComment = {
  body?: unknown
  user?: unknown
  created_at?: unknown
}

export const GITHUB_CAPABILITIES: TrackerCapabilities = {
  // v1 is read-only. Comment write-back is MC-1640 (T10), which implements the
  // POST and flips this on — matching the Linear provider's deferral. Shipping it
  // false keeps the capability honest: nothing wired here can post.
  canComment: false,
  // GitHub has no named workflow transitions — closing/reopening is not a
  // tracker-defined transition list, so tier-2 write-back never applies here.
  canTransition: false,
  // GitHub Enterprise Server.
  selfHostable: true,
}

export class GitHubTrackerProvider implements TrackerProvider {
  readonly provider = 'github' as const
  readonly capabilities = GITHUB_CAPABILITIES

  private readonly connections: TrackerConnectionAccess
  private readonly fetchImpl: typeof fetch

  constructor(options: GitHubTrackerProviderOptions) {
    this.connections = options.connections
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  async searchIssues(args: {
    connectionId: string
    query: string
    cursor?: string
  }): Promise<{ issues: NormalizedIssue[]; nextCursor?: string }> {
    const { connection, token } = await this.resolve(args.connectionId)
    const apiBase = apiBaseFor(connection)
    const url = args.cursor
      ? assertSameOrigin(args.cursor, apiBase, args.connectionId)
      : `${apiBase}/search/issues?q=${encodeURIComponent(withIssueFilter(args.query))}&per_page=${PAGE_SIZE}`

    const response = await this.githubFetch(url, token, args.connectionId)
    const records = extractSearchItems(await response.json())
    const includeSlug = distinctRepoCount(records) > 1
    const issues = records.map((record) => this.normalizeIssue(record, args.connectionId, { includeSlug, comments: [] }))
    const nextCursor = nextGitHubPageUrl(response.headers.get('link'))
    return nextCursor ? { issues, nextCursor } : { issues }
  }

  async fetchIssue(args: { connectionId: string; externalId: string }): Promise<NormalizedIssue> {
    const { connection, token } = await this.resolve(args.connectionId)
    const apiBase = apiBaseFor(connection)
    const ref = parseExternalId(args.externalId, args.connectionId)

    const issueUrl = `${apiBase}/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/issues/${ref.number}`
    const record = (await (await this.githubFetch(issueUrl, token, args.connectionId)).json()) as GitHubApiIssue
    if (record.pull_request) {
      throw new TrackerProviderError('not_found', 'That GitHub reference is a pull request, not an issue.', {
        provider: 'github',
        connectionId: args.connectionId,
      })
    }

    const comments = await this.fetchComments(apiBase, ref, token, args.connectionId)
    // A single fetched issue is unambiguous on its own, so it renders as `#123`.
    return this.normalizeIssue({ ...record, repository_url: `${apiBase}/repos/${ref.owner}/${ref.repo}` }, args.connectionId, {
      includeSlug: false,
      comments,
    })
  }

  async listAssignedToMe(args: { connectionId: string }): Promise<NormalizedIssue[]> {
    const { connection, token } = await this.resolve(args.connectionId)
    const apiBase = apiBaseFor(connection)

    const collected: GitHubApiIssue[] = []
    let url: string | null = `${apiBase}/search/issues?q=${encodeURIComponent('assignee:@me is:open is:issue')}&per_page=${PAGE_SIZE}`
    for (let page = 0; url && page < MAX_PAGES; page += 1) {
      const response = await this.githubFetch(url, token, args.connectionId)
      collected.push(...extractSearchItems(await response.json()))
      url = nextGitHubPageUrl(response.headers.get('link'))
    }
    const includeSlug = distinctRepoCount(collected) > 1
    return collected.map((record) => this.normalizeIssue(record, args.connectionId, { includeSlug, comments: [] }))
  }

  async postComment(): Promise<void> {
    // Read-only in v1; comment write-back is MC-1640 (T10). Rejecting here keeps
    // the read-only guarantee explicit rather than silently posting.
    throw new TrackerProviderError('unsupported', 'Posting comments to GitHub is not enabled yet.', {
      provider: 'github',
    })
  }

  async transitionIssue(): Promise<void> {
    throw new TrackerProviderError('unsupported', 'GitHub issues have no named workflow transitions.', {
      provider: 'github',
    })
  }

  async testConnection(args: { connectionId: string }): Promise<TrackerConnectionProbe> {
    try {
      const { connection, token } = await this.resolve(args.connectionId)
      const apiBase = apiBaseFor(connection)
      const record = (await (await this.githubFetch(`${apiBase}/user`, token, args.connectionId)).json()) as {
        login?: unknown
      }
      const login = typeof record.login === 'string' ? record.login : undefined
      return { ok: true, summary: login ? `Signed in as ${login}.` : 'Reached GitHub.' }
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : 'Could not reach GitHub.' }
    }
  }

  // --- internals ----------------------------------------------------------

  private async resolve(connectionId: string): Promise<{ connection: TrackerConnection; token?: string }> {
    const connection = await this.connections.getConnection(connectionId)
    if (!connection || connection.provider !== 'github') {
      throw new TrackerProviderError('not_configured', 'This GitHub connection no longer exists.', { connectionId })
    }
    const secret = await this.connections.resolveSecret(connectionId)
    // A PAT is optional for public github.com reads; for private repos and GHES
    // its absence surfaces honestly as GitHub's own 401/404 message.
    return { connection, token: secret.ok ? secret.value : undefined }
  }

  private async fetchComments(
    apiBase: string,
    ref: GitHubIssueRef,
    token: string | undefined,
    connectionId: string
  ): Promise<NormalizedIssue['comments']> {
    const comments: NormalizedIssue['comments'] = []
    let url: string | null = `${apiBase}/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/issues/${ref.number}/comments?per_page=${PAGE_SIZE}`
    for (let page = 0; url && page < MAX_PAGES; page += 1) {
      const response = await this.githubFetch(url, token, connectionId)
      const payload = await response.json()
      if (Array.isArray(payload)) {
        for (const raw of payload) comments.push(normalizeComment(raw as GitHubApiComment))
      }
      url = nextGitHubPageUrl(response.headers.get('link'))
    }
    return comments
  }

  private async githubFetch(url: string, token: string | undefined, connectionId: string): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'multicode-tracker',
      'X-GitHub-Api-Version': '2022-11-28',
    }
    if (token) headers.Authorization = `Bearer ${token}`

    let response: Response
    try {
      response = await this.fetchImpl(url, { headers })
    } catch (err) {
      throw new TrackerProviderError('network', err instanceof Error ? err.message : 'Could not reach GitHub.', {
        provider: 'github',
        connectionId,
      })
    }
    if (!response.ok) throw await toGitHubError(response, connectionId)
    return response
  }

  private normalizeIssue(
    record: GitHubApiIssue,
    connectionId: string,
    context: { includeSlug: boolean; comments: NormalizedIssue['comments'] }
  ): NormalizedIssue {
    const slug = repoSlugOf(record)
    const number = typeof record.number === 'number' ? record.number : 0
    const stateName = typeof record.state === 'string' ? record.state : 'open'
    const assignee = normalizeAssignee(record)
    const issue: NormalizedIssue = {
      provider: 'github',
      connectionId,
      // externalId is opaque to every downstream consumer; only this provider's
      // fetchIssue parses it, so it carries the full owner/repo/number needed for
      // the REST-by-number fetch across an org-scoped search.
      externalId: `${slug.owner}/${slug.repo}#${number}`,
      nativeKey: context.includeSlug ? `${slug.owner}/${slug.repo}#${number}` : `#${number}`,
      title: typeof record.title === 'string' ? record.title : '',
      bodyMarkdown: typeof record.body === 'string' ? record.body : '',
      state: normalizeIssueState({ provider: 'github', state: stateName, nativeName: stateName }),
      labels: extractLabels(record.labels),
      url: typeof record.html_url === 'string' ? record.html_url : '',
      comments: context.comments,
    }
    if (assignee) issue.assignee = assignee
    if (typeof record.updated_at === 'string') issue.updatedAt = record.updated_at
    return issue
  }
}

type GitHubIssueRef = { owner: string; repo: string; number: number }

// Parses `owner/repo#number` back into its parts for the REST fetch endpoints.
// Rejects a malformed id as not_found rather than firing a bad request.
function parseExternalId(externalId: string, connectionId: string): GitHubIssueRef {
  const match = externalId.match(/^([^/]+)\/([^#/]+)#(\d+)$/)
  if (!match) {
    throw new TrackerProviderError('not_found', 'Unrecognized GitHub issue reference.', {
      provider: 'github',
      connectionId,
    })
  }
  return { owner: match[1], repo: match[2], number: Number(match[3]) }
}

// github.com ⇒ https://api.github.com; GHES ⇒ the connection's .../api/v3 base.
// This is the ONLY host branch in the client.
function apiBaseFor(connection: TrackerConnection): string {
  const base = connection.baseUrl?.trim()
  return (base ? base : GITHUB_COM_API_BASE).replace(/\/+$/, '')
}

// Excludes pull requests at the API level; results are also filtered by the
// `pull_request` field so a PR never surfaces as an issue.
function withIssueFilter(query: string): string {
  const trimmed = query.trim()
  if (/(^|\s)is:issue(\s|$)/i.test(trimmed) || /(^|\s)type:issue(\s|$)/i.test(trimmed)) return trimmed
  return trimmed ? `${trimmed} is:issue` : 'is:issue'
}

// /search/issues returns { total_count, incomplete_results, items }. Pull
// requests are filtered out so they never surface as issues.
function extractSearchItems(payload: unknown): GitHubApiIssue[] {
  if (!payload || typeof payload !== 'object') return []
  const items = (payload as { items?: unknown }).items
  if (!Array.isArray(items)) return []
  return items.filter(isIssueRecord)
}

function isIssueRecord(record: unknown): record is GitHubApiIssue {
  if (!record || typeof record !== 'object') return false
  const issue = record as GitHubApiIssue
  return !issue.pull_request && typeof issue.number === 'number' && typeof issue.html_url === 'string'
}

function repoSlugOf(record: GitHubApiIssue): { owner: string; repo: string } {
  // repository_url is `https://<api-base>/repos/<owner>/<repo>`.
  if (typeof record.repository_url === 'string') {
    const parts = record.repository_url.split('/repos/')[1]
    if (parts) {
      const [owner, repo] = parts.split('/')
      if (owner && repo) return { owner, repo }
    }
  }
  // Fall back to the html_url (`https://<host>/<owner>/<repo>/issues/<n>`).
  if (typeof record.html_url === 'string') {
    const match = record.html_url.match(/^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/issues\//)
    if (match) return { owner: match[1], repo: match[2] }
  }
  return { owner: 'unknown', repo: 'unknown' }
}

function distinctRepoCount(records: GitHubApiIssue[]): number {
  const seen = new Set<string>()
  for (const record of records) {
    const slug = repoSlugOf(record)
    seen.add(`${slug.owner}/${slug.repo}`)
  }
  return seen.size
}

// Lifted shape from switchboard-github.ts: labels are strings or { name } objects.
function extractLabels(labels: unknown): string[] {
  if (!Array.isArray(labels)) return []
  return labels.flatMap((label): string[] => {
    if (typeof label === 'string') return [label]
    if (label && typeof label === 'object' && typeof (label as { name?: unknown }).name === 'string') {
      return [(label as { name: string }).name]
    }
    return []
  })
}

function normalizeAssignee(record: GitHubApiIssue): NormalizedIssue['assignee'] | undefined {
  const raw = pickAssignee(record)
  if (!raw) return undefined
  const login = typeof raw.login === 'string' ? raw.login : undefined
  const id = typeof raw.id === 'number' ? String(raw.id) : typeof raw.id === 'string' ? raw.id : undefined
  if (!login && !id) return undefined
  const assignee: NonNullable<NormalizedIssue['assignee']> = {}
  if (id) assignee.id = id
  if (login) assignee.displayName = login
  return assignee
}

function pickAssignee(record: GitHubApiIssue): { login?: unknown; id?: unknown } | undefined {
  if (record.assignee && typeof record.assignee === 'object') return record.assignee as { login?: unknown; id?: unknown }
  if (Array.isArray(record.assignees) && record.assignees[0] && typeof record.assignees[0] === 'object') {
    return record.assignees[0] as { login?: unknown; id?: unknown }
  }
  return undefined
}

function normalizeComment(raw: GitHubApiComment): NormalizedIssue['comments'][number] {
  const comment: NormalizedIssue['comments'][number] = {
    body: typeof raw.body === 'string' ? raw.body : '',
  }
  const author = raw.user && typeof raw.user === 'object' ? (raw.user as { login?: unknown }).login : undefined
  if (typeof author === 'string') comment.author = author
  if (typeof raw.created_at === 'string') comment.createdAt = raw.created_at
  return comment
}

// Parses the RFC 5988 Link header for the `next` page URL. Lifted verbatim in
// shape from switchboard-github.ts nextGitHubPageUrl. Works for both list and
// /search/issues pagination (both emit Link headers).
export function nextGitHubPageUrl(linkHeader: string | null): string | null {
  if (!linkHeader) return null
  for (const part of linkHeader.split(',')) {
    const match = part.trim().match(/^<([^>]+)>;\s*rel="([^"]+)"$/)
    if (match && match[2] === 'next') return match[1]
  }
  return null
}

// A pagination cursor is an opaque GitHub URL echoed back from the renderer. It
// is fetched with the connection's credential, so it MUST target the connection's
// own API host — otherwise a crafted cursor could exfiltrate the token to an
// arbitrary server.
function assertSameOrigin(cursor: string, apiBase: string, connectionId: string): string {
  let cursorUrl: URL
  try {
    cursorUrl = new URL(cursor)
  } catch {
    throw new TrackerProviderError('unknown', 'Rejected a malformed tracker pagination cursor.', {
      provider: 'github',
      connectionId,
    })
  }
  if (cursorUrl.origin !== new URL(apiBase).origin) {
    throw new TrackerProviderError('unknown', 'Rejected a tracker pagination cursor from an unexpected host.', {
      provider: 'github',
      connectionId,
    })
  }
  return cursor
}

// Maps a non-2xx GitHub response to a typed provider error, preserving GitHub's
// own message (never a stack trace). Rate-limit exhaustion (403 with the
// remaining budget at 0, or a 429) is distinguished from an auth rejection.
async function toGitHubError(response: Response, connectionId: string): Promise<TrackerProviderError> {
  const message = await readGitHubMessage(response)
  const status = response.status
  const rateLimited = status === 429 || (status === 403 && response.headers.get('x-ratelimit-remaining') === '0')

  const context = { provider: 'github' as const, connectionId }
  if (rateLimited) {
    const retryAfterSeconds = retryAfterFrom(response)
    return new TrackerProviderError('rate_limit', message ?? 'GitHub rate limit reached.', {
      ...context,
      ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
    })
  }
  if (status === 401 || status === 403) {
    return new TrackerProviderError('auth', message ?? 'GitHub rejected the credential.', context)
  }
  if (status === 404) {
    return new TrackerProviderError('not_found', message ?? 'Not found on GitHub.', context)
  }
  return new TrackerProviderError('unknown', message ?? `GitHub request failed with HTTP ${status}.`, context)
}

async function readGitHubMessage(response: Response): Promise<string | undefined> {
  try {
    const text = await response.text()
    if (!text) return undefined
    const parsed = JSON.parse(text) as { message?: unknown }
    return typeof parsed.message === 'string' ? parsed.message : undefined
  } catch {
    return undefined
  }
}

function retryAfterFrom(response: Response): number | undefined {
  const retryAfter = response.headers.get('retry-after')
  if (retryAfter) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds)
  }
  const reset = response.headers.get('x-ratelimit-reset')
  if (reset) {
    const resetEpoch = Number(reset)
    if (Number.isFinite(resetEpoch)) {
      const delta = resetEpoch - Math.floor(Date.now() / 1000)
      if (delta > 0) return delta
    }
  }
  return undefined
}
