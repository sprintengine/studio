import { useEffect, type RefObject } from 'react'
import { isWindowVisible, onWindowVisibilityChange } from '../../../utils/windowActivity'

type Listener = { inView: boolean; callback: (visible: boolean) => void }
const listeners = new Map<Element, Listener>()
let observer: IntersectionObserver | undefined
let unsubscribeVisibility: (() => void) | undefined
function reportVisibility() {
  for (const listener of listeners.values()) listener.callback(listener.inView && isWindowVisible())
}

// A live transcript row that loops (the shimmer, a working mark, an agent
// character, a pulse) holds still while it is off screen or the window is
// hidden. The row only says so, with `data-live-offscreen`; the stylesheet's
// one pause rule (index.css) decides, alongside the window-idle, hidden-layer
// and inert conditions, and reduced motion stops the loops there too. Nothing
// here writes `animation-play-state`: an inline `running` would beat that rule
// and keep the row moving in an unfocused window, and an inline value set
// once would miss a looping part that mounts inside the row afterwards.
const LIVE_OFFSCREEN_ATTRIBUTE = 'data-live-offscreen'

export function useLiveRowMotion(ref: RefObject<HTMLElement | null>, running: boolean): void {
  useEffect(() => {
    const element = ref.current
    if (!running || !element) return
    const dispose = observeLiveVisibility(element, (visible) => {
      element.toggleAttribute(LIVE_OFFSCREEN_ATTRIBUTE, !visible)
    })
    return () => {
      dispose()
      element.removeAttribute(LIVE_OFFSCREEN_ATTRIBUTE)
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
