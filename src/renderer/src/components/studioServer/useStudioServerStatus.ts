import { useEffect, useState } from 'react'

import type { StudioServerStatus } from '../../../../shared/studio-server-status'

/** The Studio server's status, read once and followed as the shell pushes changes. */
export function useStudioServerStatus(): [StudioServerStatus | null, (status: StudioServerStatus) => void] {
  const [status, setStatus] = useState<StudioServerStatus | null>(null)
  useEffect(() => {
    if (typeof window.api?.studioServerStatus !== 'function') return
    let cancelled = false
    void window.api
      .studioServerStatus()
      .then((next) => {
        if (!cancelled) setStatus(next)
      })
      .catch(() => undefined)
    const stop = window.api.onStudioServerStatus((next) => setStatus(next))
    return () => {
      cancelled = true
      stop()
    }
  }, [])
  return [status, setStatus]
}
