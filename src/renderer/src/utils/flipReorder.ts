import { useLayoutEffect, useRef, type RefObject } from 'react'

export function useFlipReorder(listRef: RefObject<HTMLElement | null>, dependency: unknown): void {
  const previousRectsRef = useRef<Map<string, DOMRect>>(new Map())

  useLayoutEffect(() => {
    const list = listRef.current
    if (!list) return

    const elements = Array.from(list.querySelectorAll<HTMLElement>('[data-flip-key]'))
    const newRects = new Map<string, DOMRect>()

    for (const element of elements) {
      const key = element.getAttribute('data-flip-key')
      if (!key) continue
      newRects.set(key, element.getBoundingClientRect())
    }

    for (const element of elements) {
      const key = element.getAttribute('data-flip-key')
      if (!key) continue
      const oldRect = previousRectsRef.current.get(key)
      const newRect = newRects.get(key)
      if (!oldRect || !newRect) continue
      const dx = oldRect.left - newRect.left
      const dy = oldRect.top - newRect.top
      if (dx === 0 && dy === 0) continue
      element.style.transform = `translate(${dx}px, ${dy}px)`
      element.style.transition = 'transform 0s'
      requestAnimationFrame(() => {
        element.style.transform = ''
        element.style.transition = 'transform 180ms cubic-bezier(0.2, 0.8, 0.2, 1)'
      })
    }

    previousRectsRef.current = newRects
  }, [dependency, listRef])
}
