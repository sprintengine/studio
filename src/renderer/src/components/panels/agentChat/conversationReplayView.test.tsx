import { JSDOM } from 'jsdom'
import { expect, test, vi } from 'vitest'
import type { ConversationEvent, ConversationEventType } from '../../../../../shared/conversation-runtime'

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
async function mountReplay() {
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
        source: { status: 'ready', events: EVENTS },
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
