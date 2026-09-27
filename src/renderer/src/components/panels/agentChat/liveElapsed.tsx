import { useEffect, useRef } from 'react'
import { observeLiveVisibility } from './liveVisibility'

// Seconds since a step started, ticking once a second only while the row is on
// screen in a visible window. It writes the text node directly so a tick never
// re-renders the transcript.
export function LiveElapsed({ startedAt }: { startedAt: number }) {
  const textRef = useRef<HTMLSpanElement | null>(null)
  const initial = formatElapsedMs(Date.now() - startedAt)
  useEffect(() => {
    const update = () => {
      if (textRef.current) textRef.current.textContent = formatElapsedMs(Date.now() - startedAt)
    }
    const element = textRef.current
    if (!element) return
    let timer: number | undefined
    const stop = observeLiveVisibility(element, (visible) => {
      if (timer !== undefined) window.clearInterval(timer)
      timer = undefined
      if (visible) {
        update()
        timer = window.setInterval(update, 1000)
      }
    })
    return () => {
      stop()
      if (timer !== undefined) window.clearInterval(timer)
    }
  }, [startedAt])
  return <span ref={textRef}>{initial}</span>
}

function formatElapsedMs(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  return `${minutes}m ${remainingSeconds}s`
}

export function formatClockTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}
