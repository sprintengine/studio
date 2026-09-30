import type { TailnetMachine } from '../../../../shared/tailnet-machines'
import { platformLabel } from './machineRowModel'

// How a machine on the Machines list can be paired, and — when it cannot yet —
// the reason, in the words its row shows.
//
// The row's Pair button used to be disabled with nothing beside it whenever a
// machine was asleep or no Studio answered on it. Those are two different
// problems with two different fixes, and neither was on screen, so a disabled
// button read as the app being broken. Worse, the most common cause — Remote
// switched off on the other machine — is the one thing only a person can fix,
// and only by walking to that machine. The row now says which it is.

export type PairRoute =
  /** This machine, or one already paired: the row offers Revoke, not Pair. */
  | { route: 'none' }
  /** A Studio answered the probe: ask it to pair, confirmed by the six digits. */
  | { route: 'ask' }
  /** A phone: it runs no Studio to ask, and pairs by scanning a code instead. */
  | { route: 'link' }
  /** Nothing to pair with right now, and why. */
  | { route: 'unavailable'; reason: string }

export function pairRoute(machine: TailnetMachine): PairRoute {
  if (machine.isSelf || machine.inbound !== null || machine.outbound !== null) return { route: 'none' }
  // Before the online check: a phone scans the code whenever it is picked up,
  // so its being asleep now is no reason to hold the button back.
  if (isPhone(machine)) return { route: 'link' }
  // "Asleep", not "offline" — a machine that is switched off is not in an
  // error state, and the row is already dimmed to say so.
  if (!machine.online) return { route: 'unavailable', reason: 'Asleep' }
  if (!machine.studio) return { route: 'unavailable', reason: 'No Studio answering — turn on Remote there' }
  return { route: 'ask' }
}

function isPhone(machine: TailnetMachine): boolean {
  const platform = platformLabel(machine.os)
  return platform === 'iOS' || platform === 'Android'
}
