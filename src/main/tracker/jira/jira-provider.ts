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
// Center against REST v2; the only branch between them is the auth header, which
// lives entirely in jira-http.ts. This class fetches and normalizes only — it
// never writes backlog files (that is the T6 writer's job).

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
    const startAt = parseCursor(args.cursor)
    const page = await this.searchPage(connection, secret, freeTextSearchJql(args.query), startAt, SEARCH_PAGE_SIZE)
    const nextStart = startAt + page.issues.length
    return {
      issues: page.issues.map((record) => normalizeJiraIssue(record, connection)),
      ...(nextStart < page.total ? { nextCursor: String(nextStart) } : {}),
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
    let startAt = 0
    for (let pageIndex = 0; pageIndex < MAX_ASSIGNED_PAGES; pageIndex += 1) {
      const page = await this.searchPage(connection, secret, jql, startAt, SEARCH_PAGE_SIZE)
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
        body: { body: args.body },
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
      return { ok: false, reason: err instanceof Error ? err.message : 'Could not reach Jira.' }
    }
  }

  private async searchPage(
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
