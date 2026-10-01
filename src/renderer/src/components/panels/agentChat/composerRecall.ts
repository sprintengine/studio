import { useCallback, useRef, type KeyboardEvent } from 'react'

export type ComposerRecall = { index: number | null; stashed: string }
export const EMPTY_RECALL: ComposerRecall = { index: null, stashed: '' }
export function recallPrompt(input: {
  state: ComposerRecall
  history: readonly string[]
  draft: string
  key: string
  firstLine: boolean
  lastLine: boolean
}): { state: ComposerRecall; text: string; handled: boolean } {
  const { state, history, draft, key, firstLine, lastLine } = input
  const unchanged = { state, text: draft, handled: false }
  if (key === 'Escape' && state.index !== null) return { state: EMPTY_RECALL, text: state.stashed, handled: true }
  if (key === 'ArrowUp' && firstLine && history.length && (!draft || state.index !== null)) {
    const index = Math.max(0, (state.index ?? history.length) - 1)
    return {
      state: { index, stashed: state.index === null ? draft : state.stashed },
      text: history[index],
      handled: true,
    }
  }
  if (key === 'ArrowDown' && lastLine && state.index !== null) {
    const index = state.index + 1
    return index >= history.length
      ? { state: EMPTY_RECALL, text: state.stashed, handled: true }
      : { state: { ...state, index }, text: history[index], handled: true }
  }
  return unchanged
}

export function useComposerRecall(history: readonly string[], draft: string, setDraft: (text: string) => void) {
  const state = useRef<ComposerRecall>(EMPTY_RECALL)
  const shown = useRef<string | null>(null)
  const detachRecall = useCallback(() => {
    state.current = EMPTY_RECALL
    shown.current = null
  }, [])
  const handleRecallKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.nativeEvent.isComposing) return false
    if (!['ArrowUp', 'ArrowDown', 'Escape'].includes(event.key)) return false
    if (shown.current !== null && shown.current !== draft) detachRecall()
    const edges =
      event.key === 'Escape' ? { firstLine: false, lastLine: false } : textareaVisualEdges(event.currentTarget)
    const next = recallPrompt({ state: state.current, history, draft, key: event.key, ...edges })
    if (!next.handled) return false
    event.preventDefault()
    state.current = next.state
    shown.current = next.state.index === null ? null : next.text
    setDraft(next.text)
    return true
  }
  return { handleRecallKeyDown, detachRecall }
}

/** Measure actual browser line boxes, including soft wraps; newline counting is insufficient. */
export function textareaVisualEdges(textarea: HTMLTextAreaElement): { firstLine: boolean; lastLine: boolean } {
  if (textarea.selectionStart !== textarea.selectionEnd) return { firstLine: false, lastLine: false }
  if (!textarea.value) return { firstLine: true, lastLine: true }
  const doc = textarea.ownerDocument,
    view = doc.defaultView
  if (!view) return { firstLine: false, lastLine: false }
  const mirror = doc.createElement('div')
  const style = view.getComputedStyle(textarea)
  for (const property of [
    'box-sizing',
    'font-family',
    'font-size',
    'font-weight',
    'font-style',
    'line-height',
    'letter-spacing',
    'word-spacing',
    'text-indent',
    'text-transform',
    'tab-size',
    'padding-top',
    'padding-right',
    'padding-bottom',
    'padding-left',
    'border-top-width',
    'border-right-width',
    'border-bottom-width',
    'border-left-width',
  ])
    mirror.style.setProperty(property, style.getPropertyValue(property))
  const width =
    textarea.clientWidth + (parseFloat(style.borderLeftWidth) || 0) + (parseFloat(style.borderRightWidth) || 0)
  Object.assign(mirror.style, {
    position: 'fixed',
    visibility: 'hidden',
    pointerEvents: 'none',
    whiteSpace: textarea.wrap === 'off' ? 'pre' : 'pre-wrap',
    overflowWrap: 'break-word',
    wordBreak: style.wordBreak,
    direction: style.direction,
    borderStyle: 'solid',
    width: `${width}px`,
  })
  const text = doc.createTextNode(`${textarea.value}\u200b`)
  mirror.appendChild(text)
  doc.body.appendChild(mirror)
  try {
    const top = (offset: number) => {
      const range = doc.createRange()
      range.setStart(text, offset)
      range.collapse(true)
      return range.getBoundingClientRect().top
    }
    const caret = top(textarea.selectionStart)
    return { firstLine: caret <= top(0) + 1, lastLine: caret >= top(textarea.value.length) - 1 }
  } finally {
    mirror.remove()
  }
}
