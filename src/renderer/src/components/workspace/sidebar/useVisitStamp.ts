import { useEffect, useRef } from 'react'

// "A person has this chat on screen", said to whoever keeps the chat's visit
// clock (`lastVisitedAt`): this desktop's registry for a chat here, the other
// machine for a chat followed from it. Every device reads its "finished,
// unseen" mark from that clock, so the window showing a chat is what clears
// the mark on the phone.
//
// Said while the chat is the one in front, in a window that is visible and
// focused — never on a render. At once when the chat has a finish newer than
// the last visit, so the phone's mark goes the moment the person is looking;
// otherwise no more often than every ten seconds while it stays in front,
// which keeps "when was this last looked at" honest without a write per frame.

export const VISIT_STAMP_INTERVAL_MS = 10_000

/** Whether the chat in front should be stamped now. */
export function visitStampDue(input: {
  now: number
  /** When this window last stamped it; null when it has not. */
  stampedAt: number | null
  turnEndedAt: number | null
  visitedAt: number | null
}): boolean {
  const seen = Math.max(input.visitedAt ?? 0, input.stampedAt ?? 0)
  if (input.turnEndedAt !== null && input.turnEndedAt > seen) return true
  return input.stampedAt === null || input.now - input.stampedAt >= VISIT_STAMP_INTERVAL_MS
}

export type VisitTarget = {
  /** Which chat, where: a change of key is a different chat in front. */
  key: string
  /** When its agent last finished a turn, as far as this window knows. */
  turnEndedAt: number | null
  /** Its visit clock as last read. */
  visitedAt: number | null
  stamp: (at: number) => void
}

/** Stamp `target` while it is on screen. Null, or off screen, stamps nothing. */
export function useVisitStamp(target: VisitTarget | null, onScreen: boolean): void {
  const targetRef = useRef(target)
  targetRef.current = target
  // Per chat rather than one value, so switching back to a chat stamped a
  // moment ago waits out its interval instead of stamping again.
  const stampedAt = useRef(new Map<string, number>())
  const key = target?.key ?? null
  const turnEndedAt = target?.turnEndedAt ?? null
  useEffect(() => {
    if (!onScreen || key === null) return
    const tick = (): void => {
      const current = targetRef.current
      if (!current || current.key !== key) return
      const now = Date.now()
      const due = visitStampDue({
        now,
        stampedAt: stampedAt.current.get(key) ?? null,
        turnEndedAt: current.turnEndedAt,
        visitedAt: current.visitedAt,
      })
      if (!due) return
      stampedAt.current.set(key, now)
      current.stamp(now)
    }
    tick()
    const timer = window.setInterval(tick, VISIT_STAMP_INTERVAL_MS)
    return () => window.clearInterval(timer)
    // A finish while the chat is in front is a reason to stamp at once.
  }, [onScreen, key, turnEndedAt])
}
