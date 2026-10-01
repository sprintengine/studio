import type { MeshMachineReachability } from '../../../../shared/tailnet-mesh'

// A paired machine's row, wherever one is drawn (the Remote popover, the
// Mesh, Settings): its phase from main's reachability check (phase 4).

export type MeshMachinePhase =
  | { phase: 'paired' }
  | { phase: 'checking' }
  | { phase: 'reachable'; checkedAt: number }
  | { phase: 'unreachable'; detail: string; lastReachedAt: number | null }
  | { phase: 'revoked'; detail: string }

export function meshMachinePhase(
  connectionId: string,
  reachability?: ReadonlyMap<string, MeshMachineReachability>,
): MeshMachinePhase {
  const reach = reachability?.get(connectionId)
  if (!reach) return { phase: 'paired' }
  if (reach.unauthorized) return { phase: 'revoked', detail: reach.detail ?? 'This device was revoked over there.' }
  if (reach.checking && reach.checkedAt === null) return { phase: 'checking' }
  if (reach.checkedAt === null) return { phase: 'paired' }
  if (reach.reachable) return { phase: 'reachable', checkedAt: reach.checkedAt }
  return { phase: 'unreachable', detail: reach.detail ?? 'Not answering.', lastReachedAt: reach.lastReachedAt }
}

export function machinePhaseText(phase: MeshMachinePhase, now: number): string {
  switch (phase.phase) {
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
      return phase.lastReachedAt
        ? `not answering · ${since(phase.lastReachedAt, now)}`
        : 'not answering · never reached'
    case 'revoked':
      return 'revoked there — pair again to reconnect'
  }
}

/**
 * The machine glyph's ink, which is the row's whole status vocabulary (owner
 * ruling 2026-09-05: no status dots in the Remote popover — the glyph is
 * green when the machine answers and the default ink when it does not).
 * A check still in flight keeps the default ink too: the text beside the name
 * says "checking…", and a colour for "almost" is a colour nobody reads.
 */
export function machineGlyphToneClass(phase: MeshMachinePhase): string {
  return phase.phase === 'reachable' ? 'text-[color:var(--tone-good)]' : 'text-[color:var(--text-subtle)]'
}

/** Whether a phase means the machine is answering right now — what the top bar's count adds up. */
export function machineIsAnswering(phase: MeshMachinePhase): boolean {
  return phase.phase === 'reachable'
}

/** Which row action a phase earns: Retry for a machine that stopped answering, Pair again for one that revoked us. */
export function machineRowAction(phase: MeshMachinePhase): 'retry' | 'pair-again' | null {
  if (phase.phase === 'revoked') return 'pair-again'
  if (phase.phase === 'unreachable') return 'retry'
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
  // "100.64.0.101" is an address — a first label from either would be a lie.
  if (!/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/u.test(trimmed)) return trimmed
  if (/^\d+(?:\.\d+)+$/u.test(trimmed)) return trimmed
  return trimmed.split('.')[0] ?? trimmed
}

/**
 * How long something has been true, without the "ago" — "8 min", "2 h". A row
 * that already says what the state IS ("not answering") wants the duration of
 * that state, not a second sentence about when it last was not (owner ruling
 * 2026-09-05).
 *
 * Lived in `peerPickerModel` until the peer picker was replaced by the merged
 * Machines list (remote-settings-rebuild); it moved here rather than dying with
 * it because the phase text above is its only caller.
 */
export function since(thenMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.round((nowMs - thenMs) / 1000))
  if (seconds < 60) return 'under a min'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h`
  const days = Math.round(hours / 24)
  return `${days} ${days === 1 ? 'day' : 'days'}`
}

/**
 * The platform word on a machine row's supporting line, or null.
 *
 * Four sources feed the Machines list and each spells the OS its own way —
 * Tailscale says `macOS`, `windows`, `linux`, `android`, `iOS`; a pairing
 * record may say nothing at all. This maps what we get onto the words a person
 * uses, and returns NULL rather than a guess for anything unrecognised: a row
 * reading "linux-ish" or echoing a raw `win32` says less than a row that leaves
 * the slot out and lets the name and the glyph carry it.
 */
export function platformLabel(os: string | null | undefined): string | null {
  const value = (os ?? '').trim().toLowerCase()
  if (!value) return null
  if (value.includes('mac') || value.includes('darwin') || value.includes('osx')) return 'macOS'
  if (value.includes('ios') || value.includes('iphone') || value.includes('ipad')) return 'iOS'
  // After the macOS test: "darwin" contains "win".
  if (value.includes('win')) return 'Windows'
  if (value.includes('android')) return 'Android'
  if (value.includes('linux')) return 'Linux'
  return null
}
