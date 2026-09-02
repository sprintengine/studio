import { normalizeIssueState } from '../../../shared/tracker/state-mapping'
import type { NormalizedIssue } from '../../../shared/tracker/types'

// Linear GraphQL operations (MC-1636) and the normalization from a Linear issue
// node to the shared NormalizedIssue. Bodies are already markdown, so there is no
// conversion layer — `description` lands verbatim as `bodyMarkdown`. State is
// mapped through the shared state-mapping helper by workflow-state `type`, never
// by the display name a team may have renamed.

// Page size for every connection query. Bounded so a large workspace paginates
// via cursors instead of an unbounded single read.
export const LINEAR_PAGE_SIZE = 50

// Hard cap on assigned-to-me pagination. `listAssignedToMe` returns a flat array
// (no cursor in the contract), so it walks pages internally; this bounds that walk
// so one over-assigned viewer can never trigger an unbounded read.
export const LINEAR_ASSIGNED_MAX_PAGES = 20

// Shared field selection for every issue we normalize. `priority` (Int) drives
// whether we surface `priorityLabel`; both `state.type` and `state.name` are read
// so we map by structure and preserve the native name for display.
const ISSUE_FIELDS = `
  id
  identifier
  title
  description
  url
  priority
  priorityLabel
  updatedAt
  state { name type }
  assignee { id displayName }
  labels(first: 50) { nodes { name } }
`

const COMMENT_FIELDS = `
  nodes {
    body
    createdAt
    user { displayName }
  }
`

// Full-text search across every team the key can see (`issueSearch`), paged by
// cursor. Used when the caller passes a non-empty query term.
export const SEARCH_ISSUES_QUERY = `
  query TrackerLinearSearch($term: String!, $first: Int!, $after: String) {
    issueSearch(term: $term, first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { ${ISSUE_FIELDS} }
    }
  }
`

// Recent issues across all teams, ordered by update time. Used when the caller
// passes an empty query (a "browse recent" list rather than a search).
export const LIST_ISSUES_QUERY = `
  query TrackerLinearList($first: Int!, $after: String) {
    issues(first: $first, after: $after, orderBy: updatedAt) {
      pageInfo { hasNextPage endCursor }
      nodes { ${ISSUE_FIELDS} }
    }
  }
`

// The viewer's assigned issues filtered to open workflow-state types. The filter
// is structural (`state.type` not in the two terminal types), so a renamed "Done"
// column can never leak in.
export const ASSIGNED_ISSUES_QUERY = `
  query TrackerLinearAssigned($first: Int!, $after: String) {
    viewer {
      assignedIssues(
        first: $first
        after: $after
        filter: { state: { type: { nin: ["completed", "canceled"] } } }
      ) {
        pageInfo { hasNextPage endCursor }
        nodes { ${ISSUE_FIELDS} }
      }
    }
  }
`

// A single issue with its comments (bodies already markdown). `id` accepts the
// Linear issue UUID, which is our stable `externalId`.
export const FETCH_ISSUE_QUERY = `
  query TrackerLinearIssue($id: String!) {
    issue(id: $id) {
      ${ISSUE_FIELDS}
      comments(first: 100) { ${COMMENT_FIELDS} }
    }
  }
`

// The workflow states of the issue's own team, which is what Linear offers in
// place of Jira's named transition list (MC-1640/MC-2356). Read from the tracker
// and never guessed: the user maps a run event to one of these, exactly as they
// map a Jira transition. `position` is the team's own ordering, so the picker
// lists them the way the team sees them on their board.
export const ISSUE_WORKFLOW_STATES_QUERY = `
  query TrackerLinearIssueStates($id: String!) {
    issue(id: $id) {
      team { states(first: 100) { nodes { id name type position } } }
    }
  }
`

// Comment write-back. Bodies are markdown in both directions, so the composed
// lifecycle comment posts verbatim with no conversion layer.
export const CREATE_COMMENT_MUTATION = `
  mutation TrackerLinearComment($issueId: String!, $body: String!) {
    commentCreate(input: { issueId: $issueId, body: $body }) { success }
  }
`

// Status write-back. `stateId` is one of the ids ISSUE_WORKFLOW_STATES_QUERY
// returned for this issue's team.
export const UPDATE_ISSUE_STATE_MUTATION = `
  mutation TrackerLinearSetState($id: String!, $stateId: String!) {
    issueUpdate(id: $id, input: { stateId: $stateId }) { success }
  }
`

// Probe query: identifies the viewer and organization so a successful test shows
// who the key authenticates as.
export const VIEWER_PROBE_QUERY = `
  query TrackerLinearProbe {
    viewer { id displayName }
    organization { name }
  }
`

// ---------------------------------------------------------------------------
// Response shapes (only the fields the queries above select).
// ---------------------------------------------------------------------------

export type LinearIssueNode = {
  id: string
  identifier: string
  title: string
  description: string | null
  url: string
  priority: number | null
  priorityLabel: string | null
  updatedAt: string | null
  state: { name: string; type: string } | null
  assignee: { id: string | null; displayName: string | null } | null
  labels: { nodes: Array<{ name: string }> } | null
  comments?: { nodes: Array<LinearCommentNode> } | null
}

export type LinearCommentNode = {
  body: string
  createdAt: string | null
  user: { displayName: string | null } | null
}

export type LinearPageInfo = { hasNextPage: boolean; endCursor: string | null }

export type LinearIssueConnection = { pageInfo: LinearPageInfo; nodes: LinearIssueNode[] }

export type SearchIssuesData = { issueSearch: LinearIssueConnection }
export type ListIssuesData = { issues: LinearIssueConnection }
export type AssignedIssuesData = { viewer: { assignedIssues: LinearIssueConnection } | null }
export type FetchIssueData = { issue: LinearIssueNode | null }
export type LinearWorkflowStateNode = {
  id: string
  name: string
  type: string
  position: number | null
}

export type IssueWorkflowStatesData = {
  issue: { team: { states: { nodes: LinearWorkflowStateNode[] } | null } | null } | null
}

// Linear returns `success` on both mutations; a false is a refusal we must not
// swallow into a silent no-op.
export type CreateCommentData = { commentCreate: { success: boolean } | null }
export type UpdateIssueStateData = { issueUpdate: { success: boolean } | null }

export type ViewerProbeData = {
  viewer: { id: string; displayName: string | null } | null
  organization: { name: string | null } | null
}

// ---------------------------------------------------------------------------
// Normalization.
// ---------------------------------------------------------------------------

export function normalizeLinearIssue(node: LinearIssueNode, connectionId: string): NormalizedIssue {
  const issue: NormalizedIssue = {
    provider: 'linear',
    connectionId,
    externalId: node.id,
    nativeKey: node.identifier,
    title: node.title,
    bodyMarkdown: node.description ?? '',
    state: normalizeIssueState({
      provider: 'linear',
      stateType: node.state?.type ?? '',
      nativeName: node.state?.name ?? '',
    }),
    labels: node.labels?.nodes.map((label) => label.name) ?? [],
    url: node.url,
    comments: normalizeComments(node.comments?.nodes),
  }

  // `priority` 0 is Linear's "No priority"; only surface a label for a real one.
  if (typeof node.priority === 'number' && node.priority > 0 && node.priorityLabel) {
    issue.priority = node.priorityLabel
  }
  const assignee = normalizeAssignee(node.assignee)
  if (assignee) issue.assignee = assignee
  if (node.updatedAt) issue.updatedAt = node.updatedAt

  return issue
}

function normalizeComments(nodes: LinearCommentNode[] | undefined): NormalizedIssue['comments'] {
  if (!nodes) return []
  return nodes.map((comment) => {
    const author = comment.user?.displayName ?? undefined
    return {
      body: comment.body,
      ...(author ? { author } : {}),
      ...(comment.createdAt ? { createdAt: comment.createdAt } : {}),
    }
  })
}

function normalizeAssignee(assignee: LinearIssueNode['assignee']): NormalizedIssue['assignee'] | undefined {
  if (!assignee) return undefined
  const id = assignee.id ?? undefined
  const displayName = assignee.displayName ?? undefined
  if (!id && !displayName) return undefined
  return {
    ...(id ? { id } : {}),
    ...(displayName ? { displayName } : {}),
  }
}
