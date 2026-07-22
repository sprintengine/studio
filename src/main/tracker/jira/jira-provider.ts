import { JIRA_API_BASE, jiraFetch } from './jira-http'
import { assignedToMeJql, freeTextSearchJql } from './jira-jql'
import { normalizeJiraIssue, type JiraIssueRecord } from './jira-normalize'
import type { ProviderSecretValueResult } from '../../secret-store'
import {
  TrackerProviderError,
  type NormalizedIssue,
  type TrackerCapabilities,
  type TrackerConnection,
  type TrackerConnectionProbe,
  type TrackerProvider,
  type TrackerTransition,
} from '../../../shared/tracker/types'

// The Jira TrackerProvider (MC-1635). ONE client serves Jira Cloud and Data
// Center. Issue, comment, and transition endpoints are identical REST v2 on both;
// the auth header (jira-http.ts) is the only difference there. SEARCH is the
// exception: Atlassian retired the offset-paged GET /rest/api/2/search on Cloud in
// favor of the token-paged GET /rest/api/3/search/jql (no `total`), so Cloud
// (`jira_basic`) branches onto that endpoint while Data Center keeps v2. This
// class fetches and normalizes only — it never writes backlog files (T6's job).

// The retired-on-Cloud replacement search endpoint: token-paged, returns
// `nextPageToken` (and `isLast`) instead of `startAt`/`total`.
const JIRA_CLOUD_SEARCH_PATH = '/rest/api/3/search/jql'

// The connection-store slice the provider needs: connection metadata + the
// per-connection secret. TrackerConnectionStore satisfies this; injectable so
// tests drive the provider without Electron.
export type JiraConnectionAccess = {
  getConnection(id: string): Promise<TrackerConnection | undefined>
  resolveSecret(id: string): Promise<ProviderSecretValueResult>
}

export type JiraProviderDeps = {
  connections: JiraConnectionAccess
  fetchImpl?: typeof fetch
}

// Search and list rows never render the comment thread, so they request a lean
// field set — pulling every issue's full comments into a search response would be
// an unbounded read. Only fetchIssue adds `comment` to return the thread inline.
const SEARCH_FIELDS = 'summary,description,status,priority,labels,assignee,updated'
const ISSUE_FIELDS = `${SEARCH_FIELDS},comment`
const SEARCH_PAGE_SIZE = 50
// Hard ceiling on listAssignedToMe pagination so a misconfigured filter can never
// drive an unbounded fetch loop.
const MAX_ASSIGNED_PAGES = 20

export class JiraTrackerProvider implements TrackerProvider {
  readonly provider = 'jira' as const
  readonly capabilities: TrackerCapabilities = { canComment: true, canTransition: true, selfHostable: true }

  private readonly connections: JiraConnectionAccess
  private readonly fetchImpl: typeof fetch

  constructor(deps: JiraProviderDeps) {
    this.connections = deps.connections
    this.fetchImpl = deps.fetchImpl ?? fetch
  }

  async searchIssues(args: {
    connectionId: string
    query: string
    cursor?: string
  }): Promise<{ issues: NormalizedIssue[]; nextCursor?: string }> {
    const { connection, secret } = await this.resolve(args.connectionId)
    const jql = freeTextSearchJql(args.query)

    if (isCloudConnection(connection)) {
      // Cloud: token pagination — the cursor is the opaque nextPageToken.
      const page = await this.searchPageCloud(connection, secret, jql, args.cursor, SEARCH_PAGE_SIZE)
      return {
        issues: page.issues.map((record) => normalizeJiraIssue(record, connection)),
        ...(page.nextPageToken ? { nextCursor: page.nextPageToken } : {}),
      }
    }

    // Data Center: offset pagination against v2 `total`.
    const startAt = parseCursor(args.cursor)
    const page = await this.searchPageDataCenter(connection, secret, jql, startAt, SEARCH_PAGE_SIZE)
    const nextStart = startAt + page.issues.length
    // Omit the cursor on an empty page: a permission-filtered page can return 0
    // issues while startAt < total, and advancing by 0 would hand back the SAME
    // cursor — "Load more" would then repeat the identical request forever.
    const hasMore = page.issues.length > 0 && nextStart < page.total
    return {
      issues: page.issues.map((record) => normalizeJiraIssue(record, connection)),
      ...(hasMore ? { nextCursor: String(nextStart) } : {}),
    }
  }

  async fetchIssue(args: { connectionId: string; externalId: string }): Promise<NormalizedIssue> {
    const { connection, secret } = await this.resolve(args.connectionId)
    const record = (await jiraFetch(
      {
        connection,
        secret,
        path: `${JIRA_API_BASE}/issue/${encodeURIComponent(args.externalId)}`,
        query: { fields: ISSUE_FIELDS },
      },
      this.fetchImpl
    )) as JiraIssueRecord
    return normalizeJiraIssue(record, connection)
  }

  async listAssignedToMe(args: { connectionId: string }): Promise<NormalizedIssue[]> {
    const { connection, secret } = await this.resolve(args.connectionId)
    const jql = assignedToMeJql()
    const collected: NormalizedIssue[] = []

    if (isCloudConnection(connection)) {
      let pageToken: string | undefined
      for (let pageIndex = 0; pageIndex < MAX_ASSIGNED_PAGES; pageIndex += 1) {
        const page = await this.searchPageCloud(connection, secret, jql, pageToken, SEARCH_PAGE_SIZE)
        collected.push(...page.issues.map((record) => normalizeJiraIssue(record, connection)))
        if (page.issues.length === 0 || !page.nextPageToken) break
        pageToken = page.nextPageToken
      }
      return collected
    }

    let startAt = 0
    for (let pageIndex = 0; pageIndex < MAX_ASSIGNED_PAGES; pageIndex += 1) {
      const page = await this.searchPageDataCenter(connection, secret, jql, startAt, SEARCH_PAGE_SIZE)
      collected.push(...page.issues.map((record) => normalizeJiraIssue(record, connection)))
      startAt += page.issues.length
      if (page.issues.length === 0 || startAt >= page.total) break
    }
    return collected
  }

  async postComment(args: { connectionId: string; externalId: string; body: string }): Promise<void> {
    const { connection, secret } = await this.resolve(args.connectionId)
    await jiraFetch(
      {
        connection,
        secret,
        method: 'POST',
        path: `${JIRA_API_BASE}/issue/${encodeURIComponent(args.externalId)}/comment`,
        // The v2 comment endpoint renders WIKI MARKUP, so posting the write-back
        // bodies' markdown verbatim would show literal `**` and `- `. Convert to
        // wiki markup first (the inverse of jira-markup.ts's read path).
        body: { body: markdownToJiraWiki(args.body) },
      },
      this.fetchImpl
    )
  }

  async transitionIssue(args: { connectionId: string; externalId: string; transitionId: string }): Promise<void> {
    const { connection, secret } = await this.resolve(args.connectionId)
    await jiraFetch(
      {
        connection,
        secret,
        method: 'POST',
        path: `${JIRA_API_BASE}/issue/${encodeURIComponent(args.externalId)}/transitions`,
        body: { transition: { id: args.transitionId } },
      },
      this.fetchImpl
    )
  }

  async listTransitions(args: { connectionId: string; externalId: string }): Promise<TrackerTransition[]> {
    const { connection, secret } = await this.resolve(args.connectionId)
    const result = (await jiraFetch(
      {
        connection,
        secret,
        path: `${JIRA_API_BASE}/issue/${encodeURIComponent(args.externalId)}/transitions`,
      },
      this.fetchImpl
    )) as { transitions?: unknown }
    if (!Array.isArray(result.transitions)) return []
    return result.transitions.flatMap((entry): TrackerTransition[] => {
      const t = entry as { id?: unknown; name?: unknown }
      return typeof t.id === 'string' && typeof t.name === 'string' ? [{ id: t.id, name: t.name }] : []
    })
  }

  async testConnection(args: { connectionId: string }): Promise<TrackerConnectionProbe> {
    try {
      const { connection, secret } = await this.resolve(args.connectionId)
      const me = (await jiraFetch(
        { connection, secret, path: `${JIRA_API_BASE}/myself` },
        this.fetchImpl
      )) as { displayName?: unknown }
      const who = typeof me.displayName === 'string' ? me.displayName : undefined
      return { ok: true, summary: who ? `Connected as ${who}.` : 'Connected.' }
    } catch (err) {
      return {
        ok: false,
        reason: err instanceof Error ? err.message : 'Could not reach Jira.',
        ...(err instanceof TrackerProviderError ? { kind: err.kind } : {}),
      }
    }
  }

  // Data Center / v2 search: offset-paged with a `total` the caller advances
  // against. Kept for self-hosted Jira, where the v2 search endpoint is live.
  private async searchPageDataCenter(
    connection: TrackerConnection,
    secret: string,
    jql: string,
    startAt: number,
    maxResults: number
  ): Promise<{ issues: JiraIssueRecord[]; total: number }> {
    const result = (await jiraFetch(
      {
        connection,
        secret,
        path: `${JIRA_API_BASE}/search`,
        query: { jql, startAt, maxResults, fields: SEARCH_FIELDS },
      },
      this.fetchImpl
    )) as { issues?: unknown; total?: unknown }
    const issues = Array.isArray(result.issues) ? (result.issues as JiraIssueRecord[]) : []
    const total = typeof result.total === 'number' ? result.total : issues.length
    return { issues, total }
  }

  // Cloud / v3 search: token-paged. The response carries `nextPageToken` until the
  // last page (also signaled by `isLast`); there is no `total`, so the caller
  // stops when no token comes back rather than comparing an offset to a count.
  private async searchPageCloud(
    connection: TrackerConnection,
    secret: string,
    jql: string,
    pageToken: string | undefined,
    maxResults: number
  ): Promise<{ issues: JiraIssueRecord[]; nextPageToken?: string }> {
    const result = (await jiraFetch(
      {
        connection,
        secret,
        path: JIRA_CLOUD_SEARCH_PATH,
        query: { jql, maxResults, fields: SEARCH_FIELDS, ...(pageToken ? { nextPageToken: pageToken } : {}) },
      },
      this.fetchImpl
    )) as { issues?: unknown; nextPageToken?: unknown; isLast?: unknown }
    const issues = Array.isArray(result.issues) ? (result.issues as JiraIssueRecord[]) : []
    const nextPageToken =
      result.isLast !== true && typeof result.nextPageToken === 'string' && result.nextPageToken
        ? result.nextPageToken
        : undefined
    return { issues, ...(nextPageToken ? { nextPageToken } : {}) }
  }

  // Resolves connection metadata + secret, or throws a typed error the service
  // relays to the renderer. A missing connection is `not_configured`; a missing
  // credential is `auth` (a configured connection with no usable secret).
  private async resolve(connectionId: string): Promise<{ connection: TrackerConnection; secret: string }> {
    const connection = await this.connections.getConnection(connectionId)
    if (!connection) {
      throw new TrackerProviderError('not_configured', 'This tracker connection no longer exists.', {
        provider: 'jira',
        connectionId,
      })
    }
    if (connection.provider !== 'jira') {
      throw new TrackerProviderError('not_configured', 'This connection is not a Jira connection.', {
        provider: 'jira',
        connectionId,
      })
    }
    const secret = await this.connections.resolveSecret(connectionId)
    if (!secret.ok) {
      throw new TrackerProviderError('auth', 'No credential is configured for this Jira connection.', {
        provider: 'jira',
        connectionId,
      })
    }
    return { connection, secret: secret.value }
  }
}

function parseCursor(cursor: string | undefined): number {
  if (!cursor) return 0
  const parsed = Number(cursor)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0
}

// Cloud is the Basic (email + API token) auth mode; Data Center is the Bearer PAT.
// This is the only place search branches Cloud vs self-hosted.
function isCloudConnection(connection: TrackerConnection): boolean {
  return connection.authMode === 'jira_basic'
}

// Converts the small markdown subset the write-back comment bodies use into Jira
// wiki markup, so a posted comment renders correctly on the v2 comment endpoint
// instead of showing literal `**` and `- ` (the inverse of jira-markup.ts's read
// path). Deliberately narrow: bold, bullet lines, and inline links — the shapes
// the composed messages actually emit; everything else passes through verbatim.
export function markdownToJiraWiki(markdown: string): string {
  return markdown
    .split('\n')
    .map(convertMarkdownLine)
    .join('\n')
}

function convertMarkdownLine(line: string): string {
  // A leading `- ` or `* ` bullet becomes a wiki `* ` bullet.
  const bullet = line.match(/^(\s*)[-*]\s+(.*)$/)
  const inner = convertMarkdownInline(bullet ? bullet[2] : line)
  return bullet ? `* ${inner}` : inner
}

function convertMarkdownInline(text: string): string {
  return (
    text
      // Links `[label](url)` → `[label|url]`.
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '[$1|$2]')
      // Bold `**text**` → `*text*` (wiki bold). Runs before any single-`*` rule
      // and the messages use no single-`*` emphasis, so this cannot mis-nest.
      .replace(/\*\*([^*]+)\*\*/g, '*$1*')
  )
}
