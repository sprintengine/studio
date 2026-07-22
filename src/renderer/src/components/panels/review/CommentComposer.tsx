import { useEffect, useRef, useState } from 'react'

import { PrimaryButton, GhostButton } from '../../ui/Buttons'
import { KbdChord } from '../../ui/KbdChord'
import { FOCUS_RING_CLASS } from '../../ui/tokens'

interface CommentComposerProps {
  placeholder: string
  submitLabel: string
  initialBody?: string
  // The line this comment anchors to, e.g. "removed line 257" — shown in the
  // footer for a create composer; omitted for an inline edit (the line is known).
  anchorLabel?: string
  // The hint under the actions — the composer explains comments collect and post
  // together (create), or is omitted for an inline edit.
  hint?: string
  onSubmit: (body: string) => void
  onCancel: () => void
}

// The primary (submit) modifier, named for the platform so the hint matches the
// key the reviewer actually presses. Safe when window is absent (static render).
const PRIMARY_KEY =
  typeof window !== 'undefined' && window.api?.platform === 'darwin' ? 'Cmd' : 'Ctrl'

// The comment composer: a textarea that opens directly under a diff line (create)
// or in place of a thread body (edit). Submitting is disabled until there is real
// text, so an empty comment can never enter the review. ⌘/Ctrl+Enter submits and
// Shift+Enter inserts a newline; Escape cancels — the one composer submit chord
// shared with the guide chat.
export function CommentComposer({
  placeholder,
  submitLabel,
  initialBody = '',
  anchorLabel,
  hint,
  onSubmit,
  onCancel,
}: CommentComposerProps) {
  const [body, setBody] = useState(initialBody)
  const ref = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    const node = ref.current
    if (!node) return
    node.focus()
    // Put the caret at the end so an edit doesn't select-all on focus.
    node.setSelectionRange(node.value.length, node.value.length)
  }, [])

  const trimmed = body.trim()
  const submit = (): void => {
    if (!trimmed) return
    onSubmit(trimmed)
  }

  return (
    <div className="border-t border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)] py-2.5 pl-[55px] pr-3.5">
      <textarea
        ref={ref}
        value={body}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            submit()
          } else if (event.key === 'Escape') {
            event.preventDefault()
            onCancel()
          }
        }}
        placeholder={placeholder}
        rows={3}
        className={`w-full max-w-[560px] resize-y rounded-[5px] border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-2.5 py-2 text-[13px] leading-5 text-[color:var(--text-strong)] focus:border-[color:var(--border-focus)] ${FOCUS_RING_CLASS}`}
      />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <PrimaryButton onClick={submit} disabled={!trimmed}>
          {submitLabel}
        </PrimaryButton>
        <GhostButton onClick={onCancel}>Cancel</GhostButton>
        <span className="ml-auto flex items-center gap-2.5 text-[11px] text-[color:var(--text-subtle)]">
          <span className="inline-flex items-center gap-1">
            <KbdChord keys={[PRIMARY_KEY, 'Enter']} /> submit
          </span>
          <span className="inline-flex items-center gap-1">
            <KbdChord keys={['Shift', 'Enter']} /> new line
          </span>
        </span>
      </div>
      {anchorLabel || hint ? (
        <p className="mt-1.5 text-[11px] leading-4 text-[color:var(--text-subtle)]">
          {anchorLabel ? (
            <>
              Anchored to <span className="font-medium text-[color:var(--text-default)]">{anchorLabel}</span>
            </>
          ) : null}
          {anchorLabel && hint ? ' · ' : null}
          {hint}
        </p>
      ) : null}
    </div>
  )
}

export default CommentComposer
