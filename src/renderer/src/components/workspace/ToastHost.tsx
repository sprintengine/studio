import { useEffect, useRef } from 'react'

import { ToastRegion } from '../ui/ToastRegion'
import { showToast, useToastStore } from '../../store/toastStore'
import { isPairRequestTerminalPhase } from '../../../../shared/tailnet'

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
// and RETRACTED on every terminal phase (approved, denied, expired, or
// cancelled because the listener stopped): a toast inviting review of a
// request that no longer exists would be the one kind of stale this channel
// exists to prevent. A toast the person already dismissed stays dismissed;
// nothing resurrects. The comparison code never rides here — it belongs
// beside the compare instruction. The toast's id is the REQUEST's, so a
// repeat announcement replaces in place and the retraction cannot orphan.
function usePairRequestToastBridge(): void {
  const announced = useRef(new Set<string>())
  useEffect(() => {
    if (typeof window.api.onTailnetEvent !== 'function') return
    return window.api.onTailnetEvent((payload) => {
      const event = payload.event
      if (event.kind !== 'pair-request') return
      const toastId = pairRequestToastId(event.requestId)
      if (event.phase === 'received') {
        if (announced.current.has(event.requestId)) return
        announced.current.add(event.requestId)
        // The transport-proven node first, the self-declared name second —
        // the approver should recognise the machine before the label it chose.
        showToast({
          id: toastId,
          tone: 'warn',
          title: `Pair request from ${event.peerNode ?? event.deviceName}`,
          description:
            event.peerNode && event.peerNode !== event.deviceName
              ? `Calls itself “${event.deviceName}”. Review it from the Remote glyph or Settings → Remote.`
              : 'Review it from the Remote glyph or Settings → Remote.',
        })
        return
      }
      if (isPairRequestTerminalPhase(event.phase) && announced.current.delete(event.requestId)) {
        useToastStore.getState().dismissToast(toastId)
      }
    })
  }, [])
}

export function pairRequestToastId(requestId: string): string {
  return `pair-request:${requestId}`
}

export function fleetLossToastId(connectionId: string): string {
  return `fleet:${connectionId}`
}

function useFleetToastBridge(): void {
  // Per-connection link memory, so N panes on one machine make one
  // announcement per outage, not N — and recovery is only news after one.
  // The loss toast is keyed by the CONNECTION so recovery RETRACTS it: a
  // persistent "Reconnecting." standing over a fresh "Reconnected" would
  // contradict itself, and warn tones never auto-dismiss on their own.
  const lostConnections = useRef(new Set<string>())

  useEffect(() => {
    if (typeof window.api.onFleetEvent !== 'function') return
    const retract = (connectionId: string): boolean => {
      const hadLoss = lostConnections.current.delete(connectionId)
      if (hadLoss) useToastStore.getState().dismissToast(fleetLossToastId(connectionId))
      return hadLoss
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
          if (lostConnections.current.has(event.connectionId)) return
          lostConnections.current.add(event.connectionId)
          showToast({
            id: fleetLossToastId(event.connectionId),
            tone: 'warn',
            title: `Connection to ${event.machineName} lost`,
            description: 'Reconnecting.',
          })
          return
        }
        if (event.state === 'live' && retract(event.connectionId)) {
          showToast({ tone: 'good', title: `Reconnected to ${event.machineName}` })
        }
        // A pane closing for good ends the outage story for its machine
        // only if no other pane is still hoping; that pane's next `offline`
        // announces afresh, which is the honest sequence.
        if (event.state === 'closed') retract(event.connectionId)
      }
    })
  }, [])
}
