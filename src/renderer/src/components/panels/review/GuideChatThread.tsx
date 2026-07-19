import { useMemo } from 'react'

import type { ConversationEvent } from '../../../../../shared/conversation-runtime'
import { renderMarkdown } from '../../../utils/markdown'
import {
  projectConversation,
  deriveConversationTimelineRows,
  type ConversationTimelineRow,
  type TranscriptEntry,
  type UserTurn,
} from '../AgentChatView'
import { AgentWorkingDots } from '../../ui/AgentWorkingDots'
import { extractGuideCitations, type LineCitation } from './guideCitations'

interface GuideChatThreadProps {
  // The raw companion event stream (useCompanionAgent), fed straight into the
  // shared projection so the thread reuses AgentChatView's exact message model.
  events: ConversationEvent[]
  // Optimistic user turns not yet echoed by the runtime. The review chat relies
  // on the authoritative event echo (no localTurnId to reconcile), so it passes
  // none; the prop stays for the projection contract and tests.
  localUserTurns?: UserTurn[]
  // Changed-file paths, so a `path:line` citation in a reply resolves to a real
  // file and renders as a jump link.
  changedPaths: string[]
  onJumpToLine: (path: string, line: number) => void
}

const SparkGlyph = () => (
  <svg viewBox="0 0 16 16" className="icon-sm text-[color:var(--accent-primary)]" fill="currentColor" aria-hidden="true">
    <path d="M8 1l1.6 4.4L14 7l-4.4 1.6L8 13l-1.6-4.4L2 7l4.4-1.6z" />
  </svg>
)

// The guide's chat thread: a pure projection of the companion conversation. It
// reuses the exported `projectConversation` + `deriveConversationTimelineRows`
// (not a lookalike model) and mirrors AgentChatView's message anatomy — quiet
// right-aligned user cards, glyph-led guide turns with markdown prose — adding
// the review-specific citation links under each answer. It renders nothing that
// judges or acts; it only shows what the guide said.
export function GuideChatThread({ events, localUserTurns = [], changedPaths, onJumpToLine }: GuideChatThreadProps) {
  const rows = useMemo(() => {
    const projection = projectConversation(events, localUserTurns)
    return deriveConversationTimelineRows(projection.entries, projection.activeTurn)
  }, [events, localUserTurns])

  if (rows.length === 0) {
    return (
      <p className="px-1 py-2 text-[12px] leading-5 text-[color:var(--text-subtle)]">
        Ask the guide about any line, step, or decision in this change. It has the walkthrough and the diff, and it
        answers with citations you can click — it never writes or posts a comment for you.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-0.5">
      {rows.map((row) => (
        <GuideRow key={row.id} row={row} changedPaths={changedPaths} onJumpToLine={onJumpToLine} />
      ))}
    </div>
  )
}

function GuideRow({
  row,
  changedPaths,
  onJumpToLine,
}: {
  row: ConversationTimelineRow
  changedPaths: string[]
  onJumpToLine: (path: string, line: number) => void
}) {
  if (row.kind === 'user') return <UserRow entry={row.entry} />
  if (row.kind === 'assistant') {
    return <GuideTurn entry={row.entry} changedPaths={changedPaths} onJumpToLine={onJumpToLine} />
  }
  if (row.kind === 'working') {
    return (
      <div className="flex items-center gap-2 pb-4 text-[12px] text-[color:var(--text-subtle)]">
        <AgentWorkingDots label="Guide is thinking" />
        <span>{row.label}</span>
      </div>
    )
  }
  return null
}

// Quiet right-aligned user card — AgentChatView's user anatomy.
function UserRow({ entry }: { entry: Extract<TranscriptEntry, { kind: 'user' }> }) {
  return (
    <div className="flex justify-end pb-4">
      <div className="max-w-[80%] rounded-[10px] border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)] px-3 py-2">
        <p className="whitespace-pre-wrap text-[12.5px] leading-normal text-[color:var(--text-strong)]">{entry.text}</p>
      </div>
    </div>
  )
}

function GuideTurn({
  entry,
  changedPaths,
  onJumpToLine,
}: {
  entry: Extract<TranscriptEntry, { kind: 'assistant' }>
  changedPaths: string[]
  onJumpToLine: (path: string, line: number) => void
}) {
  const citations = useMemo(
    () => (entry.text.trim() ? extractGuideCitations(entry.text, changedPaths) : { lines: [], knowledge: [] }),
    [entry.text, changedPaths],
  )
  return (
    <div className="pb-4">
      <div className="mb-1.5 flex items-baseline gap-1.5">
        <SparkGlyph />
        <span className="text-[12px] font-semibold text-[color:var(--text-strong)]">Guide</span>
      </div>
      {entry.text.trim() ? <div className="max-w-[68ch] text-[13px]">{renderMarkdown(entry.text)}</div> : null}
      {citations.lines.length > 0 || citations.knowledge.length > 0 ? (
        <CitationRow lines={citations.lines} knowledge={citations.knowledge} onJumpToLine={onJumpToLine} />
      ) : null}
      {entry.status === 'interrupted' ? (
        <span className="text-[11px] text-[color:var(--text-subtle)]">Interrupted</span>
      ) : null}
      {entry.status === 'failed' ? (
        <span className="text-[11px] text-[color:var(--tone-error)]">
          {entry.failureReason ?? 'The guide could not answer.'}
        </span>
      ) : null}
    </div>
  )
}

// Grounding links under an answer: each `path:line` citation jumps to those lines
// in the walkthrough; knowledge notes render as accent tags (jumping into the
// graph is out of scope here). Accent links are the one accent use in the pane.
function CitationRow({
  lines,
  knowledge,
  onJumpToLine,
}: {
  lines: LineCitation[]
  knowledge: string[]
  onJumpToLine: (path: string, line: number) => void
}) {
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
      {lines.map((cite) => (
        <button
          key={cite.label}
          type="button"
          onClick={() => onJumpToLine(cite.path, cite.startLine)}
          className="interactive font-mono text-[10.5px] text-[color:var(--accent-primary)] hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--border-focus)]"
        >
          {cite.label}
        </button>
      ))}
      {knowledge.map((note) => (
        <span key={note} className="font-mono text-[10.5px] text-[color:var(--accent-primary)]">
          [[{note}]]
        </span>
      ))}
    </div>
  )
}

export default GuideChatThread
