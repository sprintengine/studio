// =============================================================================
// Execution hosts: where a workspace's processes run
//
// A workspace runs on one machine. For a folder on this computer that machine
// is either this computer itself (`local`) or, on Windows, one of its WSL
// distributions (`wsl:<distro>`), each of which is a machine of its own: its
// own file system, its own PATH, its own installed CLIs and its own git.
// Everything a workspace starts — agents, plain terminals, the "+" tab, git —
// runs on the workspace's host. A paired remote machine is a different kind of
// thing (a whole other Studio, reached over the tailnet) and is not a host.
//
// The id is the distribution NAME, because that is what `wsl.exe -d` takes
// (owner decision 2026-09-24). A rename in WSL is therefore a new host.
//
// This file is pure and shared: main and the renderer read the same answers.
// =============================================================================

import { distroOfUncPath } from './host-paths'
import type { TerminalPathStyle } from './ipc/terminal'

export const LOCAL_HOST_ID = 'local'

export type ExecutionHostId = typeof LOCAL_HOST_ID | `wsl:${string}`

export type ExecutionHostKind = 'posix' | 'windows' | 'wsl'

export type ExecutionHostState = 'ready' | 'stopped' | 'starting' | 'unavailable'

/** One machine, as the picker and Settings show it. */
export type ExecutionHostSummary = {
  id: ExecutionHostId
  kind: ExecutionHostKind
  /** "This Mac", "This PC (Windows)", "WSL: Ubuntu". */
  label: string
  pathStyle: TerminalPathStyle
  state: ExecutionHostState
  /** Why the host is `unavailable` or `stopped`, in words a person can act on. */
  reason?: string
  /** WSL only: the distribution `wsl.exe` runs when none is named. */
  isDefaultDistro?: boolean
  /** WSL only: whether the person turned this distribution on as a machine. */
  enabled?: boolean
  /** WSL only: 1 or 2, when WSL reported it. */
  wslVersion?: number | null
}

/**
 * The per-machine settings. The local machine's CLI commands stay on the CLI
 * runtime itself (`cliRuntimes[cli].command`, which the Agents tab edits);
 * every other machine keeps its own here, because a binary on PATH in one
 * distribution says nothing about another.
 */
export type ExecutionHostSettings = {
  /** WSL: offered as a machine for new chats. A workspace already in it runs either way. */
  enabled: boolean
  /** Per-CLI command override on this machine. Blank or absent uses the CLI's own binary name. */
  cliCommands: Record<string, string>
  /** Extra environment exported into every launch on this machine. */
  env: Record<string, string>
  /** The plain-terminal shell. Absent uses the machine's default (`bash -li` in WSL). */
  shell?: string
}

export const HOSTS_CHANNELS = {
  /** renderer → main: the machines this computer offers, `{ refresh?: boolean }`. */
  list: 'hosts:list',
  /** main → renderer: the list changed (a distribution appeared, a setting moved). */
  changed: 'hosts:changed',
  /** renderer → main: the Linux home of a WSL host, as the UNC path Windows opens. */
  home: 'hosts:home',
} as const

/**
 * What `hosts:list` answers: this machine first, then WSL distributions (all
 * of them for Settings, the enabled ones for the picker). `wsl` says whether
 * WSL answered at all, and is null off Windows.
 */
export type HostsListResult = {
  hosts: ExecutionHostSummary[]
  wsl: { available: boolean; reason?: string } | null
}

export type HostHomeResult = { ok: true; home: string; native: string } | { ok: false; message: string }

const WSL_PREFIX = 'wsl:'
// The names WSL itself accepts for a distribution (see `isValidWslDistroName`
// in main): letters, digits, `.`, `_` and `-`.
const DISTRO_NAME = /^[A-Za-z0-9._-]+$/u

export function wslHostId(distro: string): ExecutionHostId {
  return `${WSL_PREFIX}${distro}`
}

/** The distribution a `wsl:<distro>` id names, or null for any other id. */
export function distroOfHostId(id: string | null | undefined): string | null {
  if (!id || !id.startsWith(WSL_PREFIX)) return null
  const distro = id.slice(WSL_PREFIX.length)
  return DISTRO_NAME.test(distro) ? distro : null
}

export function isWslHostId(id: string | null | undefined): id is `wsl:${string}` {
  return distroOfHostId(id) !== null
}

/** A value read from disk or the wire, as a host id, or null when it is not one. */
export function normalizeExecutionHostId(value: unknown): ExecutionHostId | null {
  if (value === LOCAL_HOST_ID) return LOCAL_HOST_ID
  if (typeof value !== 'string') return null
  const distro = distroOfHostId(value)
  return distro ? wslHostId(distro) : null
}

/**
 * The host a folder belongs to by where it lives: a folder inside a
 * distribution (`\\wsl.localhost\Ubuntu\…`, `\\wsl$\Ubuntu\…`) is that
 * distribution's; anything else says nothing, and returns null.
 */
export function hostIdForFolder(folder: string | null | undefined): ExecutionHostId | null {
  if (!folder) return null
  const distro = distroOfUncPath(folder)
  return distro && DISTRO_NAME.test(distro) ? wslHostId(distro) : null
}

/**
 * The host a launch runs on. In order:
 *
 *   1. the host the session is already bound to — a resumed CLI's transcript
 *      lives in that machine's home, so a resume never moves;
 *   2. the host the caller named (the workspace's machine, or an explicit
 *      `host` on an agent launch);
 *   3. the distribution the folder lives in;
 *   4. this machine.
 *
 * Only Windows has hosts other than `local`; everywhere else the answer is
 * `local` whatever was asked, so a stray id from another machine's settings
 * can never send a macOS launch looking for `wsl.exe`.
 */
export function resolveLaunchHostId(input: {
  bound?: string | null
  requested?: string | null
  folder?: string | null
  platform: string
}): ExecutionHostId {
  if (input.platform !== 'win32') return LOCAL_HOST_ID
  return (
    normalizeExecutionHostId(input.bound) ??
    normalizeExecutionHostId(input.requested) ??
    hostIdForFolder(input.folder) ??
    LOCAL_HOST_ID
  )
}

/** The path style a host's shell speaks. */
export function pathStyleOfHost(id: ExecutionHostId, platform: string): TerminalPathStyle {
  if (isWslHostId(id)) return 'wsl'
  return platform === 'win32' ? 'windows' : 'posix'
}

/** How a host is named to a person. */
export function executionHostLabel(id: ExecutionHostId, platform: string): string {
  const distro = distroOfHostId(id)
  if (distro) return `WSL: ${distro}`
  if (platform === 'win32') return 'This PC (Windows)'
  if (platform === 'darwin') return 'This Mac'
  return 'This computer'
}

export function emptyExecutionHostSettings(): ExecutionHostSettings {
  return { enabled: false, cliCommands: {}, env: {} }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function stringRecord(value: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!isPlainObject(value)) return out
  for (const [key, entry] of Object.entries(value)) {
    if (key && typeof entry === 'string') out[key] = entry
  }
  return out
}

// An environment variable name a POSIX shell can `export`. Anything else would
// break the startup script the launch writes, so it is dropped on the way in.
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u

/** Fail-soft parse of one host's settings. Never throws. */
export function normalizeExecutionHostSettings(value: unknown): ExecutionHostSettings {
  if (!isPlainObject(value)) return emptyExecutionHostSettings()
  const env = Object.fromEntries(Object.entries(stringRecord(value.env)).filter(([name]) => ENV_NAME.test(name)))
  const shell = typeof value.shell === 'string' && value.shell.trim() ? value.shell.trim() : undefined
  return {
    enabled: value.enabled === true,
    cliCommands: stringRecord(value.cliCommands),
    env,
    ...(shell ? { shell } : {}),
  }
}

/** A CLI's command on a host, or '' for "the CLI's own binary name". */
export function hostCliCommand(
  settings: ExecutionHostSettings | undefined,
  cli: string,
  localCommand: string | undefined,
  id: ExecutionHostId,
): string {
  if (id === LOCAL_HOST_ID) return (localCommand ?? '').trim()
  return (settings?.cliCommands[cli] ?? '').trim()
}
