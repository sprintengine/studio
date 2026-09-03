// Pure logic for the "Add from tracker" picker (T7 / MC-1637 UI, mockup §2).
// Kept free of React and Electron so it unit-tests as a plain node module and so
// the picker component stays a thin render over these decisions. Every rule the
// mockup shows — which issues are already in the backlog, how a live state reads,
// what the result report says — lives here, never as an inline branch in JSX.

import type { NormalizedIssue, TrackerProviderId } from '../../../../shared/electron-api'
import type { BacklogItemLink } from '../../utils/backlog'
import type { Tone } from '../ui/tokens'

// The T6 writer records one issue-typed sidecar link per proxy item, whose
// target.kind is `<provider>.issue` and target.id is the provider's stable
// externalId. That link is the only already-surfaced signal of "this issue is
// already a backlog item" (row-level external frontmatter reading is T8), so the
// picker keys its dimmed/locked rows off it.
const ISSUE_KIND_SUFFIX = '.issue'

export function issueIndexKey(provider: string, externalId: string): string {
  return `${provider}:${externalId}`
}

// Set of `${provider}:${externalId}` for every issue already materialized into
// the backlog, drawn from the issue-typed links across the scanned items. Only
// `type: 'issue'` links with a `<provider>.issue` target participate; execution/
// review/agent links are ignored.
export function backlogIssueLinkIndex(
  items: ReadonlyArray<{ links: ReadonlyArray<BacklogItemLink> }>,
): Set<string> {
  const index = new Set<string>()
  for (const item of items) {
    for (const link of item.links) {
      if (link.type !== 'issue') continue
      const kind = link.target?.kind
      if (!kind || !kind.endsWith(ISSUE_KIND_SUFFIX)) continue
      const provider = kind.slice(0, -ISSUE_KIND_SUFFIX.length)
      const externalId = link.target?.id
      if (provider && externalId) index.add(issueIndexKey(provider, externalId))
    }
  }
  return index
}

export function isIssueInBacklog(
  index: ReadonlySet<string>,
  provider: TrackerProviderId,
  externalId: string,
): boolean {
  return index.has(issueIndexKey(provider, externalId))
}

// The status indicator for a tracker issue row. Tone is derived from the
// STRUCTURAL category (open/closed) only — never the display name, per the
// state-mapping contract (plan §3.1) — while the label always shows the
// tracker's own verbatim state name, so the live state reads truthfully (e.g.
// "In Progress", "Done", "Backlog") rather than being flattened to open/closed.
export function trackerIssueStateChip(issue: Pick<NormalizedIssue, 'state'>): { tone: Tone; label: string } {
  const label = issue.state.nativeName.trim() || (issue.state.category === 'closed' ? 'Closed' : 'Open')
  return { tone: issue.state.category === 'closed' ? 'good' : 'neutral', label }
}

