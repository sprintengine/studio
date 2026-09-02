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
import {
  LINEAR_GRAPHQL_ENDPOINT,
  LINEAR_REQUEST_TIMEOUT_MS,
  postLinearGraphQL,
  type LinearFetch,
} from './linear-client'
import {
  ASSIGNED_ISSUES_QUERY,
  CREATE_COMMENT_MUTATION,
  FETCH_ISSUE_QUERY,
  ISSUE_WORKFLOW_STATES_QUERY,
  LINEAR_ASSIGNED_MAX_PAGES,
  LINEAR_PAGE_SIZE,
  LIST_ISSUES_QUERY,
  SEARCH_ISSUES_QUERY,
  UPDATE_ISSUE_STATE_MUTATION,
  VIEWER_PROBE_QUERY,
  normalizeLinearIssue,
  type AssignedIssuesData,
  type CreateCommentData,
  type FetchIssueData,
  type IssueWorkflowStatesData,
  type ListIssuesData,
  type SearchIssuesData,
  type UpdateIssueStateData,
  type ViewerProbeData,
} from './linear-queries'

// The Linear TrackerProvider (MC-1636). Cloud-only: `selfHostable: false` drives
// T2's connection form to fix the endpoint and hide the server-address field with
// no provider `if`.
//
// Write-back is ON (MC-2356). MC-1640 shipped the engine, ledger, config store and
// settings surface provider-agnostically but never flipped these flags, so Linear
// stayed read-only while Jira and GitHub posted — a bug, not a deferral. Linear
// has no named transition list; its equivalent is the issue's own team's workflow
// states, which `listTransitions` reads from the tracker and the user maps.
export const LINEAR_CAPABILITIES: TrackerCapabilities = {
  canComment: true,
  canTransition: true,
  selfHostable: false,
}

// The connection metadata + secret access the provider needs. Satisfied by
// TrackerConnectionStore; narrowed to an interface so tests inject a fake without
// the Electron-backed store.
export type LinearConnectionAccess = {
  getConnection(id: string): Promise<TrackerConnection | undefined>
  resolveSecret(id: string): Promise<ProviderSecretValueResult>
}

export type LinearTrackerProviderOptions = {
  connections: LinearConnectionAccess
  // Linear is cloud-only; the endpoint is fixed in production and overridden only
  // by tests. It is never derived from a connection's baseUrl.
  endpoint?: string
  fetchImpl?: LinearFetch
  timeoutMs?: number
}

export class LinearTrackerProvider implements TrackerProvider {
  readonly provider = 'linear' as const
  readonly capabilities = LINEAR_CAPABILITIES

  private readonly connections: LinearConnectionAccess
  private readonly endpoint: string
  private readonly fetchImpl: LinearFetch
  private readonly timeoutMs: number

  constructor(options: LinearTrackerProviderOptions) {
    this.connections = options.connections
    this.endpoint = options.endpoint ?? LINEAR_GRAPHQL_ENDPOINT
    this.fetchImpl = options.fetchImpl ?? defaultLinearFetch
    this.timeoutMs = options.timeoutMs ?? LINEAR_REQUEST_TIMEOUT_MS
  }

  async searchIssues(args: {
    connectionId: string
    query: string
    cursor?: string
  }): Promise<{ issues: NormalizedIssue[]; nextCursor?: string }> {
    const term = args.query.trim()
    const connection = term
      ? await this.request<SearchIssuesData>(args.connectionId, SEARCH_ISSUES_QUERY, {
          term,
          first: LINEAR_PAGE_SIZE,
          after: args.cursor ?? null,
        }).then((data) => data.issueSearch)
      : await this.request<ListIssuesData>(args.connectionId, LIST_ISSUES_QUERY, {
          first: LINEAR_PAGE_SIZE,
          after: args.cursor ?? null,
        }).then((data) => data.issues)

    const issues = connection.nodes.map((node) => normalizeLinearIssue(node, args.connectionId))
    const nextCursor = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor ?? undefined : undefined
    return { issues, ...(nextCursor ? { nextCursor } : {}) }
  }

  async fetchIssue(args: { connectionId: string; externalId: string }): Promise<NormalizedIssue> {
    const data = await this.request<FetchIssueData>(args.connectionId, FETCH_ISSUE_QUERY, { id: args.externalId })
    if (!data.issue) {
      throw new TrackerProviderError('not_found', 'The Linear issue could not be found.', {
        provider: 'linear',
        connectionId: args.connectionId,
      })
    }
    return normalizeLinearIssue(data.issue, args.connectionId)
  }

  async listAssignedToMe(args: { connectionId: string }): Promise<NormalizedIssue[]> {
    const issues: NormalizedIssue[] = []
    let cursor: string | null = null

    // Walk cursor pages up to a hard cap so an over-assigned viewer never triggers
    // an unbounded read. The open-state filter lives in the query itself.
    for (let page = 0; page < LINEAR_ASSIGNED_MAX_PAGES; page++) {
      const data: AssignedIssuesData = await this.request<AssignedIssuesData>(
        args.connectionId,
        ASSIGNED_ISSUES_QUERY,
        { first: LINEAR_PAGE_SIZE, after: cursor }
      )
      const connection = data.viewer?.assignedIssues
      if (!connection) break
      for (const node of connection.nodes) issues.push(normalizeLinearIssue(node, args.connectionId))
      if (!connection.pageInfo.hasNextPage || !connection.pageInfo.endCursor) break
      cursor = connection.pageInfo.endCursor
    }
    return issues
  }

  async postComment(args: { connectionId: string; externalId: string; body: string }): Promise<void> {
    const body = args.body.trim()
    if (!body) {
      throw new TrackerProviderError('unknown', 'A Linear comment needs a body.', {
        provider: 'linear',
        connectionId: args.connectionId,
      })
    }
    const data = await this.request<CreateCommentData>(args.connectionId, CREATE_COMMENT_MUTATION, {
      issueId: args.externalId,
      body,
    })
    // Linear answers 200 + `success: false` for a refusal it does not raise as a
    // GraphQL error. Treating that as a post would let the ledger record a comment
    // that never landed, and the retry would never fire.
    if (!data.commentCreate?.success) {
      throw new TrackerProviderError('unknown', 'Linear did not accept the comment.', {
        provider: 'linear',
        connectionId: args.connectionId,
      })
    }
  }

  // `transitionId` is a Linear workflow-state id from listTransitions — the same
  // contract as a Jira transition id, resolved against a different concept.
  async transitionIssue(args: { connectionId: string; externalId: string; transitionId: string }): Promise<void> {
    const data = await this.request<UpdateIssueStateData>(args.connectionId, UPDATE_ISSUE_STATE_MUTATION, {
      id: args.externalId,
      stateId: args.transitionId,
    })
    if (!data.issueUpdate?.success) {
      throw new TrackerProviderError('unknown', 'Linear did not accept the status change.', {
        provider: 'linear',
        connectionId: args.connectionId,
      })
    }
  }

  async listTransitions(args: { connectionId: string; externalId: string }): Promise<TrackerTransition[]> {
    const data = await this.request<IssueWorkflowStatesData>(
      args.connectionId,
      ISSUE_WORKFLOW_STATES_QUERY,
      { id: args.externalId }
    )
    if (!data.issue) {
      throw new TrackerProviderError('not_found', 'The Linear issue could not be found.', {
        provider: 'linear',
        connectionId: args.connectionId,
      })
    }
    const nodes = data.issue.team?.states?.nodes
    if (!Array.isArray(nodes)) return []
    // The team's own board order, so the picker reads the way the team does.
    return [...nodes]
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
      .map((state) => ({ id: state.id, name: state.name }))
  }

  async testConnection(args: { connectionId: string }): Promise<TrackerConnectionProbe> {
    try {
      const data = await this.request<ViewerProbeData>(args.connectionId, VIEWER_PROBE_QUERY, {})
      if (!data.viewer) {
        return { ok: false, reason: 'Linear did not return an authenticated user for this API key.' }
      }
      const who = data.viewer.displayName ?? 'your account'
      const org = data.organization?.name
      return { ok: true, summary: org ? `Connected as ${who} in ${org}.` : `Connected as ${who}.` }
    } catch (err) {
      // A probe never throws: it reports the provider's message as the reason so
      // the settings form shows why the key was rejected, and its structural kind
      // so a rejected key classifies as 'expired' (Reconnect) rather than unknown.
      return {
        ok: false,
        reason: err instanceof Error ? err.message : 'Could not reach Linear.',
        ...(err instanceof TrackerProviderError ? { kind: err.kind } : {}),
      }
    }
  }

  private async request<T>(connectionId: string, query: string, variables: Record<string, unknown>): Promise<T> {
    const apiKey = await this.resolveApiKey(connectionId)
    return postLinearGraphQL<T>({
      endpoint: this.endpoint,
      apiKey,
      query,
      variables,
      fetchImpl: this.fetchImpl,
      timeoutMs: this.timeoutMs,
      connectionId,
    })
  }

  private async resolveApiKey(connectionId: string): Promise<string> {
    const connection = await this.connections.getConnection(connectionId)
    if (!connection) {
      throw new TrackerProviderError('not_configured', 'This tracker connection no longer exists.', {
        provider: 'linear',
        connectionId,
      })
    }
    const secret = await this.connections.resolveSecret(connectionId)
    if (!secret.ok || !secret.value) {
      throw new TrackerProviderError('not_configured', 'No Linear API key is configured for this connection.', {
        provider: 'linear',
        connectionId,
      })
    }
    return secret.value
  }

}

function defaultLinearFetch(url: string, init: RequestInit): Promise<Response> {
  if (typeof globalThis.fetch !== 'function') {
    throw new TrackerProviderError('network', 'Network access is unavailable in this runtime.', {
      provider: 'linear',
    })
  }
  return globalThis.fetch(url, init)
}
