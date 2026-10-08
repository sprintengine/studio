import { JSDOM } from 'jsdom'
import { expect, test, vi } from 'vitest'
import type { ConversationEvent, ConversationEventType } from '../../../../../shared/conversation-runtime'

// Each row the replay draws, counted: what a tick costs the transcript above it.
const rowRenders = vi.hoisted(() => ({ count: 0 }))
vi.mock('./timelineRows', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./timelineRows')>()
  const { createElement } = await import('react')
  return {
    ...actual,
    // Not memoized itself, so it counts each time the replay draws the row.
    TimelineRow: (props: import('react').ComponentProps<typeof actual.TimelineRow>) => {
      rowRenders.count++
      return createElement(actual.TimelineRow, props)
    },
  }
})

let seq = 0
function event(type: ConversationEventType, payload: Record<string, unknown>): ConversationEvent {
  seq++
  return {
    id: `event-${seq}`,
    seq,
    sessionId: 'session',
    workspaceId: 'workspace',
    agentId: 'agent',
    providerId: 'mock',
    modelId: 'mock-model',
    type,
    createdAt: seq * 1000,
    payload,
  }
}

const EVENTS = [
  event('user_message', { turnId: 't1', text: 'Why does the build fail?' }),
  event('turn_started', { turnId: 't1' }),
  event('content_delta', { turnId: 't1', text: 'The barrel ' }),
  event('content_delta', { turnId: 't1', text: 'stopped exporting ' }),
  event('content_delta', { turnId: 't1', text: 'the pager.' }),
  event('turn_completed', { turnId: 't1' }),
  event('user_message', { turnId: 't2', text: 'Thanks for checking' }),
]

// jsdom lays nothing out, so the replay's scroller is given a size, a scroll
// position that sticks, and rows that sit where `layout.top` says; scrollTo is
// the replay's, recorded, and reports its scroll the way a browser does.
async function mountReplay(events: ConversationEvent[] = EVENTS) {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost', pretendToBeVisual: true })
  const previous = Object.getOwnPropertyDescriptors(globalThis)
  const globals = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  }
  Object.assign(globalThis, globals)
  Object.assign(dom.window, { matchMedia: () => ({ matches: false }) })
  const layout = { top: 400 }
  const scrollTops = new WeakMap<Element, number>()
  const prototype = dom.window.HTMLElement.prototype
  Object.defineProperty(prototype, 'offsetTop', { get: () => layout.top })
  Object.defineProperty(prototype, 'clientHeight', { get: () => 300 })
  Object.defineProperty(prototype, 'scrollHeight', { get: () => 5000 })
  Object.defineProperty(prototype, 'scrollTop', {
    get(this: Element) {
      return scrollTops.get(this) ?? 0
    },
    set(this: Element, value: number) {
      scrollTops.set(this, value)
    },
  })
  // A glide: the scroll gets there over a few frames, each one reported.
  const scrolledTo: number[] = []
  Object.defineProperty(prototype, 'scrollTo', {
    value(this: HTMLElement, options: { top: number }) {
      scrolledTo.push(options.top)
      const from = this.scrollTop
      for (const step of [0.5, 1]) {
        this.scrollTop = from + (options.top - from) * step
        this.dispatchEvent(new dom.window.Event('scroll', { bubbles: false }))
      }
    },
  })
  const { act, createElement } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { ConversationReplayView } = await import('./conversationReplayView')
  const host = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () =>
    root.render(
      createElement(ConversationReplayView, {
        source: { status: 'ready', events },
        title: 'Build',
        assistantName: 'Claude',
        cli: null,
        onLeave: () => undefined,
      }),
    ),
  )
  const log = () => host.querySelector<HTMLElement>('[role="log"]')!
  return {
    dom,
    host,
    act,
    layout,
    scrolledTo,
    log,
    key: (key: string, target: Element = dom.window.document.activeElement!) => {
      const keydown = new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
      target.dispatchEvent(keydown)
      return keydown
    },
    async unmount() {
      await act(async () => root.unmount())
      dom.window.close()
      for (const key of Object.keys(globals)) {
        if (previous[key]) Object.defineProperty(globalThis, key, previous[key])
        else Reflect.deleteProperty(globalThis, key)
      }
    },
  }
}

test('a drag of the scrollbar hands the view to the person, while the replay’s own glide does not', async () => {
  const replay = await mountReplay()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    expect(replay.scrolledTo, 'it opens on the first message').toEqual([400])
    await replay.act(async () => void replay.key(' '))
    // The reply grows past the bottom: the replay follows it, gliding there.
    replay.layout.top = 900
    await replay.act(async () => vi.advanceTimersByTime(2000))
    expect(replay.scrolledTo.length, 'the replay follows its reply').toBeGreaterThan(1)
    const followed = replay.scrolledTo.length

    // The person drags the scrollbar up: a scroll with no wheel or touch.
    await replay.act(async () => {
      replay.log().scrollTop = 50
      replay.log().dispatchEvent(new replay.dom.window.Event('scroll'))
    })
    replay.layout.top = 1400
    await replay.act(async () => vi.advanceTimersByTime(2000))
    expect(replay.scrolledTo.length, 'the view stays where they took it').toBe(followed)
    expect(replay.log().scrollTop).toBe(50)
  } finally {
    vi.useRealTimers()
    await replay.unmount()
  }
})

test('the replay’s log is a tab stop with the kit’s inset ring, and Page Up / Page Down stay its own', async () => {
  const replay = await mountReplay()
  try {
    const log = replay.log()
    expect(log.tabIndex).toBe(0)
    expect(log.className).toContain('focus-visible:focus-ring-inset')
    expect(log.className).toContain('focus:outline-none')
    log.focus()
    let pageDown: Event | undefined
    await replay.act(async () => void (pageDown = replay.key('PageDown', log)))
    expect(pageDown!.defaultPrevented, 'the log scrolls a page').toBe(false)
    let next: Event | undefined
    await replay.act(async () => void (next = replay.key('ArrowRight', log)))
    expect(next!.defaultPrevented, 'the player still takes its arrows').toBe(true)
    expect(replay.host.textContent).toContain('the pager.')
  } finally {
    await replay.unmount()
  }
})

test('a long replay draws its latest twenty messages, and a step redraws only the rows it changes', async () => {
  const long: ConversationEvent[] = []
  for (let index = 0; index < 30; index++) {
    const turnId = `t${index}`
    long.push(
      event('user_message', { turnId, text: `Question ${index}` }),
      event('turn_started', { turnId }),
      event('content_delta', { turnId, text: `Answer ${index}.` }),
      event('turn_completed', { turnId }),
    )
  }
  const replay = await mountReplay(long)
  const messages = () => replay.host.querySelectorAll('[data-replay-row-kind="user"]').length
  try {
    // Played to the end: the whole conversation is revealed.
    await replay.act(async () => void replay.key('End'))
    expect(replay.host.textContent).toContain('Answer 29.')
    expect(messages(), 'the latest twenty, not all thirty').toBe(20)
    expect(replay.host.textContent).not.toContain('Question 9')

    // Back to the last message, then played on: each tick reveals a little of
    // its reply, and the rows above it are left alone.
    await replay.act(async () => void replay.key('ArrowLeft'))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      await replay.act(async () => void replay.key(' '))
      rowRenders.count = 0
      let ticks = 0
      for (; ticks < 20 && !replay.host.textContent?.includes('Answer 29.'); ticks++)
        await replay.act(async () => vi.advanceTimersByTime(500))
      expect(replay.host.textContent).toContain('Answer 29.')
      expect(rowRenders.count, 'the reply’s row a tick, not the transcript').toBeLessThanOrEqual(ticks * 2 + 2)
    } finally {
      vi.useRealTimers()
    }

    const earlier = [...replay.host.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Show earlier messages'),
    )
    await replay.act(async () => earlier!.click())
    expect(messages()).toBe(30)
    expect(replay.host.textContent).toContain('Question 0')
  } finally {
    await replay.unmount()
  }
})
