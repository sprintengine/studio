import { JSDOM } from 'jsdom'
import { expect, test } from 'vitest'

// The count this guards: how many times a code-split panel commits its
// Suspense fallback. Each one is a "Loading…" frame and a hold of up to 300 ms
// on the real content, however fast the chunk arrived.

async function withDom<T>(run: () => Promise<T>): Promise<T> {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost', pretendToBeVisual: true })
  const previous = Object.getOwnPropertyDescriptors(globalThis)
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  try {
    return await run()
  } finally {
    for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'IS_REACT_ACT_ENVIRONMENT']) {
      const descriptor = previous[key]
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete (globalThis as Record<string, unknown>)[key]
    }
    dom.window.close()
  }
}

async function mountCountingFallbacks(preloadFirst: boolean): Promise<{ fallbacks: number; text: string }> {
  return withDom(async () => {
    const { act, Suspense, createElement } = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { preloadableLazy } = await import('./preloadableLazy')

    const chunk = preloadableLazy<{ label: string }>(async () => ({
      default: ({ label }) => createElement('p', null, label),
    }))
    if (preloadFirst) {
      chunk.preload()
      // The chunk lands before anything asks for it.
      await new Promise((resolve) => setTimeout(resolve, 0))
    }

    let fallbacks = 0
    function Fallback(): null {
      fallbacks += 1
      return null
    }
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(
        createElement(
          Suspense,
          { fallback: createElement(Fallback) },
          createElement(chunk.Component, { label: 'ready' }),
        ),
      )
    })
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    const text = host.textContent ?? ''
    await act(async () => root.unmount())
    return { fallbacks, text }
  })
}

test('a preloaded chunk mounts without ever showing its fallback', async () => {
  const preloaded = await mountCountingFallbacks(true)
  expect(preloaded.text).toBe('ready')
  expect(preloaded.fallbacks).toBe(0)
})

test('a chunk nobody preloaded still mounts, through the fallback', async () => {
  const cold = await mountCountingFallbacks(false)
  expect(cold.text).toBe('ready')
  expect(cold.fallbacks).toBeGreaterThan(0)
})

test('a mount keeps the component it started with when the chunk lands under it', async () => {
  await withDom(async () => {
    const { act, Suspense, createElement, useEffect } = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { preloadableLazy } = await import('./preloadableLazy')

    let mounts = 0
    function Panel({ label }: { label: string }) {
      useEffect(() => {
        mounts += 1
      }, [])
      return createElement('p', null, label)
    }
    const chunk = preloadableLazy<{ label: string }>(async () => ({ default: Panel }))
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const render = (label: string) =>
      root.render(createElement(Suspense, { fallback: null }, createElement(chunk.Component, { label })))
    await act(async () => render('first'))
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    // The module is loaded now; a re-render must not swap the lazy stand-in
    // for it, which would remount the panel and drop its state.
    await act(async () => render('second'))
    expect(host.textContent).toBe('second')
    expect(mounts).toBe(1)
    await act(async () => root.unmount())
  })
})
