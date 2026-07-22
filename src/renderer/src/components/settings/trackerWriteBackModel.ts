// Pure model for the write-back settings surface (T11 / MC-1640 §4). Keeps the
// copy, the event catalog, the honest preview composition, and the transition
// option builder side-effect-free so they are unit-testable without React or IPC.

import type {
  TrackerCapabilities,
  TrackerProviderId,
  TrackerTransition,
  TrackerWriteBackCommentEvent,
  TrackerWriteBackConfig,
  TrackerWriteBackTransitionEvent,
} from '../../../../shared/electron-api'
import { pullRequestComment, runCompletedComment, runStartedComment } from '../../../../shared/tracker/writeback-messages'
import { trackerProviderLabel } from '../../../../shared/tracker/provider-label'

// Human provider name for the master-switch copy ("never write to Jira"), from
// the shared provider-label table. Falls back to a neutral word so an unknown
// provider still reads plainly.
export function providerDisplayName(provider: TrackerProviderId): string {
  return trackerProviderLabel(provider)
}

// The master-switch subtitle: off names what write-back does NOT do (read-only);
// on states the ticked-events-only contract, so the framing stays honest either way.
export function masterDescription(enabled: boolean, provider: TrackerProviderId): string {
  return enabled
    ? 'On — only the events ticked below are posted.'
    : `Off — sprints read from ${providerDisplayName(provider)} but never write to it.`
}

// The three lifecycle moments a comment marks, in mockup order.
export const COMMENT_EVENTS: ReadonlyArray<{ key: TrackerWriteBackCommentEvent; label: string }> = [
  { key: 'started', label: 'a sprint starts' },
  { key: 'pr', label: 'a pull request opens' },
  { key: 'done', label: 'a sprint completes' },
]

// The two lifecycle moments a status transition can map to.
export const TRANSITION_EVENTS: ReadonlyArray<{ key: TrackerWriteBackTransitionEvent; label: string }> = [
  { key: 'onStart', label: 'a sprint starts' },
  { key: 'onComplete', label: 'a sprint completes' },
]

// The transition tier is shown ONLY for providers whose capability reports
// canTransition — never a provider-name check (plan §3.7). An absent capabilities
// object (no client registered) hides the tier too.
export function showsTransitionTier(capabilities: TrackerCapabilities | undefined): boolean {
  return capabilities?.canTransition === true
}

// Build a status picker's options from the tracker's OWN transitions plus the
// explicit "leave it alone" default. `value === ''` is the null mapping.
export function transitionSelectOptions(
  transitions: ReadonlyArray<TrackerTransition>,
): Array<{ value: string; label: string }> {
  return [
    { value: '', label: "Don’t change status" },
    ...transitions.map((transition) => ({ value: transition.id, label: `Move to “${transition.name}”` })),
  ]
}

// Illustrative fill values for the preview. Clearly example content — the preview
// shows the real posted FORMAT, not a specific run's data.
const PREVIEW_GOAL = 'Relay ledger purge'
const PREVIEW_PR_URL = 'https://github.com/your-org/your-repo/pull/412'
const PREVIEW_TASK_COUNT = 4

export type WriteBackPreviewComment = { key: TrackerWriteBackCommentEvent; markdown: string }

// The comments a run WOULD post under this config, in lifecycle order. Off master
// ⇒ nothing (the surface shows the "write-back is off" line instead). Each body is
// composed by the SAME shared function the engine posts, so the preview cannot
// drift from reality — only the fill values are examples.
export function previewComments(config: TrackerWriteBackConfig): WriteBackPreviewComment[] {
  if (!config.enabled) return []
  const out: WriteBackPreviewComment[] = []
  if (config.comments.started) out.push({ key: 'started', markdown: runStartedComment({ goal: PREVIEW_GOAL }) })
  if (config.comments.pr) {
    out.push({ key: 'pr', markdown: pullRequestComment({ goal: PREVIEW_GOAL, pullRequestUrls: [PREVIEW_PR_URL] }) })
  }
  if (config.comments.done) {
    out.push({
      key: 'done',
      markdown: runCompletedComment({ goal: PREVIEW_GOAL, pullRequestUrls: [PREVIEW_PR_URL], taskCount: PREVIEW_TASK_COUNT }),
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Comment-markdown → renderable blocks. The engine posts a tiny markdown subset
// (a bold-led paragraph, plain lines, and `- url` list items). This tokenizes just
// that subset so the preview renders it as a real comment instead of showing raw
// asterisks — no general markdown dependency.
// ---------------------------------------------------------------------------

export type CommentInline = { text: string; bold?: boolean }
export type CommentBlock = { kind: 'paragraph'; segments: CommentInline[] } | { kind: 'link-list'; urls: string[] }

export function renderCommentBlocks(markdown: string): CommentBlock[] {
  const blocks: CommentBlock[] = []
  let listUrls: string[] = []
  const flushList = () => {
    if (listUrls.length) {
      blocks.push({ kind: 'link-list', urls: listUrls })
      listUrls = []
    }
  }
  for (const rawLine of markdown.split('\n')) {
    const line = rawLine.trimEnd()
    if (!line.trim()) {
      flushList()
      continue
    }
    const listMatch = /^-\s+(.*)$/.exec(line)
    if (listMatch) {
      listUrls.push(listMatch[1].trim())
      continue
    }
    flushList()
    blocks.push({ kind: 'paragraph', segments: parseBoldSegments(line) })
  }
  flushList()
  return blocks
}

// Split a line on `**bold**` runs into styled segments. Unbalanced markers are
// treated as literal text so the preview never drops content.
function parseBoldSegments(line: string): CommentInline[] {
  const segments: CommentInline[] = []
  const pattern = /\*\*(.+?)\*\*/g
  let lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(line)) !== null) {
    if (match.index > lastIndex) segments.push({ text: line.slice(lastIndex, match.index) })
    segments.push({ text: match[1], bold: true })
    lastIndex = pattern.lastIndex
  }
  if (lastIndex < line.length) segments.push({ text: line.slice(lastIndex) })
  return segments.length ? segments : [{ text: line }]
}
