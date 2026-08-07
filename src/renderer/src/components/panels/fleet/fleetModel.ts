import type {
  FleetBrowse,
  FleetConnection,
  FleetLinkState,
  FleetTerminal,
  FleetTerminalAccess,
} from '../../../../../shared/tailnet-fleet'
import type { Tone } from '../../ui'

// The Fleet surface's view model, DOM-free so the rules that matter can be
// tested without mounting anything.
//
// Two rules carry the weight:
//
//  1. **A remote pane always says whose machine it is.** Provenance is not
//     decoration here: the same keystroke means different things on two
//     machines, and a pane that looks local while driving another computer is
//     the failure mode this feature has to not have.
//  2. **Watch-only looks watch-only before you type.** An observe-scoped
//     pairing has its input refused at the far end anyway (the listener drops
//     the frame), but a person must not have to discover that by typing into a
//     terminal that silently ignores them.

export type FleetLinkBadge = {
  label: string
  tone: Tone
  /** One sentence for the pane's status line; null when there is nothing to add. */
  detail: string | null
}

/**
 * How a remote pane badges its link.
 *
 * `offline` is deliberately calm — a sleeping laptop is the common case, not an
 * error — while a link that is still trying says so, because those are
 * different things to wait for.
 */
export function fleetLinkBadge(state: FleetLinkState, detail: string | null): FleetLinkBadge {
  switch (state) {
    case 'connecting':
      return { label: 'Connecting', tone: 'neutral', detail }
    case 'live':
      return { label: 'Live', tone: 'good', detail: null }
    case 'reconnecting':
      return { label: 'Reconnecting', tone: 'warn', detail: detail ?? 'The connection dropped. Retrying.' }
    case 'offline':
      return {
        label: 'Not answering',
        tone: 'neutral',
        detail: detail ?? 'That machine is not answering. This pane reconnects when it comes back.',
      }
    case 'closed':
      return { label: 'Ended', tone: 'neutral', detail }
  }
}

export type FleetInputState = {
  /** Whether keystrokes should reach the remote pty at all. */
  canType: boolean
  /** What the pane says about typing. Null when input is simply live. */
  label: string | null
}

/**
 * Whether this pane may type, and what it says when it may not.
 *
 * The two refusals are different and are worded differently: watch-only is a
 * decision someone made about this pairing and will not change by waiting,
 * while a dropped link is temporary and will.
 */
export function fleetInputState(access: FleetTerminalAccess, link: FleetLinkState): FleetInputState {
  if (access !== 'control') {
    return {
      canType: false,
      label: 'Watch only — this pairing was not granted terminal control.',
    }
  }
  if (link === 'live') return { canType: true, label: null }
  if (link === 'closed') return { canType: false, label: 'This terminal has ended.' }
  return { canType: false, label: 'Not connected — keystrokes are not being sent.' }
}

/** A machine row's secondary line: what it grants, and when we last reached it. */
export function fleetConnectionSummary(
  connection: FleetConnection,
  formatDate: (value: string) => string
): string {
  const terminals =
    connection.scopes.includes('terminal:control')
      ? 'terminals: control'
      : connection.scopes.includes('terminal:observe')
        ? 'terminals: watch only'
        : 'no terminal access'
  const seen = connection.lastConnectedAt ? `Last reached ${formatDate(connection.lastConnectedAt)}` : 'Not reached yet'
  return `${connection.endpoint} · ${terminals} · ${seen}`
}

export type FleetBrowseView = {
  /** What the machine's contents area says instead of a list. Null when there is one to show. */
  emptyMessage: string | null
  /** True when the remote refused our credential — the one failure re-pairing fixes. */
  needsRepair: boolean
  workspaces: FleetBrowse['workspaces']
  terminals: FleetTerminal[]
  /** Parts this pairing may not read, as sentences to show beside what it can. */
  gapMessages: string[]
}

/**
 * One machine's contents, and what to say when part of it is missing.
 *
 * A scope gap is shown NEXT TO the parts that did load rather than replacing
 * them: a device paired for terminals alone should still see its terminals, and
 * be told plainly why there are no workspaces beside them.
 */
export function fleetBrowseView(browse: FleetBrowse | null, loading: boolean): FleetBrowseView {
  if (!browse) {
    return {
      emptyMessage: loading ? 'Reading that machine.' : 'Open this machine to see what it holds.',
      needsRepair: false,
      workspaces: [],
      terminals: [],
      gapMessages: [],
    }
  }
  if (!browse.reachable) {
    return {
      emptyMessage:
        browse.unreachableReason ?? 'That machine did not answer. It may be asleep or off the tailnet.',
      needsRepair: browse.unauthorized,
      workspaces: [],
      terminals: [],
      gapMessages: [],
    }
  }
  const gapMessages = browse.gaps.map((gap) => gap.message)
  if (browse.workspaces.length === 0 && browse.terminals.length === 0) {
    return {
      emptyMessage:
        gapMessages.length > 0
          ? gapMessages.join(' ')
          : 'That machine has no workspaces open and no terminals running.',
      needsRepair: false,
      workspaces: [],
      terminals: [],
      gapMessages: [],
    }
  }
  return {
    emptyMessage: null,
    needsRepair: false,
    workspaces: browse.workspaces,
    terminals: browse.terminals,
    gapMessages,
  }
}

/** A terminal row's title: the agent's name where it has one, else the shell it is. */
export function fleetTerminalTitle(terminal: FleetTerminal): string {
  if (terminal.agentName) return terminal.agentName
  return terminal.kind === 'agent' ? 'Agent' : 'Terminal'
}

/**
 * A terminal row's state, in the words a person can act on.
 *
 * Paused and exited are separate answers because they are separate situations:
 * a paused agent's screen is real and its process is not, and offering to type
 * into one as if it were live would be offering a frozen screen.
 */
export function fleetTerminalStatus(terminal: FleetTerminal): { label: string; tone: Tone } {
  if (terminal.suspended) return { label: 'Paused', tone: 'neutral' }
  if (!terminal.processAlive) return { label: 'Exited', tone: 'neutral' }
  if (terminal.phase) return { label: terminal.phase.replace(/_/gu, ' '), tone: 'good' }
  return { label: 'Running', tone: 'good' }
}

/** The tab name a remote pane wears. The machine is part of the name, not a tooltip. */
export function fleetTerminalTabName(machineName: string, title: string): string {
  return `${title} · ${machineName}`
}
