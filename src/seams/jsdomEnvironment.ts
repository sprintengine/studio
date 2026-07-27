import { JSDOM } from 'jsdom'

// Shared DOM bootstrap for the seam suites that mount a real renderer surface.
//
// The Electron app cannot be driven headlessly, so a suite that needs to prove a
// renderer control reaches main stands up a real DOM, mounts the actual surface,
// and lets the preload passthrough carry the call. Every suite that does this
// needs the same globals in the same order — before React or any renderer module
// is imported — so the list lives here once rather than drifting between copies.
//
// Call this at module scope, then `await import(...)` everything else.

export function installJsdomEnvironment(): JSDOM {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  })

  const anyGlobal = globalThis as unknown as Record<string, unknown>
  anyGlobal.window = dom.window as unknown as Record<string, unknown>
  anyGlobal.document = dom.window.document
  anyGlobal.navigator = dom.window.navigator
  anyGlobal.HTMLElement = dom.window.HTMLElement
  anyGlobal.HTMLInputElement = dom.window.HTMLInputElement
  anyGlobal.HTMLTextAreaElement = dom.window.HTMLTextAreaElement
  anyGlobal.Node = dom.window.Node
  anyGlobal.MouseEvent = dom.window.MouseEvent
  anyGlobal.KeyboardEvent = dom.window.KeyboardEvent
  anyGlobal.CustomEvent = dom.window.CustomEvent
  anyGlobal.getComputedStyle = dom.window.getComputedStyle
  anyGlobal.localStorage = dom.window.localStorage
  anyGlobal.IS_REACT_ACT_ENVIRONMENT = true

  dom.window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  })) as unknown as typeof dom.window.matchMedia
  // JSDOM has no scrollIntoView; a Select's open effect scrolls its active
  // option into view.
  dom.window.HTMLElement.prototype.scrollIntoView = () => {}

  class NoopResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  anyGlobal.ResizeObserver = NoopResizeObserver
  dom.window.ResizeObserver = NoopResizeObserver as unknown as typeof dom.window.ResizeObserver

  return dom
}

/**
 * The preload API a mounted surface reaches for is far wider than any one seam.
 * Members this suite supplies answer for real; everything else answers inertly
 * rather than throwing — a subscription hands back an unsubscribe, and a call
 * resolves to a refusal. Never a fake success: a seam that needs a member to
 * succeed must supply it.
 */
export function withInertPreloadFallback(api: Record<string, unknown>): Record<string, unknown> {
  return new Proxy(api, {
    get: (target, prop: string) =>
      prop in target
        ? target[prop]
        : prop.startsWith('on')
          ? () => () => {}
          : async () => ({ ok: false, message: `${prop} is not part of this seam` }),
  })
}
