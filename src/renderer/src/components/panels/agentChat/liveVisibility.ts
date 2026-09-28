import { useEffect, type RefObject } from 'react'
import { isWindowVisible, onWindowVisibilityChange } from '../../../utils/windowActivity'

type Listener = { inView: boolean; callback: (visible: boolean) => void }
const listeners = new Map<Element, Listener>()
let observer: IntersectionObserver | undefined
let unsubscribeVisibility: (() => void) | undefined
function reportVisibility() {
  for (const listener of listeners.values()) listener.callback(listener.inView && isWindowVisible())
}

// Everything in a live transcript row that loops: held still while the row is
// off screen, the window is idle, or motion is reduced.
const LIVE_MOTION_SELECTOR = [
  '.status-dot-pulse',
  '.chat-shimmer',
  '.working-mark__cell',
  '.agent-glyph [class^="agent-glyph__"]',
].join(', ')

export function useLiveRowMotion(ref: RefObject<HTMLElement | null>, running: boolean): void {
  useEffect(() => {
    const element = ref.current
    if (!running || !element) return
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    let visible = isWindowVisible()
    const update = () => {
      for (const animated of element.querySelectorAll<HTMLElement>(LIVE_MOTION_SELECTOR))
        animated.style.animationPlayState = visible && !media?.matches ? 'running' : 'paused'
    }
    const dispose = observeLiveVisibility(element, (next) => {
      visible = next
      update()
    })
    media?.addEventListener('change', update)
    return () => {
      dispose()
      media?.removeEventListener('change', update)
    }
  }, [ref, running])
}

/** One observer and one visibility listener cover every mounted live transcript row. */
export function observeLiveVisibility(element: Element, callback: (visible: boolean) => void): () => void {
  if (listeners.size === 0) {
    unsubscribeVisibility = onWindowVisibilityChange(reportVisibility)
    if (typeof IntersectionObserver !== 'undefined')
      observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          const listener = listeners.get(entry.target)
          if (listener) {
            listener.inView = entry.isIntersecting
            listener.callback(entry.isIntersecting && isWindowVisible())
          }
        }
      })
  }
  listeners.set(element, { inView: true, callback })
  observer?.observe(element)
  callback(isWindowVisible())
  return () => {
    observer?.unobserve(element)
    listeners.delete(element)
    if (listeners.size === 0) {
      observer?.disconnect()
      observer = undefined
      unsubscribeVisibility?.()
      unsubscribeVisibility = undefined
    }
  }
}
