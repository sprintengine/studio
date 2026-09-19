import { useEffect, useRef } from 'react'

import { ToastRegion } from '../ui/ToastRegion'
import { showToast, useToastStore } from '../../store/toastStore'
import { isPairRequestTerminalPhase } from '../../../../shared/tailnet'
import { PairRequestToastAccept } from '../remote/PairRequestToastAccept'
import { shortMachineName } from '../remote/machineRowModel'

// The main window's toast host: mounts the one region and runs the app-level
// producers that have no pane of their own (MC: remote-sessions-ux /
// toast-host-region). Pane-owned producers call `showToast` directly.
//
// First producers: remote connection lifecycle. Per the toast spec these
// announce and never act — pairing state stays readable in Settings → Remote
// and the top bar's Remote glyph, link state on the pane itself.
export function ToastHost() {
  useFleetToastBridge()
  usePairRequestToastBridge()
  useListenerToastBridge()
  return <ToastRegion />
}

// A pair request has a five-minute TTL and — since the owner ruling of
// 2026-09-05 — is ANSWERED where it arrives: the toast carries the code field
// and the two answers (`PairRequestToastAccept`), because the person reading
// it is standing in front of the screen showing the digits, and sending them
// to another surface to type six numbers was the whole friction. Warn, so it
// persists — and RETRACTED on every terminal phase (approved, denied,
// expired, or cancelled because the listener stopped): a toast offering to
// answer a request that no longer exists would be the one kind of stale this
// channel exists to prevent. A toast the person already dismissed stays
// dismissed; nothing resurrects. The comparison code never rides here — it is
// typed in, never shown. The toast's id is the REQUEST's, so a repeat
// announcement replaces in place and the retraction cannot orphan.
//
// Scope choices stay on the card in the Remote popover: Allow here grants the
// defaults, terminal control excluded.
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
        // The transport-proven node names the toast, shortened to the label a
        // person reads (the tailnet tail is the same on every machine). The
        // full identity, and the name the asker gave itself, stay on the card
        // — the surface for looking a request over rather than answering it.
        const request = (payload.status?.pairRequests ?? []).find((waiting) => waiting.id === event.requestId) ?? null
        showToast({
          id: toastId,
          tone: 'warn',
          title: `Pair request from ${shortMachineName(event.peerNode ?? event.deviceName)}`,
          // No body without the request itself: a code field that cannot name
          // what it is answering would be worse than the pointer it replaced.
          content: request ? <PairRequestToastAccept request={request} /> : undefined,
          description: request ? undefined : 'Answer it from the Remote glyph.',
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

export const LISTENER_TOAST_ID = 'tailnet-listener'

/**
 * The inbound listener falling over, announced where a person is working.
 *
 * Quitting Tailscale stands the listener down (tailnet-service's interface
 * heartbeat), and until now the only way to learn that was to open the Remote
 * glyph — a phone would just stop being able to reach this device. Warn, so it
 * persists, and RETRACTED the moment the listener binds again, with the
 * recovery announced only if a loss was: the fleet bridge's rule, for the same
 * reason.
 *
 * Only a failure speaks. `running: false` with no reason is someone turning
 * remote control off, and announcing a thing the person just did is furniture.
 */
function useListenerToastBridge(): void {
  const stopped = useRef(false)
  useEffect(() => {
    if (typeof window.api.onTailnetEvent !== 'function') return
    return window.api.onTailnetEvent((payload) => {
      const event = payload.event
      if (event.kind !== 'listener') return
      if (!event.running) {
        if (!event.error || stopped.current) return
        stopped.current = true
        showToast({
          id: LISTENER_TOAST_ID,
          tone: 'warn',
          title: 'Remote stopped serving',
          // Main's own words: the reason a listener is down is the whole
          // content of the report, and the Remote popover shows the same line.
          description: event.error,
        })
        return
      }
      if (!stopped.current) return
      stopped.current = false
      useToastStore.getState().dismissToast(LISTENER_TOAST_ID)
      showToast({ tone: 'good', title: 'Remote is serving again' })
    })
  }, [])
}

export function fleetLossToastId(connectionId: string): string {
  return `fleet:${connectionId}`
}

export function fleetRevokedToastId(connectionId: string): string {
  return `fleet-revoked:${connectionId}`
}

function useFleetToastBridge(): void {
  // Per-connection link memory, so N panes on one machine make one
  // announcement per outage, not N — and recovery is only news after one.
  // The loss toast is keyed by the CONNECTION so recovery RETRACTS it: a
  // persistent "Reconnecting." standing over a fresh "Reconnected" would
  // contradict itself, and warn tones never auto-dismiss on their own.
  const lostConnections = useRef(new Set<string>())
  // Machines that revoked us, announced once each until they answer again.
  const revokedConnections = useRef(new Set<string>())

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
        if (revokedConnections.current.delete(event.connectionId)) {
          useToastStore.getState().dismissToast(fleetRevokedToastId(event.connectionId))
        }
        showToast({
          tone: 'neutral',
          title: 'Machine removed',
          description: `${event.machineName} was removed from your fleet.`,
        })
        return
      }
      if (event.kind === 'pair-request') {
        // `approved` is announced by the `machine-paired` that precedes it;
        // `waiting` and `cancelled` have the card as their surface. The three
        // answers a person may have walked away from get a toast each.
        const machine = event.request.machineName
        if (event.phase === 'denied') {
          showToast({
            tone: 'error',
            title: `${machine} declined`,
            description: event.detail ?? 'Someone there said no.',
          })
        } else if (event.phase === 'expired') {
          showToast({
            tone: 'neutral',
            title: `${machine} did not answer in time`,
            description: 'Ask again when someone is at it.',
          })
        } else if (event.phase === 'failed') {
          showToast({
            tone: 'error',
            title: `Pairing with ${machine} did not complete`,
            description: event.detail ?? '',
          })
        }
        return
      }
      if (event.kind === 'machine-reachability') {
        // Revoked over there is the one reachability answer worth a toast:
        // it will not fix itself. Warn, so it persists; retracted the moment
        // the machine answers again (a re-pair), never re-raised per retry.
        const toastId = fleetRevokedToastId(event.connectionId)
        if (event.unauthorized) {
          if (revokedConnections.current.has(event.connectionId)) return
          revokedConnections.current.add(event.connectionId)
          showToast({
            id: toastId,
            tone: 'warn',
            title: `${event.machineName} revoked this device`,
            description: 'Its pairing was taken back over there. Pair again from the Fleet when you want it back.',
          })
        } else if (event.reachable && revokedConnections.current.delete(event.connectionId)) {
          useToastStore.getState().dismissToast(toastId)
        }
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
