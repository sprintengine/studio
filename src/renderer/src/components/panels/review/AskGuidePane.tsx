import { useCallback, useEffect, useRef, useState } from 'react'

import { useCompanionAgent } from '../../../hooks/useCompanionAgent'
import { PrimaryButton } from '../../ui/Buttons'
import { KbdChord } from '../../ui/KbdChord'
import { FOCUS_RING_CLASS } from '../../ui/tokens'
import { GuideChatThread } from './GuideChatThread'

// The primary (submit) modifier named for the platform, matching the comment
// composer's chord. Safe when window is absent (static render).
const PRIMARY_KEY =
  typeof window !== 'undefined' && window.api?.platform === 'darwin' ? 'Cmd' : 'Ctrl'

// The guide companion the walkthrough was built from — one per workspace. Sending
// binds to this same session (main-side attach is idempotent on this key), so the
// chat continues the very thread the brief run used rather than a second agent.
export const REVIEW_GUIDE_AGENT_ID = 'review-guide'

interface AskGuidePaneProps {
  workspaceId: string
  workspaceRoot: string
  changedPaths: string[]
  onJumpToLine: (path: string, line: number) => void
  // A quote to seed the composer with (from an "Ask the guide" affordance). The
  // nonce re-applies the same quote on a repeat click; the text is the block.
  prefill?: { text: string; nonce: number }
}

// "Ask the guide" — the chat pane. It observes the guide companion's live
// conversation (useCompanionAgent → the shared projection in GuideChatThread) and
// sends turns through the review IPC, which forwards to the same companion the
// walkthrough used. There is deliberately no code path here that creates or edits
// a review comment: the guide answers, the human writes the comments.
export function AskGuidePane({ workspaceId, workspaceRoot, changedPaths, onJumpToLine, prefill }: AskGuidePaneProps) {
  const { events } = useCompanionAgent(workspaceId, REVIEW_GUIDE_AGENT_ID)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  // Seed the composer when an "Ask the guide" affordance opens the pane with a
  // quoted anchor. The nonce lets the same quote re-apply on a repeat click.
  useEffect(() => {
    if (!prefill) return
    setDraft(prefill.text)
    const node = inputRef.current
    if (node) {
      node.focus()
      node.setSelectionRange(node.value.length, node.value.length)
    }
  }, [prefill?.nonce])

  // Keep the newest message in view as the answer streams in.
  useEffect(() => {
    const node = scrollRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [events])

  // Send binds to the guide companion via review IPC; the reply — and the echo of
  // this very message — arrive on the conversation event stream this pane already
  // observes, so there is no optimistic local turn to reconcile (and no duplicate
  // bubble). A failed send surfaces an error and drops nothing into the thread.
  const send = useCallback(async () => {
    const message = draft.trim()
    if (!message || sending) return
    setDraft('')
    setSendError(null)
    setSending(true)
    try {
      const result = await window.api.reviewAskGuide({ workspaceId, workspaceRoot, message })
      if (!result.ok) setSendError(result.error)
    } catch (error) {
      setSendError(error instanceof Error ? error.message : String(error))
    } finally {
      setSending(false)
    }
  }, [draft, sending, workspaceId, workspaceRoot])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto pr-0.5">
        <GuideChatThread events={events} changedPaths={changedPaths} onJumpToLine={onJumpToLine} />
      </div>

      {sendError ? (
        <p className="mt-2 text-[11px] leading-4 text-[color:var(--tone-error)]">
          The guide couldn’t answer: {sendError}
        </p>
      ) : null}

      <div className="mt-2 border-t border-[color:var(--border-subtle)] pt-2.5">
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault()
                void send()
              }
            }}
            placeholder="Ask about any line, step, or decision…"
            rows={2}
            className={`min-h-[36px] flex-1 resize-none rounded-[5px] border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-2.5 py-1.5 text-[12.5px] leading-5 text-[color:var(--text-strong)] focus:border-[color:var(--border-focus)] ${FOCUS_RING_CLASS}`}
          />
          <PrimaryButton onClick={() => void send()} disabled={!draft.trim() || sending} className="shrink-0">
            {sending ? 'Sending…' : 'Send'}
          </PrimaryButton>
        </div>
        <p className="mt-1.5 flex items-center gap-1 text-[11px] text-[color:var(--text-subtle)]">
          <KbdChord keys={[PRIMARY_KEY, 'Enter']} /> send
          <span className="mx-1 text-[color:var(--text-disabled)]">·</span>
          <KbdChord keys={['Shift', 'Enter']} /> new line
        </p>
      </div>
    </div>
  )
}

export default AskGuidePane
