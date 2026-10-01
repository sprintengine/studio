import { JSDOM } from 'jsdom'
import { expect, test } from 'vitest'

// A popover's surface is portaled to <body>, so hiding the trigger's layer does
// not hide the surface with it. Switching workspace makes the old layer
// `invisible` and aria-hidden; a door paints over the canvas inert. Either way
// an open menu must close rather than float over the next view.
test('an open popover closes when its trigger is hidden, and stays open while it is not', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  })
  const previous = Object.getOwnPropertyDescriptors(globalThis)
  // Records what the popover watches: the trigger's own chain, never a subtree.
  const watched: Array<{ target: Node; options?: MutationObserverInit }> = []
  class RecordingMutationObserver extends dom.window.MutationObserver {
    override observe(target: Node, options?: MutationObserverInit): void {
      watched.push({ target, options })
      super.observe(target, options)
    }
  }
  const globals = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    MutationObserver: RecordingMutationObserver,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  }
  Object.assign(globalThis, globals)
  try {
    const { act, createElement, useState } = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { Popover } = await import('./Popover')
    const frame = () => new Promise((resolve) => dom.window.requestAnimationFrame(() => resolve(undefined)))

    for (const hide of [
      (layer: HTMLElement) => layer.setAttribute('aria-hidden', 'true'),
      (layer: HTMLElement) => layer.setAttribute('inert', ''),
    ]) {
      const layer = dom.window.document.createElement('div')
      dom.window.document.body.appendChild(layer)
      const root = createRoot(layer)
      let setOpen: (next: boolean) => void = () => undefined
      function Host() {
        const [open, change] = useState(true)
        setOpen = change
        return createElement(Popover, {
          open,
          onOpenChange: change,
          ariaLabel: 'Engine',
          popupRole: 'menu',
          renderTrigger: ({ ref, triggerProps }) =>
            createElement('span', { ref: ref as never, ...triggerProps }, 'Engine'),
          children: createElement('p', null, 'Model list'),
        })
      }
      watched.length = 0
      await act(async () => root.render(createElement(Host)))
      expect(dom.window.document.querySelector('[role="menu"]')).not.toBeNull()
      const trigger = dom.window.document.querySelector('[aria-haspopup]')!
      expect(watched.length, 'the trigger and each ancestor are watched').toBeGreaterThan(0)
      for (const { target, options } of watched) {
        expect(options?.subtree, 'no subtree is watched, so churn elsewhere costs nothing').toBeFalsy()
        expect(target.contains(trigger), 'only the trigger and its ancestors are watched').toBe(true)
      }
      expect(watched.some(({ target }) => target === layer)).toBe(true)

      // An unrelated attribute change elsewhere does not close it.
      await act(async () => {
        dom.window.document.body.setAttribute('data-theme', 'dark')
        await frame()
      })
      expect(dom.window.document.querySelector('[role="menu"]'), 'a visible trigger keeps it open').not.toBeNull()

      await act(async () => {
        hide(layer)
        await frame()
      })
      expect(dom.window.document.querySelector('[role="menu"]'), 'hiding the trigger closes it').toBeNull()
      setOpen(false)
      await act(async () => root.unmount())
      layer.remove()
    }
  } finally {
    dom.window.close()
    for (const key of Object.keys(globals)) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key])
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
