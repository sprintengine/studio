// A machine's identity: the kind of device it is drawn as, and its colour
// (owner ruling 2026-10-04).
//
// Every machine other than this one wears a glyph in a colour wherever the app
// names it — the composer's context strip, a sidebar row, a chat tab, the
// machine picker. Both have a DEFAULT that comes from the machine itself and
// never from where it sits in a list, so a machine looks the same in every
// surface and on every device that sees it, and a person can override either
// in Settings › Machines.
//
//   - The default kind comes from what the machine is: a WSL distribution is
//     `wsl`, an SSH machine is a `server`, a paired Mac is a `laptop` (a
//     `mini` when its name says so — the pairing record carries no hardware
//     model), and any other paired machine is a `desktop`.
//   - The default colour is a hash of the machine's stable id over the seven
//     mark hues. The id is built from what every device agrees on: the WSL
//     host id, the SSH host name, the tailnet host name. The neutral is an
//     eighth choice a person can make, never a default.
//
// This machine has no identity at all: it is the unmarked default, and no
// surface draws a glyph for it.

import { isWslHostId, LOCAL_HOST_ID, type ExecutionHostId } from './execution-host'

/** The kinds a machine is drawn as. Phones and tablets are not here: the server never runs on one. */
export const MACHINE_KINDS = [
  'laptop',
  'desktop',
  'mini',
  'tower',
  'server',
  'cloud',
  'container',
  'board',
  'wsl',
] as const
export type MachineKind = (typeof MACHINE_KINDS)[number]

/** What each kind is called in a picker. */
export const MACHINE_KIND_LABELS: Record<MachineKind, string> = {
  laptop: 'Laptop',
  desktop: 'Desktop',
  mini: 'Mini',
  tower: 'Tower',
  server: 'Server',
  cloud: 'Cloud VM',
  container: 'Container',
  board: 'Board',
  wsl: 'WSL',
}

/**
 * The colours a machine can wear: the seven `color.mark.*` hues, then a
 * neutral. The order is the hash's — the default picks among the first seven —
 * so it is part of the contract: reordering it recolours every machine.
 */
export const MACHINE_COLOURS = ['blue', 'teal', 'cyan', 'orange', 'yellow', 'violet', 'red', 'neutral'] as const
export type MachineColour = (typeof MACHINE_COLOURS)[number]

export const MACHINE_COLOUR_LABELS: Record<MachineColour, string> = {
  blue: 'Blue',
  teal: 'Teal',
  cyan: 'Cyan',
  orange: 'Orange',
  yellow: 'Yellow',
  violet: 'Violet',
  red: 'Red',
  neutral: 'Neutral',
}

/** How many of the colours a default may land on: the hues, not the neutral. */
const DEFAULT_COLOUR_COUNT = 7

/** A person's override for one machine. Absent fields read as the default. */
export type MachineMarkSetting = { kind?: MachineKind; colour?: MachineColour }

/** Overrides, keyed by machine id (`machineIdOf`). */
export type MachineMarkSettings = Record<string, MachineMarkSetting>

/**
 * A machine, as a surface knows it. Each carries only what every device that
 * sees the machine agrees on, because that is what its id is built from.
 */
export type MachineRef =
  | { kind: 'local' }
  | { kind: 'wsl'; hostId: ExecutionHostId }
  /**
   * An SSH machine: the host name its SSH config resolves to, else what was
   * typed (`user@host[:port]`, of which only the host and a port count), and
   * the port when it is not 22 — two machines behind one host differ by it.
   */
  | { kind: 'ssh'; host: string; port?: number | null }
  /** A machine paired over the tailnet, by its host name. */
  | { kind: 'paired'; name: string }

/** A machine's identity: its id, and the kind and colour it is drawn in. */
export type MachineIdentity = {
  id: string
  kind: MachineKind
  colour: MachineColour
  /** Whether the person chose either, rather than both being the defaults. */
  overridden: boolean
}

/**
 * The first label of a host name, lower case: `Mac-Mini.example.ts.net.` →
 * `mac-mini`. Only a host name is shortened: an address (`100.64.0.7` — every
 * tailnet IPv4 address starts `100.`) or a typed name with a full stop in it
 * is kept whole, lower case, or two machines would share one id. The same rule
 * as `shortMachineName` in the renderer's machine rows.
 */
export function shortHostName(value: string): string {
  const trimmed = value.trim().replace(/\.+$/u, '').toLowerCase()
  if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/u.test(trimmed)) return trimmed
  if (/^\d+(?:\.\d+)+$/u.test(trimmed)) return trimmed
  return trimmed.split('.')[0]!
}

/**
 * An SSH host as an id: no `user@`, no trailing dot, lower case, and a port
 * only when it is not 22 — from the ref's own port, or one typed after the
 * host (`host:2222`, `[::1]:2222`).
 */
function sshHostKey(raw: string, port: number | null | undefined): string | null {
  let host = raw.trim().toLowerCase()
  const at = host.lastIndexOf('@')
  if (at >= 0) host = host.slice(at + 1)
  let typedPort: number | null = null
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/u.exec(host)
  if (bracketed) {
    host = bracketed[1]!
    typedPort = bracketed[2] ? Number(bracketed[2]) : null
  } else {
    const withPort = /^([^:]+):(\d+)$/u.exec(host)
    if (withPort) {
      host = withPort[1]!
      typedPort = Number(withPort[2])
    }
  }
  host = host.replace(/\.+$/u, '')
  if (!host) return null
  const effectivePort = port ?? typedPort
  return effectivePort && effectivePort !== 22 ? `${host}:${effectivePort}` : host
}

/**
 * The machine's stable id, or null for this machine (which has none).
 *
 * A paired machine is keyed by its SHORT host name: one device can know it as
 * `mac-mini.example.ts.net` and another as `mac-mini`, and both must land on
 * the same colour.
 */
export function machineIdOf(machine: MachineRef): string | null {
  switch (machine.kind) {
    case 'local':
      return null
    case 'wsl':
      return machine.hostId === LOCAL_HOST_ID ? null : machine.hostId
    case 'ssh': {
      const host = sshHostKey(machine.host, machine.port)
      return host ? `ssh:${host}` : null
    }
    case 'paired': {
      const name = shortHostName(machine.name)
      return name ? `tailnet:${name}` : null
    }
  }
}

/** The kind a machine is drawn as until a person picks another. */
export function defaultMachineKind(machine: MachineRef): MachineKind | null {
  switch (machine.kind) {
    case 'local':
      return null
    case 'wsl':
      return isWslHostId(machine.hostId) ? 'wsl' : null
    case 'ssh':
      return 'server'
    case 'paired': {
      // The pairing record carries no OS and no hardware model, so a Mac is
      // known by its name, as the tailnet's own host names spell it
      // (`dev-macbook-air`, `mac-mini`). A Mac whose name says neither is a
      // laptop, the most common Mac on a personal tailnet.
      // The name is read as words (`dev-macbook-air` → dev, macbook, air), so
      // `macro-runner` is not a Mac and `ubuntu-studio` is not a Mac Studio.
      // A book is tested first: "MacBook Pro" is a laptop whatever else its
      // name says. A wrong guess is one pick away in Settings › Machines.
      const words = machine.name
        .toLowerCase()
        .split(/[^a-z0-9]+/u)
        .filter(Boolean)
      const has = (word: string): boolean => words.includes(word)
      const mac = has('mac') || has('macos')
      if (words.some((word) => word.startsWith('macbook') || word === 'book')) return 'laptop'
      if (has('macmini') || has('minipc') || has('mini') || (mac && has('studio')) || has('macstudio')) return 'mini'
      if (words.some((word) => word.startsWith('imac'))) return 'desktop'
      if (has('macpro') || (mac && has('pro'))) return 'tower'
      if (mac) return 'laptop'
      return 'desktop'
    }
  }
}

/**
 * 32-bit FNV-1a over the id's UTF-16 code units. Not for security: it spreads
 * short, similar ids (`wsl:Ubuntu`, `wsl:Ubuntu-22.04`) across the palette,
 * and it is the same on every device, which is the point.
 */
export function machineIdHash(id: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

/** The colour a machine wears until a person picks another: one of the seven hues, by its id. */
export function defaultMachineColour(id: string): MachineColour {
  // The top half of the hash: FNV's low bits are the weakest.
  return MACHINE_COLOURS[(machineIdHash(id) >>> 16) % DEFAULT_COLOUR_COUNT]!
}

export function isMachineKind(value: unknown): value is MachineKind {
  return typeof value === 'string' && (MACHINE_KINDS as readonly string[]).includes(value)
}

export function isMachineColour(value: unknown): value is MachineColour {
  return typeof value === 'string' && (MACHINE_COLOURS as readonly string[]).includes(value)
}

/** One stored override, fail-soft: an unknown kind or colour is dropped, and an empty one is none. */
export function normalizeMachineMarkSetting(value: unknown): MachineMarkSetting | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const mark: MachineMarkSetting = {
    ...(isMachineKind(raw.kind) ? { kind: raw.kind } : {}),
    ...(isMachineColour(raw.colour) ? { colour: raw.colour } : {}),
  }
  return mark.kind || mark.colour ? mark : null
}

export function normalizeMachineMarkSettings(value: unknown): MachineMarkSettings {
  const marks: MachineMarkSettings = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return marks
  for (const [id, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!id) continue
    const mark = normalizeMachineMarkSetting(entry)
    if (mark) marks[id] = mark
  }
  return marks
}

/**
 * The machine's identity with the person's overrides applied, or null for this
 * machine — which no surface marks.
 */
export function resolveMachineIdentity(
  machine: MachineRef,
  overrides: MachineMarkSettings | null | undefined,
): MachineIdentity | null {
  const id = machineIdOf(machine)
  const kind = defaultMachineKind(machine)
  if (!id || !kind) return null
  const own = overrides?.[id]
  return {
    id,
    kind: own?.kind ?? kind,
    colour: own?.colour ?? defaultMachineColour(id),
    overridden: Boolean(own?.kind || own?.colour),
  }
}
