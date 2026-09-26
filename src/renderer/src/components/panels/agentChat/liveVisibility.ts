import { useEffect, type RefObject } from 'react'

type Listener = { inView: boolean; callback: (visible: boolean) => void }
const listeners = new Map<Element, Listener>()
let observer: IntersectionObserver | undefined
function reportVisibility() {
  for (const listener of listeners.values()) listener.callback(listener.inView && !document.hidden)
}

export function useLiveRowMotion(ref: RefObject<HTMLElement | null>, running: boolean): void {
  useEffect(() => {
    const element = ref.current
    if (!running || !element) return
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    let visible = !document.hidden
    const update = () => {
      for (const animated of element.querySelectorAll<HTMLElement>('.status-dot-pulse, .chat-shimmer'))
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
    document.addEventListener('visibilitychange', reportVisibility)
    if (typeof IntersectionObserver !== 'undefined')
      observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          const listener = listeners.get(entry.target)
          if (listener) {
            listener.inView = entry.isIntersecting
            listener.callback(entry.isIntersecting && !document.hidden)
          }
        }
      })
  }
  listeners.set(element, { inView: true, callback })
  observer?.observe(element)
  callback(!document.hidden)
  return () => {
    observer?.unobserve(element)
    listeners.delete(element)
    if (listeners.size === 0) {
      observer?.disconnect()
      observer = undefined
      document.removeEventListener('visibilitychange', reportVisibility)
    }
  }
}
