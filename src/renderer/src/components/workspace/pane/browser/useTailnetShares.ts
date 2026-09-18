import { useCallback, useEffect, useRef, useState } from 'react'

import { EMPTY_TAILNET_SHARE_STATUS, type TailnetShareStatus } from '../../../../../../shared/tailnet-share'

// Which of this machine's dev servers are published on the tailnet.
//
// Read, never remembered. `tailscale serve` config lives in the daemon and
// outlives the app, so a person can turn a share off from a terminal and this
// surface has to notice. Every mutation re-reads, and the status comes back
// attached to the result so a share and the list it changed can never disagree.
//
// Polled only alongside the local-server poll on the start page — the same
// "only while someone is looking at it" rule, for the same reason.

export type TailnetShares = {
  status: TailnetShareStatus
  /** The tailnet URL for a loopback port, or null when it is not shared. */
  urlFor: (localPort: number) => string | null
  servePortFor: (localPort: number) => number | null
  /** In flight, so a row can disable its action without a spinner per row. */
  busyPort: number | null
  share: (localPort: number) => Promise<{ ok: boolean; message: string; url: string | null }>
  unshare: (localPort: number) => Promise<{ ok: boolean; message: string }>
}

export function useTailnetShares(active: boolean, pollMs: number): TailnetShares {
  const [status, setStatus] = useState<TailnetShareStatus>(EMPTY_TAILNET_SHARE_STATUS)
  const [busyPort, setBusyPort] = useState<number | null>(null)
  // A mutation's fresh status must not be overwritten by a poll that was
  // already in flight when it landed.
  const generation = useRef(0)

  useEffect(() => {
    if (!active) return
    let cancelled = false
    let timer: number | null = null
    const poll = async () => {
      if (document.visibilityState !== 'hidden') {
        const mine = ++generation.current
        try {
          const next = await window.api.tailnetShareStatus()
          if (!cancelled && generation.current === mine) setStatus(next)
        } catch {
          if (!cancelled && generation.current === mine) setStatus(EMPTY_TAILNET_SHARE_STATUS)
        }
      }
      if (!cancelled) timer = window.setTimeout(() => void poll(), pollMs)
    }
    void poll()
    return () => {
      cancelled = true
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [active, pollMs])

  const urlFor = useCallback(
    (localPort: number) => status.shares.find((share) => share.localPort === localPort)?.url ?? null,
    [status],
  )
  const servePortFor = useCallback(
    (localPort: number) => status.shares.find((share) => share.localPort === localPort)?.servePort ?? null,
    [status],
  )

  const share = useCallback(async (localPort: number) => {
    setBusyPort(localPort)
    try {
      const result = await window.api.tailnetSharePort(localPort)
      generation.current += 1
      setStatus(result.status)
      return result.ok
        ? { ok: true, message: '', url: result.share?.url ?? null }
        : { ok: false, message: result.message, url: null }
    } catch {
      return { ok: false, message: 'Studio could not reach Tailscale on this machine.', url: null }
    } finally {
      setBusyPort(null)
    }
  }, [])

  const unshare = useCallback(
    async (localPort: number) => {
      const servePort = servePortFor(localPort)
      if (servePort === null) return { ok: true, message: '' }
      setBusyPort(localPort)
      try {
        const result = await window.api.tailnetUnsharePort(servePort)
        generation.current += 1
        setStatus(result.status)
        return result.ok ? { ok: true, message: '' } : { ok: false, message: result.message }
      } catch {
        return { ok: false, message: 'Studio could not reach Tailscale on this machine.' }
      } finally {
        setBusyPort(null)
      }
    },
    [servePortFor],
  )

  return { status, urlFor, servePortFor, busyPort, share, unshare }
}
