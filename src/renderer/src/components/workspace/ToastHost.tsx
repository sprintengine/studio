import { useEffect, useRef } from 'react'

import { ToastRegion } from '../ui/ToastRegion'
import { showToast, useToastStore } from '../../store/toastStore'

// The main window's toast host: mounts the one region and runs the app-level
// producers that have no pane of their own (MC: remote-sessions-ux /
// toast-host-region). Pane-owned producers call `showToast` directly.
//
// First producers: fleet connection lifecycle. Per the toast spec these
// announce and never act — pairing state stays readable in Settings → Remote
// and the Fleet panel, link state on the pane itself.
export function ToastHost() {
  useFleetToastBridge()
  usePairRequestToastBridge()
  return <ToastRegion />
}

// A pair request has a five-minute TTL and an acting surface (the Remote
// popover's card, and Settings → Remote); the toast only announces
// (remote-sessions-ux / incoming-pair-request-prompt). Warn, so it persists —
// and RETRACTED when the request resolves from any surface or expires: a
// toast inviting review of a request that no longer exists would be the one
// kind of stale this channel exists to prevent. A toast the person already
// dismissed stays dismissed; nothing resurrects. The comparison code never
// rides here — it belongs beside the compare instruction.
function usePairRequestToastBridge(): void {
  const toastByRequestId = useRef(new Map<string, string>())
  useEffect(() => {
    if (typeof window.api.onTailnetEvent !== 'function') return
    return window.api.onTailnetEvent((payload) => {
      const event = payload.event
      if (event.kind !== 'pair-request') return
      if (event.phase === 'received') {
        if (toastByRequestId.current.has(event.requestId)) return
        const toastId = showToast({
          tone: 'warn',
          title: `Pair request from ${event.deviceName}`,
          description: 'Review it from the Remote glyph or Settings → Remote.',
        })
        toastByRequestId.current.set(event.requestId, toastId)
        return
      }
      const toastId = toastByRequestId.current.get(event.requestId)
      if (toastId) {
        toastByRequestId.current.delete(event.requestId)
        useToastStore.getState().dismissToast(toastId)
      }
    })
  }, [])
}

function useFleetToastBridge(): void {
  // Per-connection link memory, so N panes on one machine make one
  // announcement per outage, not N — and recovery is only news after one.
  // The warn toast's id is kept so recovery RETRACTS it: a persistent
  // "Reconnecting." standing over a fresh "Reconnected" would contradict
  // itself, and warn tones never auto-dismiss on their own.
  const offlineToastByConnection = useRef(new Map<string, string>())

  useEffect(() => {
    if (typeof window.api.onFleetEvent !== 'function') return
    const retract = (connectionId: string): boolean => {
      const toastId = offlineToastByConnection.current.get(connectionId)
      offlineToastByConnection.current.delete(connectionId)
      if (toastId) useToastStore.getState().dismissToast(toastId)
      return toastId !== undefined
    }
    return window.api.onFleetEvent((event) => {
      if (event.kind === 'machine-paired') {
        showToast({
          tone: 'good',
          title: 'Machine paired',
          description: `${event.connection.machineName} is in your fleet.`,
        })
        return
      }
      if (event.kind === 'machine-forgotten') {
        retract(event.connectionId)
        showToast({
          tone: 'neutral',
          title: 'Machine removed',
          description: `${event.machineName} was removed from your fleet.`,
        })
        return
      }
      if (event.kind === 'attachment') {
        if (event.state === 'offline') {
          if (offlineToastByConnection.current.has(event.connectionId)) return
          offlineToastByConnection.current.set(
            event.connectionId,
            showToast({
              tone: 'warn',
              title: `Connection to ${event.machineName} lost`,
              description: 'Reconnecting.',
            })
          )
          return
        }
        if (event.state === 'live' && retract(event.connectionId)) {
          showToast({ tone: 'good', title: `Reconnected to ${event.machineName}` })
        }
        if (event.state === 'closed') retract(event.connectionId)
      }
    })
  }, [])
}
