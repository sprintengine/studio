import { JSDOM } from 'jsdom'
import { expect, test } from 'vitest'

// A live row that scrolls off screen says so with an attribute and leaves the
// pausing to the stylesheet. It must never write an inline play state: an
// inline `running` beats the window-idle pause, so a streaming row kept
// animating in an unfocused window, and an inline value set once missed a
// looping part that mounted inside the row later.
test('an offscreen live row is marked for the stylesheet, and no inline play state is written', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  })
  const observed = new Map<Element, (entries: Array<{ target: Element; isIntersecting: boolean }>) => void>()
  class FakeIntersectionObserver {
    constructor(private readonly callback: (entries: Array<{ target: Element; isIntersecting: boolean }>) => void) {}
    observe(target: Element) {
      observed.set(target, this.callback)
    }
    unobserve(target: Element) {
      observed.delete(target)
    }
    disconnect() {
      observed.clear()
    }
  }
  const previous = Object.getOwnPropertyDescriptors(globalThis)
  const globals = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    IntersectionObserver: FakeIntersectionObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  }
  Object.assign(globalThis, globals)
  try {
    const { act, createElement, useRef, useState } = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { useLiveRowMotion } = await import('./liveVisibility')

    let addPart: () => void = () => undefined
    function Row() {
      const ref = useRef<HTMLDivElement>(null)
      const [late, setLate] = useState(false)
      addPart = () => setLate(true)
      useLiveRowMotion(ref, true)
      return createElement(
        'div',
        { ref, 'data-testid': 'row' },
        createElement('span', { className: 'chat-shimmer__band' }),
        late ? createElement('i', { className: 'working-mark__cell' }) : null,
      )
    }
    const host = dom.window.document.createElement('div')
    dom.window.document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => root.render(createElement(Row)))
    const row = dom.window.document.querySelector('[data-testid="row"]')!
    const scroll = (inView: boolean) => observed.get(row)?.([{ target: row, isIntersecting: inView }])
    const inlinePlayStates = () =>
      [...row.querySelectorAll<HTMLElement>('*')].map((el) => el.style.animationPlayState).filter(Boolean)

    expect(row.hasAttribute('data-live-offscreen'), 'on screen, nothing is marked').toBe(false)
    await act(async () => scroll(false))
    expect(row.hasAttribute('data-live-offscreen'), 'scrolled away, the row is marked').toBe(true)
    await act(async () => addPart())
    await act(async () => scroll(true))
    expect(row.hasAttribute('data-live-offscreen'), 'back on screen, the mark is cleared').toBe(false)
    expect(inlinePlayStates(), 'the stylesheet decides; nothing is written inline').toEqual([])

    await act(async () => scroll(false))
    await act(async () => root.unmount())
    expect(row.hasAttribute('data-live-offscreen'), 'a row that stops being live is left unmarked').toBe(false)
  } finally {
    dom.window.close()
    for (const key of Object.keys(globals)) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key])
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
