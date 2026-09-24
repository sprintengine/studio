import { useEffect, useState } from 'react'

/**
 * Whether anyone can see this window, and whether anyone is using it.
 *
 * `visible` is false while either source says the window is out of sight: the
 * Page Visibility API (which needs background throttling on, see
 * `window-factory.ts`), or main's minimize / hide / locked-screen signal. Both
 * are needed: on macOS the page itself was observed reporting `visible` while
 * minimized, hidden and fully covered, and only main knew.
 *
 * `focused` is whether this window has the keyboard. It is read from
 * `document.hasFocus()` a tick after a blur rather than from the blur itself,
 * because focus moving into the browser pane's guest page blurs this document
 * without the person having left the window.
 *
 * It is what the renderer pauses background work on: the terminal visibility
 * push (a hidden window stops having output forwarded to its terminals), the
 * ambient animations (paused on `:root[data-window-active='false']`), the
 * browser start page's local server poll, the git status and sidebar git
 * reads, the relative-time clocks, and the tailnet share poll.
 */
export type WindowActivityState = {
  visible: boolean
  focused: boolean
}

type ActivityDocument = {
  visibilityState: DocumentVisibilityState
  hasFocus(): boolean
  addEventListener(type: 'visibilitychange', listener: () => void): void
  removeEventListener(type: 'visibilitychange', listener: () => void): void
}

type ActivityWindow = {
  addEventListener(type: 'focus' | 'blur', listener: () => void): void
  removeEventListener(type: 'focus' | 'blur', listener: () => void): void
  setTimeout(handler: () => void, ms: number): unknown
}

export type WindowActivity = {
  get(): WindowActivityState
  subscribe(listener: (state: WindowActivityState) => void): () => void
  dispose(): void
}

export function createWindowActivity(
  doc: ActivityDocument,
  win: ActivityWindow,
  // Main's word on minimize / hide / locked screen. The page's own visibility
  // is not enough on macOS, where a minimized or covered window still reports
  // `visible` (see `sendWindowHidden` in main).
  subscribeOsHidden?: (listener: (hidden: boolean) => void) => () => void,
): WindowActivity {
  let osHidden = false
  const read = (): WindowActivityState => {
    const visible = doc.visibilityState !== 'hidden' && !osHidden
    let focused = false
    try {
      focused = visible && doc.hasFocus()
    } catch {
      focused = visible
    }
    return { visible, focused }
  }

  let state = read()
  const listeners = new Set<(state: WindowActivityState) => void>()

  const refresh = (): void => {
    const next = read()
    if (next.visible === state.visible && next.focused === state.focused) return
    state = next
    for (const listener of [...listeners]) {
      try {
        listener(state)
      } catch (error) {
        console.warn('[windowActivity] listener failed', error)
      }
    }
  }
  const refreshAfterBlur = (): void => {
    win.setTimeout(refresh, 0)
  }

  doc.addEventListener('visibilitychange', refresh)
  win.addEventListener('focus', refresh)
  win.addEventListener('blur', refreshAfterBlur)
  const unsubscribeOsHidden = subscribeOsHidden?.((hidden) => {
    osHidden = hidden
    refresh()
  })

  return {
    get: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    dispose() {
      listeners.clear()
      unsubscribeOsHidden?.()
      doc.removeEventListener('visibilitychange', refresh)
      win.removeEventListener('focus', refresh)
      win.removeEventListener('blur', refreshAfterBlur)
    },
  }
}

const ALWAYS_ACTIVE: WindowActivity = {
  get: () => ({ visible: true, focused: true }),
  subscribe: () => () => undefined,
  dispose: () => undefined,
}

let shared: WindowActivity | null = null

/** This window's activity. Outside a browser (tests) it is always visible and focused. */
export function windowActivity(): WindowActivity {
  if (shared) return shared
  if (typeof document === 'undefined' || typeof window === 'undefined') return ALWAYS_ACTIVE
  const api = (window as { api?: { onWindowHiddenChanged?: (cb: (hidden: boolean) => void) => () => void } }).api
  shared = createWindowActivity(
    document,
    window,
    typeof api?.onWindowHiddenChanged === 'function' ? (listener) => api.onWindowHiddenChanged!(listener) : undefined,
  )
  return shared
}

/**
 * Whether this window can be seen right now. Background work that only feeds
 * what is on screen (a git poll, a relative-time clock) checks this rather than
 * `document.hidden`, which on macOS stays false for a minimized or covered
 * window.
 */
export function isWindowVisible(activity: WindowActivity = windowActivity()): boolean {
  return activity.get().visible
}

/**
 * Call `listener` each time this window goes from seen to unseen or back.
 * Focus changes alone are not reported: a window in the background is still
 * on screen, and work that pauses only while nobody can see it should not
 * restart every time the person clicks into another app. Returns the unbind.
 */
export function onWindowVisibilityChange(
  listener: (visible: boolean) => void,
  activity: WindowActivity = windowActivity(),
): () => void {
  let visible = activity.get().visible
  return activity.subscribe((state) => {
    if (state.visible === visible) return
    visible = state.visible
    listener(visible)
  })
}

/**
 * Stamp `data-window-active` on the root while the window is hidden or
 * unfocused, so CSS can pause motion nobody is watching. Returns the unbind.
 */
export function bindWindowActivityAttribute(
  root: { dataset: DOMStringMap } = document.documentElement,
  activity: WindowActivity = windowActivity(),
): () => void {
  const apply = (state: WindowActivityState): void => {
    root.dataset['windowActive'] = state.visible && state.focused ? 'true' : 'false'
  }
  apply(activity.get())
  return activity.subscribe(apply)
}

/**
 * True while this window can be seen. Going hidden is reported only after it
 * has stayed hidden for `hideGraceMs`, so a glance at another app that happens
 * to cover the window does not flip anything; becoming visible is reported at
 * once.
 */
export function useWindowPageVisible(hideGraceMs = 0, activity: WindowActivity = windowActivity()): boolean {
  const [visible, setVisible] = useState(() => activity.get().visible)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const clear = (): void => {
      if (timer === null) return
      clearTimeout(timer)
      timer = null
    }
    const apply = (state: WindowActivityState): void => {
      clear()
      if (state.visible || hideGraceMs <= 0) {
        setVisible(state.visible)
        return
      }
      timer = setTimeout(() => {
        timer = null
        if (!activity.get().visible) setVisible(false)
      }, hideGraceMs)
    }
    apply(activity.get())
    const unsubscribe = activity.subscribe(apply)
    return () => {
      clear()
      unsubscribe()
    }
  }, [activity, hideGraceMs])
  return visible
}

/** True while this window is visible and has focus. */
export function useWindowActive(activity: WindowActivity = windowActivity()): boolean {
  const [active, setActive] = useState(() => {
    const state = activity.get()
    return state.visible && state.focused
  })
  useEffect(() => {
    const apply = (state: WindowActivityState): void => setActive(state.visible && state.focused)
    apply(activity.get())
    return activity.subscribe(apply)
  }, [activity])
  return active
}
