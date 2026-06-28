import { useEffect, useState } from 'react'

// `enabled` gates the ticking interval so callers behind a transient surface
// (e.g. a closed popover) don't pay an idle re-render. When it flips back to
// true the value refreshes immediately, so a long-paused source isn't stale on
// resume. Defaults to true, leaving always-on callers unchanged.
export function useRelativeNow(intervalMs = 30_000, enabled = true): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!enabled) return undefined
    setNow(Date.now())
    const id = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(id)
  }, [intervalMs, enabled])
  return now
}
