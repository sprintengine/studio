import { useCallback, useRef, useState } from 'react'

export const FOLLOW_END_DISTANCE = 48
export function isNearConversationEnd(offset: number, content: number, viewport: number): boolean {
  return content - offset - viewport < FOLLOW_END_DISTANCE
}

/** Shared follow state for DOM scrollers; virtual lists can feed native metrics. */
export function useStickToBottom(initialAtEnd = true) {
  const [atBottom, setAtBottom] = useState(initialAtEnd)
  const atBottomRef = useRef(initialAtEnd)
  const observeScroll = useCallback((offset: number, content: number, viewport: number) => {
    const nearBottom = isNearConversationEnd(offset, content, viewport)
    atBottomRef.current = nearBottom
    setAtBottom(nearBottom)
  }, [])
  const onScroll = useCallback(
    (element: HTMLElement) => observeScroll(element.scrollTop, element.scrollHeight, element.clientHeight),
    [observeScroll],
  )
  const followEnd = useCallback((element: HTMLElement, animated = true) => {
    if (!atBottomRef.current) return
    element.scrollTo({
      top: element.scrollHeight,
      behavior: animated && !window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'smooth' : 'instant',
    })
  }, [])
  return { atBottom, atBottomRef, setAtBottom, observeScroll, onScroll, followEnd }
}
