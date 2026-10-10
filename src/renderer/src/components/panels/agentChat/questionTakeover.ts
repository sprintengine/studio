// When a question from the agent takes the composer's place.
//
// A question covers the composer the moment it can (`coversComposer`), and for
// someone who is not typing that is right: nothing can be sent while it waits.
// For someone halfway through a word it was not: the box vanished under their
// fingers and the rest of the word went nowhere. So a question that arrives
// while the person is typing in the composer waits until the draft has been
// still for a moment, they send, the draft empties, focus leaves the box, or
// they say "Answer now". It is never invisible while it waits: the tray says
// it is there, and offers to take it now.

import { useCallback, useEffect, useRef, useState } from 'react'

/** How long the draft has to be still before a waiting question takes the box. */
export const QUESTION_TAKEOVER_IDLE_MS = 1500

/**
 * Whether a question arriving now waits: only while the person is typing in
 * the composer, which is focus in it, words in it, and an edit within the idle
 * window. Anything else and the question takes the box at once.
 */
export function questionShouldWait(input: { focused: boolean; draftEmpty: boolean; sinceLastEdit: number }): boolean {
  return input.focused && !input.draftEmpty && input.sinceLastEdit < QUESTION_TAKEOVER_IDLE_MS
}

type Hold = { key: string | null; waiting: boolean }

/**
 * `questionKey` is the request id of the question that would cover the
 * composer, or null. `composerFocused` is asked only when a question arrives.
 * `noteDraftEdit` is called from the field's own change handler: it writes a
 * ref, so a keystroke re-renders nothing it did not already.
 */
export function useQuestionTakeover({
  questionKey,
  draftEmpty,
  composerFocused,
  now = Date.now,
}: {
  questionKey: string | null
  draftEmpty: boolean
  composerFocused: () => boolean
  now?: () => number
}): { covers: boolean; waiting: boolean; noteDraftEdit: () => void; takeOver: () => void } {
  const lastEditRef = useRef(Number.NEGATIVE_INFINITY)
  // A question once shown is never held back again, should it come and go.
  const seenRef = useRef(new Set<string>())
  const [hold, setHold] = useState<Hold>({ key: questionKey, waiting: false })
  let current = hold
  if (hold.key !== questionKey) {
    // Decided in render, not after it: a frame with the question covering the
    // box would already have taken the keyboard from the sentence being typed.
    current = {
      key: questionKey,
      waiting:
        questionKey !== null &&
        !seenRef.current.has(questionKey) &&
        questionShouldWait({ focused: composerFocused(), draftEmpty, sinceLastEdit: now() - lastEditRef.current }),
    }
    setHold(current)
  }
  useEffect(() => {
    if (questionKey !== null) seenRef.current.add(questionKey)
  }, [questionKey])

  const waiting = current.waiting && current.key !== null && !draftEmpty
  const nowRef = useRef(now)
  nowRef.current = now
  useEffect(() => {
    if (!waiting) return
    // One timer, aimed at the last edit's deadline and re-aimed when it fires
    // early: typing on while the question waits moves a ref, not a timer.
    let timer: ReturnType<typeof setTimeout> | undefined
    const check = () => {
      const left = QUESTION_TAKEOVER_IDLE_MS - (nowRef.current() - lastEditRef.current)
      if (left > 0) timer = setTimeout(check, left)
      else setHold((held) => (held.key === questionKey ? { ...held, waiting: false } : held))
    }
    check()
    return () => clearTimeout(timer)
  }, [waiting, questionKey])

  const noteDraftEdit = useCallback(() => {
    lastEditRef.current = nowRef.current()
  }, [])
  const takeOver = useCallback(() => setHold((held) => (held.waiting ? { ...held, waiting: false } : held)), [])
  return { covers: questionKey !== null && !waiting, waiting, noteDraftEdit, takeOver }
}
