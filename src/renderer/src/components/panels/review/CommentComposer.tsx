import { useEffect, useRef, useState } from 'react'

import { PrimaryButton, GhostButton } from '../../ui/Buttons'

interface CommentComposerProps {
  placeholder: string
  submitLabel: string
  initialBody?: string
  // The hint under the actions — the composer explains comments collect and post
  // together (create), or is omitted for an inline edit.
  hint?: string
  onSubmit: (body: string) => void
  onCancel: () => void
}

// The comment composer: a textarea that opens directly under a diff line (create)
// or in place of a thread body (edit). Submitting is disabled until there is real
// text, so an empty comment can never enter the review. ⌘/Ctrl+Enter submits;
// Escape cancels — both common in inline-comment UIs.
export function CommentComposer({
  placeholder,
  submitLabel,
  initialBody = '',
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
        className="w-full max-w-[560px] resize-y rounded-[5px] border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-2.5 py-2 text-[13px] leading-5 text-[color:var(--text-strong)] focus:border-[color:var(--border-focus)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-primary-soft)]"
      />
      <div className="mt-2 flex items-center gap-2">
        <PrimaryButton onClick={submit} disabled={!trimmed}>
          {submitLabel}
        </PrimaryButton>
        <GhostButton onClick={onCancel}>Cancel</GhostButton>
        {hint ? <span className="text-[11px] text-[color:var(--text-subtle)]">{hint}</span> : null}
      </div>
    </div>
  )
}

export default CommentComposer
