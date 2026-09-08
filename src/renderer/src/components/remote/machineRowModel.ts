import type { FleetLiveAttachment, FleetLinkState, FleetMachineReachability } from '../../../../shared/tailnet-fleet'
import { since } from './peerPickerModel'

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
  if (reach.unauthorized) return { phase: 'revoked', detail: reach.detail ?? 'This device was revoked over there.' }
  if (reach.checking && reach.checkedAt === null) return { phase: 'checking' }
  if (reach.checkedAt === null) return { phase: 'paired' }
  if (reach.reachable) return { phase: 'reachable', checkedAt: reach.checkedAt }
  return { phase: 'unreachable', detail: reach.detail ?? 'Not answering.', lastReachedAt: reach.lastReachedAt }
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
      // Nothing (owner ruling 2026-09-05): the green glyph is the whole
      // message, and when the check ran is not a fact anyone acts on.
      return ''
    case 'unreachable':
      // How long it has been silent, not a second clause about when it last
      // was not: the state is already named, and the row has a Retry and a
      // Disconnect to fit beside it.
      return phase.lastReachedAt ? `not answering · ${since(phase.lastReachedAt, now)}` : 'not answering · never reached'
    case 'revoked':
      return 'revoked there — pair again to reconnect'
  }
}

/**
 * The machine glyph's ink, which is the row's whole status vocabulary (owner
 * ruling 2026-09-05: no status dots in the Remote popover — the glyph is
 * green when the machine answers and the default ink when it does not).
 * Transitional phases keep the default ink too: the text beside the name
 * says "connecting…", and a colour for "almost" is a colour nobody reads.
 */
export function machineGlyphToneClass(phase: FleetMachinePhase): string {
  return phase.phase === 'connected' || phase.phase === 'reachable' ? 'text-[color:var(--tone-good)]' : 'text-[color:var(--text-subtle)]'
}

/** Whether a phase means the machine is answering right now — what the top bar's count adds up. */
export function machineIsAnswering(phase: FleetMachinePhase): boolean {
  return phase.phase === 'connected' || phase.phase === 'reachable'
}

/** Which row action a phase earns: Retry for a machine that stopped answering, Pair again for one that revoked us. */
export function machineRowAction(phase: FleetMachinePhase): 'retry' | 'pair-again' | null {
  if (phase.phase === 'revoked') return 'pair-again'
  if (phase.phase === 'unreachable' || phase.phase === 'offline') return 'retry'
  return null
}

/**
 * The name a row shows for a machine. A tailnet FQDN
 * (`sam-macbook-air.tailabc123.ts.net`) is one machine's name plus a tail
 * that is the same on every row — it pushes the part a person reads out of a
 * narrow row and into an ellipsis. The first label is the name; anything
 * without a dotted tail is left exactly as it was typed.
 */
export function shortMachineName(name: string): string {
  const trimmed = name.trim()
  // Only a hostname is shortened, and only when the whole string is one:
  // "Sam's MacBook Air. Studio" is a typed name with a full stop in it, and
  // "100.106.119.1" is an address — a first label from either would be a lie.
  if (!/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/u.test(trimmed)) return trimmed
  if (/^\d+(?:\.\d+)+$/u.test(trimmed)) return trimmed
  return trimmed.split('.')[0] ?? trimmed
}

/** The shape the driven-terminal lookup needs from a terminal-session snapshot. */
export type DrivenTerminalSession = {
  sessionId: string
  workspaceId?: string
  agentId?: string
  agentName?: string
}

/**
 * What a phone is driving, in words a person can act on: the agent's name and
 * the tab to open, resolved from the terminal session id the gateway reports.
 *
 * The id itself is never the answer — `ae260b2f-…` is the one thing on the row
 * nobody can read (owner ruling 2026-09-05). A session the app cannot place
 * (a plain terminal, or one already gone) still gets a line: what it says is
 * "a terminal", not a truncated uuid pretending to be a name.
 */
export function drivenTerminalView(
  sessionId: string,
  sessions: readonly DrivenTerminalSession[],
  agentName: (workspaceId: string, agentId: string) => string | null
): { label: string; target: { workspaceId: string; agentId: string } | null } {
  const session = sessions.find((candidate) => candidate.sessionId === sessionId)
  if (!session?.workspaceId || !session.agentId) {
    return { label: session?.agentName?.trim() || 'a terminal', target: null }
  }
  const named = agentName(session.workspaceId, session.agentId)?.trim()
  return {
    label: named || session.agentName?.trim() || 'an agent',
    target: { workspaceId: session.workspaceId, agentId: session.agentId },
  }
}
