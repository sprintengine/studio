import { jiraBodyToMarkdown, jiraCommentBodyToMarkdown } from './jira-markup'
import { normalizeIssueState } from '../../../shared/tracker/state-mapping'
import type { NormalizedIssue, TrackerConnection } from '../../../shared/tracker/types'

// Shapes the Jira REST v2 issue payload the normalizer reads. Fields are `unknown`
// because a site's custom configuration can omit or reshape any of them; every
// read below is defensive.

type JiraAssignee = { accountId?: unknown; name?: unknown; key?: unknown; displayName?: unknown } | null

export type JiraIssueRecord = {
  id?: unknown
  key?: unknown
  fields?: {
    summary?: unknown
    description?: unknown
    status?: { name?: unknown; statusCategory?: { key?: unknown } }
    priority?: { name?: unknown } | null
    labels?: unknown
    assignee?: JiraAssignee
    updated?: unknown
    comment?: { comments?: unknown } | null
  }
}

// Maps a Jira issue to the shared NormalizedIssue. State is derived from the
// STRUCTURAL `statusCategory.key`, never the display name (plan §3.1); the body
// converts best-effort to markdown while `rawBody` keeps the original markup.
export function normalizeJiraIssue(record: JiraIssueRecord, connection: TrackerConnection): NormalizedIssue {
  const fields = record.fields ?? {}
  const nativeKey = typeof record.key === 'string' ? record.key : ''
  const body = jiraBodyToMarkdown(fields.description)

  const statusCategoryKey =
    typeof fields.status?.statusCategory?.key === 'string' ? fields.status.statusCategory.key : ''
  const statusName = typeof fields.status?.name === 'string' ? fields.status.name : statusCategoryKey

  const issue: NormalizedIssue = {
    provider: 'jira',
    connectionId: connection.id,
    externalId: coerceExternalId(record.id, nativeKey),
    nativeKey,
    title: typeof fields.summary === 'string' ? fields.summary : nativeKey,
    bodyMarkdown: body.markdown,
    ...(body.raw !== undefined ? { rawBody: body.raw } : {}),
    state: normalizeIssueState({ provider: 'jira', statusCategoryKey, nativeName: statusName }),
    labels: normalizeLabels(fields.labels),
    url: browseUrl(connection.baseUrl, nativeKey),
    comments: normalizeComments(fields.comment?.comments),
  }

  const priority = fields.priority?.name
  if (typeof priority === 'string' && priority.trim()) issue.priority = priority

  const assignee = normalizeAssignee(fields.assignee)
  if (assignee) issue.assignee = assignee

  if (typeof fields.updated === 'string') issue.updatedAt = fields.updated

  return issue
}

// Stable provider id is the numeric issue id ("10023"); fall back to the key so
// an unexpected payload still yields a usable identifier.
function coerceExternalId(id: unknown, nativeKey: string): string {
  if (typeof id === 'string' && id.trim()) return id
  if (typeof id === 'number') return String(id)
  return nativeKey
}

function normalizeLabels(labels: unknown): string[] {
  return Array.isArray(labels) ? labels.filter((l): l is string => typeof l === 'string') : []
}

function normalizeAssignee(assignee: JiraAssignee | undefined): NormalizedIssue['assignee'] {
  if (!assignee) return undefined
  // Cloud identifies a user by accountId; Data Center by name/key. Take whichever
  // the site provides so both self-hosted and cloud carry a stable id.
  const id =
    firstString(assignee.accountId) ?? firstString(assignee.name) ?? firstString(assignee.key)
  const displayName = firstString(assignee.displayName)
  if (!id && !displayName) return undefined
  return {
    ...(id ? { id } : {}),
    ...(displayName ? { displayName } : {}),
  }
}

function normalizeComments(comments: unknown): NormalizedIssue['comments'] {
  if (!Array.isArray(comments)) return []
  return comments.map((comment) => {
    const c = comment as { author?: { displayName?: unknown }; body?: unknown; created?: unknown }
    const author = firstString(c.author?.displayName)
    const createdAt = firstString(c.created)
    return {
      ...(author ? { author } : {}),
      body: jiraCommentBodyToMarkdown(c.body),
      ...(createdAt ? { createdAt } : {}),
    }
  })
}

// The human-facing issue URL. Jira payloads carry an API `self` link, not the
// browse URL, so it is composed from the connection's site root + the key.
function browseUrl(baseUrl: string | null, nativeKey: string): string {
  if (!baseUrl || !nativeKey) return baseUrl ?? ''
  return `${baseUrl.replace(/\/+$/, '')}/browse/${nativeKey}`
}

function firstString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}
