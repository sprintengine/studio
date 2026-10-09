// @vitest-environment jsdom
import React, { act, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { LegendListRef } from '@legendapp/list/react'

import type { ConversationTimelineRow } from './conversationTimeline'
import { useChatFind, type ChatFind } from './useChatFind'

type UserRow = Extract<ConversationTimelineRow, { kind: 'user' }>
type AssistantRow = Extract<ConversationTimelineRow, { kind: 'assistant' }>

const user = (id: string, text: string): UserRow => ({
  kind: 'user',
  id: `user:${id}`,
  entry: { kind: 'user', id, text } as UserRow['entry'],
})
const reply = (turnId: string, text: string, status: 'streaming' | 'complete' = 'complete'): AssistantRow => ({
  kind: 'assistant',
  id: `assistant:${turnId}`,
  entry: { kind: 'assistant', turnId, text, reasoning: '', status },
  tools: [],
  decisions: [],
})

let root: Root | null = null
let host: HTMLElement | null = null
let find: ChatFind | null = null
let firstVisibleRow = 0
const jumpToRow = vi.fn()
const pauseFollowing = vi.fn()
const focusFallback = vi.fn()

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  firstVisibleRow = 0
  jumpToRow.mockClear()
  pauseFollowing.mockClear()
  focusFallback.mockClear()
})

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  root = null
  host = null
  find = null
  vi.useRealTimers()
})

function Harness({ rows }: { rows: readonly ConversationTimelineRow[] }) {
  const transcriptRef = useRef<HTMLDivElement | null>(null)
  const shellRef = useRef<HTMLDivElement | null>(null)
  // The list is not mounted here: the find asks it only where the reader is.
  const listRef = useRef({
    getState: () => ({ start: firstVisibleRow }),
    getScrollableNode: () => null,
  } as unknown as LegendListRef)
  find = useChatFind({ rows, listRef, transcriptRef, shellRef, jumpToRow, pauseFollowing, focusFallback })
  return (
    <div ref={shellRef} data-chat-pane="">
      <div ref={transcriptRef} id="transcript" tabIndex={0} />
      <input ref={find.inputRef} value={find.query} onChange={(event) => find!.setQuery(event.target.value)} />
    </div>
  )
}

async function mount(rows: readonly ConversationTimelineRow[]) {
  host = document.createElement('div')
  document.body.append(host)
  const created = createRoot(host)
  root = created
  await act(async () => created.render(<Harness rows={rows} />))
  return (next: readonly ConversationTimelineRow[]) => act(async () => created.render(<Harness rows={next} />))
}

const advance = (ms: number) => act(async () => vi.advanceTimersByTime(ms))

const rows = [
  user('u1', 'deploy the app'),
  reply('t1', 'Deploying now.'),
  user('u2', 'did the deploy work?'),
  reply('t2', 'The deploy worked; deploy logs are clean.'),
]

test('a search waits for the typing to settle, then lands on the first match from where the reader is', async () => {
  await mount(rows)
  firstVisibleRow = 2
  await act(async () => find!.openFind())
  await act(async () => find!.setQuery('deploy'))
  expect(find!.status).toBe('')
  await advance(119)
  expect(find!.status).toBe('')
  await advance(1)
  // Five matches; the first at or below row 2 is the third.
  expect(find!.status).toBe('3 of 5')
  // That row is not drawn (nothing is, here), so the list is asked for it.
  expect(jumpToRow).toHaveBeenLastCalledWith(2, 'user:u2')
})

test('the steps wrap, and Enter inside the debounce searches at once', async () => {
  await mount(rows)
  firstVisibleRow = 3
  await act(async () => find!.openFind())
  await act(async () => find!.setQuery('deploy'))
  // Enter before the debounce: the search runs now and lands on its first match.
  await act(async () => find!.findNext())
  expect(find!.status).toBe('4 of 5')
  await act(async () => find!.findNext())
  expect(find!.status).toBe('5 of 5')
  await act(async () => find!.findNext())
  expect(find!.status).toBe('1 of 5')
  await act(async () => find!.findPrevious())
  expect(find!.status).toBe('5 of 5')
})

test('a reply streaming on is recounted at a steady pace without moving the reader', async () => {
  const streaming = [...rows.slice(0, 3), reply('t2', 'The deploy', 'streaming')]
  const rerender = await mount(streaming)
  await act(async () => find!.openFind())
  await act(async () => find!.setQuery('deploy'))
  await advance(120)
  expect(find!.status).toBe('1 of 4')
  await act(async () => find!.findNext())
  expect(find!.status).toBe('2 of 4')
  const jumps = jumpToRow.mock.calls.length

  // Tokens arrive faster than the recount; the count catches up once the
  // window has passed, and the reader is still on the match they chose.
  await rerender([...rows.slice(0, 3), reply('t2', 'The deploy worked; deploy', 'streaming')])
  await rerender([...rows.slice(0, 3), reply('t2', 'The deploy worked; deploy logs; deploy', 'streaming')])
  await advance(300)
  expect(find!.status).toBe('2 of 6')
  expect(jumpToRow.mock.calls.length).toBe(jumps)

  // A page of history loads above: the indexes shift, the match does not.
  await rerender([
    user('u0', 'first deploy'),
    ...rows.slice(0, 3),
    reply('t2', 'The deploy worked; deploy logs; deploy'),
  ])
  await advance(300)
  expect(find!.status).toBe('3 of 7')
  expect(jumpToRow.mock.calls.length).toBe(jumps)
})

test('Esc returns the keyboard to where it was when the bar opened', async () => {
  await mount(rows)
  const transcript = document.getElementById('transcript')!
  transcript.focus()
  await act(async () => find!.openFind())
  expect(find!.open).toBe(true)
  // The field has the keyboard as soon as the bar is drawn.
  expect(document.activeElement).toBe(host!.querySelector('input'))
  await act(async () => find!.close())
  expect(find!.open).toBe(false)
  expect(document.activeElement).toBe(transcript)
  expect(focusFallback).not.toHaveBeenCalled()

  // Opened from outside the chat (the palette): the composer gets it.
  transcript.blur()
  expect(document.activeElement).toBe(document.body)
  await act(async () => find!.openFind())
  await act(async () => find!.close())
  expect(focusFallback).toHaveBeenCalledTimes(1)
})
