import { JSDOM } from 'jsdom'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { afterEach, expect, test } from 'vitest'
import type { ConversationTimelineRow } from './conversationTimeline'
import {
  type ChatOpening,
  noteChatLeft,
  noteChatOpened,
  unreadDividerRowId,
  unseenFromTheTop,
  useChatOpening,
} from './unreadDivider'
import { useVisitStamp, type VisitTarget } from '../../workspace/sidebar/useVisitStamp'

// The "New" divider: which row it goes above, and the visit clock it is
// measured against, read as the chat opened and before the visit moved it.

type Reply = Extract<ConversationTimelineRow, { kind: 'assistant' }>
type Tool = Reply['tools'][number]

function you(turnId: string, createdAt: number): ConversationTimelineRow {
  return { kind: 'user', id: `user:${turnId}`, entry: { kind: 'user', id: turnId, text: 'Go on', createdAt } }
}

function reply(
  turnId: string,
  startedAt: number | undefined,
  completedAt: number | undefined,
  tools: Tool[] = [],
): ConversationTimelineRow {
  return {
    kind: 'assistant',
    id: `assistant:${turnId}`,
    entry: {
      kind: 'assistant',
      turnId,
      text: 'Done.',
      reasoning: '',
      status: completedAt === undefined ? 'streaming' : 'complete',
      ...(startedAt === undefined ? {} : { startedAt }),
      ...(completedAt === undefined ? {} : { completedAt }),
    },
    tools,
    decisions: [],
  }
}

function step(turnId: string, id: string): Tool {
  return { kind: 'tool', id, turnId, name: 'Read', status: 'done' }
}

function compacted(turnId: string | undefined): ConversationTimelineRow {
  return {
    kind: 'compaction',
    id: `compaction:${turnId ?? 'between'}`,
    entry: { kind: 'compaction', id: turnId ?? 'between', ...(turnId ? { turnId } : {}) },
  } as ConversationTimelineRow
}

function openedAt(at: number, since: ChatOpening['since']): ChatOpening {
  return { workspaceId: 'chat', openedAt: at, since }
}

afterEach(() => noteChatLeft('chat'))

const SEEN_AND_NEW = [you('a', 100), reply('a', 110, 200), you('b', 300), reply('b', 310, 400)]

test('the divider goes above the first reply that finished after the last visit', () => {
  expect(unreadDividerRowId(SEEN_AND_NEW, openedAt(1_000, { kind: 'visit', at: 250 }))).toBe('assistant:b')
})

test('a reply the visit came after is read, so a chat read to the end has no divider', () => {
  expect(unreadDividerRowId(SEEN_AND_NEW, openedAt(1_000, { kind: 'visit', at: 400 }))).toBeNull()
})

test('the person’s own message is never where the new part starts', () => {
  // Sent from the phone after the visit: it is theirs, so the divider still
  // waits for the agent's answer below it.
  const rows = [you('a', 100), reply('a', 110, 200), you('b', 300)]
  expect(unreadDividerRowId(rows, openedAt(1_000, { kind: 'visit', at: 250 }))).toBeNull()
  expect(unreadDividerRowId([...rows, reply('b', 310, 400)], openedAt(1_000, { kind: 'visit', at: 250 }))).toBe(
    'assistant:b',
  )
})

test('a chat with nothing read from an agent yet has no divider: all of it is new', () => {
  // Started from New chat and left before it answered, or never opened.
  const rows = [you('a', 100), reply('a', 110, 200)]
  expect(unreadDividerRowId(rows, openedAt(1_000, { kind: 'visit', at: 50 }))).toBeNull()
  expect(unreadDividerRowId(rows, openedAt(1_000, null))).toBeNull()
})

test('an unseen run that reaches the top of a page with history above it puts the divider at the top, not nowhere', () => {
  // Ten turns loaded, all finished since the last visit; older ones not loaded.
  const rows = [you('k', 1_000), reply('k', 1_010, 1_100), you('l', 1_200), reply('l', 1_210, 1_300)]
  const opened = openedAt(5_000, { kind: 'visit', at: 500 })
  expect(unseenFromTheTop(rows, opened), 'the reply that was seen is further back').toBe(true)
  expect(unreadDividerRowId(rows, opened)).toBeNull()
  expect(unreadDividerRowId(rows, opened, { historyAbove: true })).toBe('assistant:k')
  // A seen reply loaded above it settles it where it always went.
  const paged = [you('j', 100), reply('j', 110, 200), ...rows]
  expect(unseenFromTheTop(paged, opened)).toBe(false)
  expect(unreadDividerRowId(paged, opened, { historyAbove: true })).toBe('assistant:k')
  // Read to the end, nothing is unseen at the top either.
  expect(unseenFromTheTop(SEEN_AND_NEW, openedAt(1_000, { kind: 'visit', at: 900 }))).toBe(false)
})

test('a reply folded into a group of steps takes the divider on its row, never inside its work', () => {
  const rows = [
    you('a', 100),
    reply('a', 110, 200),
    you('b', 300),
    reply('b', 310, 400, [step('b', 's1'), step('b', 's2')]),
  ]
  expect(unreadDividerRowId(rows, openedAt(1_000, { kind: 'visit', at: 250 }))).toBe('assistant:b')
})

test('a compaction inside the unseen turn is new too; one between turns stays above the divider', () => {
  const inside = [you('a', 100), reply('a', 110, 200), you('b', 300), compacted('b'), reply('b', 310, 400)]
  expect(unreadDividerRowId(inside, openedAt(1_000, { kind: 'visit', at: 250 }))).toBe('compaction:b')
  const between = [you('a', 100), reply('a', 110, 200), compacted(undefined), you('b', 300), reply('b', 310, 400)]
  expect(unreadDividerRowId(between, openedAt(1_000, { kind: 'visit', at: 250 }))).toBe('assistant:b')
})

test('a reply already under way at the last visit was watched begin, so it takes no divider', () => {
  const rows = [you('a', 100), reply('a', 110, 200), you('b', 300), reply('b', 310, undefined)]
  expect(unreadDividerRowId(rows, openedAt(1_000, { kind: 'visit', at: 350 }))).toBeNull()
  // One that began after it, still streaming, is new.
  expect(unreadDividerRowId(rows, openedAt(1_000, { kind: 'visit', at: 250 }))).toBe('assistant:b')
})

test('the divider holds its row while the agent streams on and starts new turns', () => {
  const opened = openedAt(1_000, { kind: 'visit', at: 250 })
  const atOpen = [...SEEN_AND_NEW, you('c', 500), reply('c', 510, undefined)]
  expect(unreadDividerRowId(atOpen, opened)).toBe('assistant:b')
  const later = [...SEEN_AND_NEW, you('c', 500), reply('c', 510, 1_100), you('d', 1_200), reply('d', 1_210, undefined)]
  expect(unreadDividerRowId(later, opened)).toBe('assistant:b')
  // Nothing was new at opening: a turn that starts while the chat is in
  // front is read as it arrives, and never draws a divider above itself.
  const readToEnd = openedAt(1_000, { kind: 'visit', at: 900 })
  expect(unreadDividerRowId(later, readToEnd)).toBeNull()
})

test('a reply replayed with no clock counts as read', () => {
  const rows = [you('a', 100), reply('a', undefined, undefined), you('b', 300), reply('b', 310, 400)]
  ;(rows[1] as Reply).entry.status = 'complete'
  expect(unreadDividerRowId(rows, openedAt(1_000, { kind: 'visit', at: 250 }))).toBe('assistant:b')
})

test('marked unread, the clock just before the latest finish puts the divider above the latest reply', () => {
  // `conversation.mark_unread` sets the visit clock to the latest finish less
  // a millisecond; a reply that began after the opening is not the latest.
  const rows = [...SEEN_AND_NEW, you('c', 500), reply('c', 510, 600), you('d', 2_000), reply('d', 2_010, undefined)]
  expect(unreadDividerRowId(rows, openedAt(1_000, { kind: 'visit', at: 599 }))).toBe('assistant:c')
  // Opened again after reading all of it, the clock has moved past it: no divider.
  expect(unreadDividerRowId(rows, openedAt(3_000, { kind: 'visit', at: 2_500 }))).toBeNull()
})

test('an opening belongs to its chat while it is in front, and to no other', () => {
  noteChatOpened('chat', 250, 1_000)
  expect(readOpening('chat')).toEqual({ workspaceId: 'chat', openedAt: 1_000, since: { kind: 'visit', at: 250 } })
  expect(readOpening('other')).toBeNull()
  noteChatLeft('other')
  expect(readOpening('chat'), 'another chat leaving does not end it').not.toBeNull()
  noteChatLeft('chat')
  expect(readOpening('chat')).toBeNull()
})

// The current opening, read through the hook the chat view uses.
function readOpening(workspaceId: string): ChatOpening | null {
  let value: ChatOpening | null = null
  function Probe() {
    value = useChatOpening(workspaceId)
    return null
  }
  renderToString(createElement(Probe))
  return value
}

test('the visit stamp says the chat opened before its first stamp, and that it left when another came in front', async () => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost', pretendToBeVisual: true })
  const previous = Object.getOwnPropertyDescriptors(globalThis)
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true }
  Object.assign(globalThis, globals)
  const { act } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.createElement('div'))
  // The chat's visit clock, as the store keeps it: the stamp moves it.
  const clock: Record<string, number> = { first: 250, second: 700 }
  const target = (id: string): VisitTarget => ({
    key: `local:${id}`,
    turnEndedAt: 400,
    visitedAt: clock[id]!,
    stamp: (at) => {
      clock[id] = at
    },
    opened: () => noteChatOpened(id, clock[id]!, 1_000),
    left: () => noteChatLeft(id),
  })
  function Sidebar({ id }: { id: string | null }) {
    useVisitStamp(id ? target(id) : null, true)
    return null
  }
  let opening: ChatOpening | null = null
  function ChatView({ id }: { id: string }) {
    opening = useChatOpening(id)
    return null
  }
  try {
    await act(async () => root.render(createElement(Sidebar, { id: 'first' })))
    expect(clock.first, 'the opening was stamped as a visit').toBeGreaterThan(250)
    const host = createRoot(dom.window.document.createElement('div'))
    await act(async () => host.render(createElement(ChatView, { id: 'first' })))
    expect(opening).toEqual({ workspaceId: 'first', openedAt: 1_000, since: { kind: 'visit', at: 250 } })
    await act(async () => root.render(createElement(Sidebar, { id: 'second' })))
    await act(async () => host.render(createElement(ChatView, { id: 'first' })))
    expect(opening, 'the first chat left the front').toBeNull()
    await act(async () => host.render(createElement(ChatView, { id: 'second' })))
    expect(opening).toMatchObject({ workspaceId: 'second', since: { kind: 'visit', at: 700 } })
    // Coming back finds the clock the last visit left, not the one before.
    const stamped = clock.first!
    await act(async () => root.render(createElement(Sidebar, { id: 'first' })))
    await act(async () => host.render(createElement(ChatView, { id: 'first' })))
    expect(opening).toMatchObject({ since: { kind: 'visit', at: stamped } })
    await act(async () => root.render(createElement(Sidebar, { id: null })))
    await act(async () => host.render(createElement(ChatView, { id: 'first' })))
    expect(opening, 'nothing in front is every chat left').toBeNull()
    await act(async () => host.unmount())
    await act(async () => root.unmount())
  } finally {
    dom.window.close()
    for (const key of Object.keys(globals)) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key])
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
