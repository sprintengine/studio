import type { FleetLiveAttachment, FleetLinkState, FleetMachineReachability } from '../../../../shared/tailnet-fleet'
import type { StatusTone } from '../ui/tokens'
import { ago } from './peerPickerModel'

// A paired machine's row, wherever one is drawn (the Remote popover, the
// Fleet, Settings): its phase from the links this app holds to it, and —
// when it holds none — from main's reachability check (phase 4). A live pane
// still wins: it is a stronger fact than a probe that ran a minute ago.

export type FleetMachinePhase =
  | { phase: 'paired' }
  | { phase: 'checking' }
  | { phase: 'reachable'; checkedAt: number }
  | { phase: 'unreachable'; detail: string; lastReachedAt: number | null }
  | { phase: 'revoked'; detail: string }
  | { phase: 'connecting'; detail: string }
  | { phase: 'reconnecting'; detail: string }
  | { phase: 'offline'; detail: string }
  | { phase: 'connected'; liveSessions: number }

export function fleetMachinePhase(
  connectionId: string,
  attachments: ReadonlyMap<string, FleetLiveAttachment>,
  reachability?: ReadonlyMap<string, FleetMachineReachability>
): FleetMachinePhase {
  const mine = [...attachments.values()].filter((attachment) => attachment.connectionId === connectionId)
  const liveSessions = new Set(mine.filter((a) => a.state === 'live').map((a) => a.sessionId))
  if (liveSessions.size > 0) return { phase: 'connected', liveSessions: liveSessions.size }
  const first = (state: FleetLinkState): FleetLiveAttachment | undefined => mine.find((a) => a.state === state)
  const reconnecting = first('reconnecting')
  if (reconnecting) return { phase: 'reconnecting', detail: reconnecting.detail }
  const connecting = first('connecting')
  if (connecting) return { phase: 'connecting', detail: connecting.detail }
  const offline = first('offline')
  if (offline) return { phase: 'offline', detail: offline.detail }
  const reach = reachability?.get(connectionId)
  if (!reach) return { phase: 'paired' }
  if (reach.unauthorized) return { phase: 'revoked', detail: reach.detail ?? 'This Mac was revoked over there.' }
  if (reach.checking && reach.checkedAt === null) return { phase: 'checking' }
  if (reach.checkedAt === null) return { phase: 'paired' }
  if (reach.reachable) return { phase: 'reachable', checkedAt: reach.checkedAt }
  return { phase: 'unreachable', detail: reach.detail ?? 'Not answering.', lastReachedAt: reach.lastReachedAt }
}

/** The status dot each machine phase draws, in our tones: good steady, warn with a halo while transitional, error when the peer stopped answering or revoked us, muted otherwise. */
export const MACHINE_PHASE_DOT: Record<FleetMachinePhase['phase'], { tone: StatusTone; pulse: boolean; label: string }> = {
  connected: { tone: 'good', pulse: false, label: 'Connected' },
  connecting: { tone: 'warn', pulse: true, label: 'Connecting' },
  reconnecting: { tone: 'warn', pulse: true, label: 'Reconnecting' },
  offline: { tone: 'error', pulse: false, label: 'Not answering' },
  paired: { tone: 'neutral', pulse: false, label: 'Paired' },
  checking: { tone: 'neutral', pulse: true, label: 'Checking' },
  reachable: { tone: 'good', pulse: false, label: 'Reachable' },
  unreachable: { tone: 'neutral', pulse: false, label: 'Not answering' },
  revoked: { tone: 'error', pulse: false, label: 'Revoked there' },
}

export function machinePhaseText(machineName: string, phase: FleetMachinePhase, now: number): string {
  switch (phase.phase) {
    case 'connected':
      return phase.liveSessions === 1 ? 'a terminal attached' : `${phase.liveSessions} terminals attached`
    case 'connecting':
      return `Connecting to ${machineName}…`
    case 'reconnecting':
      return `Reconnecting to ${machineName}…`
    case 'offline':
      return `${machineName} is not answering`
    case 'paired':
      return 'paired'
    case 'checking':
      return 'checking…'
    case 'reachable':
      return `reachable · checked ${ago(phase.checkedAt, now)}`
    case 'unreachable':
      return phase.lastReachedAt ? `not answering · last reached ${ago(phase.lastReachedAt, now)}` : 'not answering · never reached'
    case 'revoked':
      return 'revoked there — pair again to reconnect'
  }
}

/** Which row action a phase earns: Retry for a machine that stopped answering, Pair again for one that revoked us. */
export function machineRowAction(phase: FleetMachinePhase): 'retry' | 'pair-again' | null {
  if (phase.phase === 'revoked') return 'pair-again'
  if (phase.phase === 'unreachable' || phase.phase === 'offline') return 'retry'
  return null
}
