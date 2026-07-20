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

// The result report shown after a materialize round-trip (AC: "states added/
// refreshed/failed counts with reasons"). Speaks in plain human terms and never
// lets a partial failure read as a clean success — every failure is named with
// the provider's own reason. `failed[].key` is the native key (falling back to
// the externalId) so the message shows PROJ-141, not an opaque internal id.
export function materializeReport(result: {
  added: number
  refreshed: number
  failed: ReadonlyArray<{ key: string; reason: string }>
}): string {
  const changed: string[] = []
  if (result.added > 0) changed.push(`Added ${result.added}`)
  if (result.refreshed > 0) changed.push(result.added > 0 ? `refreshed ${result.refreshed}` : `Refreshed ${result.refreshed}`)

  const sentences: string[] = []
  if (changed.length > 0) {
    sentences.push(`${changed.join(' and ')} — native keys stay visible, and the items keep themselves fresh.`)
  }
  if (result.failed.length > 0) {
    const detail = result.failed.map((entry) => `${entry.key} (${entry.reason})`).join('; ')
    const noun = result.failed.length === 1 ? 'issue' : 'issues'
    sentences.push(`${result.failed.length} ${noun} couldn’t be added: ${detail}.`)
  }
  if (sentences.length === 0) return 'Nothing was added.'
  return sentences.join(' ')
}
