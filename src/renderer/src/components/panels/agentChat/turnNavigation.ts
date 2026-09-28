// Turn-by-turn navigation over the virtualized transcript: the marks the
// gutter minimap draws (one per prompt the person sent), which of them the
// reader is in, and where "previous turn" / "next turn" land.

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { LegendListRef } from '@legendapp/list/react'
import type { ConversationTimelineRow } from './conversationTimeline'

/** A short conversation is read by scrolling; the minimap starts at three prompts. */
export const TURN_MINIMAP_MIN_TURNS = 3

export type TurnMark = {
  id: string
  rowIndex: number
  prompt: string
}

export type TurnDirection = -1 | 1

/** One mark per user row. */
export function deriveTurnMarks(rows: readonly ConversationTimelineRow[]): TurnMark[] {
  const marks: TurnMark[] = []
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!
    if (row.kind === 'user') marks.push({ id: row.id, rowIndex: index, prompt: row.entry.text })
  }
  return marks
}

/**
 * What the marks are derived from: where each prompt sits. A streamed token
 * gives the rows a new identity without moving a prompt, so the marks — and
 * the minimap's ticks drawn from them — are kept until this changes.
 */
export function turnMarksKey(rows: readonly ConversationTimelineRow[]): string {
  let key = ''
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!
    if (row.kind === 'user') key += `${index}:${row.id}\n`
  }
  return key
}

/**
 * The turn's last reply — the final assistant prose before the next prompt —
 * or null while it has none yet. Read when a preview is shown rather than kept
 * on the mark, because the latest reply changes with every token.
 */
export function turnReply(
  rows: readonly ConversationTimelineRow[],
  marks: readonly TurnMark[],
  index: number,
): string | null {
  const mark = marks[index]
  if (!mark) return null
  const end = marks[index + 1]?.rowIndex ?? rows.length
  for (let row = end - 1; row > mark.rowIndex; row--) {
    const candidate = rows[row]
    if (candidate?.kind === 'assistant' && candidate.entry.text.trim()) return candidate.entry.text
  }
  return null
}

/** Whitespace-collapsed and cut at a word, for a one-glance preview. */
export function turnPreviewText(text: string | null, limit: number): string | null {
  const compact = text?.replace(/\s+/g, ' ').trim() ?? ''
  if (!compact) return null
  if (compact.length <= limit) return compact
  const cut = compact.slice(0, limit)
  const space = cut.lastIndexOf(' ')
  return `${(space > limit * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`
}

/** The turn holding the first visible row: the last prompt at or above it, else -1. */
export function turnAtRow(marks: readonly TurnMark[], firstVisibleRow: number): number {
  let found = -1
  for (let index = 0; index < marks.length && marks[index]!.rowIndex <= firstVisibleRow; index++) found = index
  return found
}

/**
 * Where a step lands, or -1 when there is nowhere to go. Stepping back from the
 * middle of a turn returns to that turn's own prompt first — the way a shell's
 * previous-prompt jump does — and only a reader already at the prompt moves to
 * the one before it.
 */
export function adjacentTurn(
  marks: readonly TurnMark[],
  firstVisibleRow: number,
  direction: TurnDirection,
  anchor: number | null = null,
): number {
  if (marks.length === 0) return -1
  if (anchor !== null && anchor >= 0 && anchor < marks.length) {
    const target = anchor + direction
    return target >= 0 && target < marks.length ? target : -1
  }
  const current = turnAtRow(marks, firstVisibleRow)
  if (direction === 1) return current + 1 < marks.length ? current + 1 : -1
  if (current < 0) return -1
  return marks[current]!.rowIndex === firstVisibleRow ? current - 1 : current
}

/**
 * Tracks the reader's turn from the list's first visible row and steps between
 * prompts. A jump remembers the turn it landed on until the reader scrolls by
 * hand: the row above a freshly jumped-to prompt can still report as the first
 * visible one by a pixel, and stepping from it would land on the same prompt.
 */
export function useTurnNavigation(input: {
  rows: readonly ConversationTimelineRow[]
  listRef: RefObject<LegendListRef | null>
  jumpToRow: (index: number, id: string) => void
}) {
  const { rows, listRef } = input
  const marksKey = turnMarksKey(rows)
  const rowsRef = useRef(rows)
  rowsRef.current = rows
  // Keyed on where the prompts sit, not on the rows' identity.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const marks = useMemo(() => deriveTurnMarks(rowsRef.current), [marksKey])
  const [firstVisibleRow, setFirstVisibleRow] = useState(0)
  const [anchor, setAnchor] = useState<number | null>(null)
  const latest = useRef({ marks, firstVisibleRow, anchor, jumpToRow: input.jumpToRow })
  latest.current = { marks, firstVisibleRow, anchor, jumpToRow: input.jumpToRow }
  const reply = useCallback((markIndex: number) => turnReply(rowsRef.current, latest.current.marks, markIndex), [])

  // Re-subscribed as prompts arrive: cheap, and it picks the scroller up even
  // when the list mounted a frame after the first row did.
  const markCount = marks.length
  useEffect(() => {
    const list = listRef.current
    const scroller = list?.getScrollableNode() as HTMLElement | null | undefined
    if (!list || !scroller) return
    let frame = 0
    const read = () => {
      frame = 0
      const start = list.getState().start
      if (Number.isFinite(start)) setFirstVisibleRow(Math.max(0, start))
    }
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(read)
    }
    // Only the reader's own input releases a jump's anchor: the jump's scroll
    // event, and a streaming reply growing the list, are not the reader moving.
    const release = () => setAnchor(null)
    read()
    scroller.addEventListener('scroll', onScroll, { passive: true })
    scroller.addEventListener('wheel', release, { passive: true })
    scroller.addEventListener('touchstart', release, { passive: true })
    scroller.addEventListener('pointerdown', release)
    scroller.addEventListener('keydown', release)
    return () => {
      if (frame) cancelAnimationFrame(frame)
      scroller.removeEventListener('scroll', onScroll)
      scroller.removeEventListener('wheel', release)
      scroller.removeEventListener('touchstart', release)
      scroller.removeEventListener('pointerdown', release)
      scroller.removeEventListener('keydown', release)
    }
  }, [listRef, markCount])

  // A page of earlier turns shifts every index; the remembered one with it.
  const firstMarkId = marks[0]?.id
  useEffect(() => setAnchor(null), [firstMarkId])

  const jump = useCallback((markIndex: number) => {
    const mark = latest.current.marks[markIndex]
    if (!mark) return
    setAnchor(markIndex)
    latest.current.jumpToRow(mark.rowIndex, mark.id)
  }, [])
  const step = useCallback(
    (direction: TurnDirection) => {
      const current = latest.current
      const target = adjacentTurn(current.marks, current.firstVisibleRow, direction, current.anchor)
      if (target >= 0) jump(target)
    },
    [jump],
  )
  const current = anchor ?? turnAtRow(marks, firstVisibleRow)
  const hasPrevious = adjacentTurn(marks, firstVisibleRow, -1, anchor) >= 0
  const hasNext = adjacentTurn(marks, firstVisibleRow, 1, anchor) >= 0
  return { marks, current, hasPrevious, hasNext, jump, step, reply }
}

export type TurnNavigation = ReturnType<typeof useTurnNavigation>
