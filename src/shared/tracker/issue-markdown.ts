// Rendering a tracker issue as the markdown an agent reads (MC-2358).
//
// This is the composition half of what `tracker/materialize/proxy-content.ts`
// used to do, lifted out of the materialize layer because it long outlives it:
// MC-2359 deletes materialization, but "turn an issue into a document a sprint
// can be seeded from" is still needed — it is just written into the run's own
// gitignored directory now instead of into `backlog/`.
//
// The provenance line changed with the model. The old marker said the file
// "mirrors an external issue" and would be "replaced when it refreshes", which
// described a copy the app kept syncing. This is a **snapshot taken at launch**:
// nothing refreshes it, nothing overwrites it, and the tracker stays the system
// of record. Saying so plainly is what stops an agent treating it as a document
// to keep up to date.

import type { NormalizedIssue, TrackerProviderId } from './types'

const PROVIDER_LABEL: Record<TrackerProviderId, string> = {
  github: 'GitHub',
  jira: 'Jira',
  linear: 'Linear',
}

export function trackerProviderLabel(provider: TrackerProviderId | string): string {
  return PROVIDER_LABEL[provider as TrackerProviderId] ?? provider
}

// The line separating the snapshot's own header from the issue's body. Addressed
// to whoever reads the file — human or agent — so neither treats it as a local
// document that owns the truth.
export function issueSnapshotMarker(provider: TrackerProviderId | string, capturedAt: string): string {
  return (
    `> Snapshot of this ${trackerProviderLabel(provider)} issue, taken ${capturedAt}. ` +
    `The issue itself is the system of record — this file is not synced and is not the place to record changes.`
  )
}

/**
 * Compose the full markdown document for one issue: title heading, the mirrored
 * facts a planner needs at a glance, a link back, the provenance marker, the
 * body, and the comment thread.
 *
 * The comment thread matters more than it looks: on most tickets the real
 * acceptance criteria are in the comments rather than the description, so a
 * seed that drops them hands the architect half the brief.
 */
export function composeIssueMarkdown(issue: NormalizedIssue, options: { capturedAt?: string } = {}): string {
  const capturedAt = options.capturedAt ?? new Date().toISOString()
  const title = issue.title.trim() || issue.nativeKey
  const lines: string[] = [`# ${title}`, '']

  const facts: string[] = [`**State:** ${issue.state.nativeName.trim() || defaultStateName(issue)}`]
  if (issue.priority?.trim()) facts.push(`**Priority:** ${issue.priority.trim()}`)
  const assignee = issue.assignee?.displayName?.trim()
  if (assignee) facts.push(`**Assignee:** ${assignee}`)
  lines.push(facts.join(' · '), '')

  if (issue.url.trim()) {
    lines.push(`[View ${issue.nativeKey} in ${trackerProviderLabel(issue.provider)}](${issue.url.trim()})`, '')
  }

  lines.push(issueSnapshotMarker(issue.provider, capturedAt), '')

  const body = issue.bodyMarkdown.trim()
  lines.push(body || '_No description provided._')

  if (issue.comments.length > 0) {
    lines.push('', '## Comments')
    for (const comment of issue.comments) {
      const header = [comment.author?.trim(), comment.createdAt?.trim()].filter(Boolean).join(' · ')
      lines.push('')
      if (header) lines.push(`**${header}**`, '')
      lines.push(comment.body.trim() || '_(empty comment)_')
    }
  }

  return `${lines.join('\n')}\n`
}

// The goal line a run started from an issue carries: the native key stays
// verbatim so the run is recognisable as that ticket wherever a run is listed.
export function issueSprintGoal(issue: NormalizedIssue): string {
  const title = issue.title.trim()
  return title ? `${issue.nativeKey} — ${title}` : issue.nativeKey
}

function defaultStateName(issue: NormalizedIssue): string {
  return issue.state.category === 'closed' ? 'Closed' : 'Open'
}
