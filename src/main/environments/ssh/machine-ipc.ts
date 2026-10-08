import type { IpcMain, IpcMainInvokeEvent } from 'electron'

import { isMachineChannel, MACHINE_QUIET_CHANNELS, notOnMachineYet } from '../../../shared/machine-channels'
import { isMachinePath, machinePath, parseMachinePath } from '../../../shared/machine-paths'
import { isRecord } from '../../../shared/records'

// The desktop's file and git channels, for a workspace on an SSH machine
// (phase 8; the owner's ruling that the server holds raw access to its
// machine and clients build the views). Every handler registered through this
// wrapper looks at what it was asked about first: a path spelled
// `ssh://<id>/…` (shared/machine-paths.ts) is never handed to this computer's
// file system or git. A channel the machine answers goes to that machine's
// server with the plain path, and what comes back is spelled again; a watch is
// answered that there is none; anything else is refused in words.

export type MachineRoute = {
  /** Answer a machine channel on that machine's server; rejects in words when it cannot be reached. */
  call(id: string, channel: string, args: unknown[]): Promise<unknown>
}

/**
 * Fields that carry a person's text (a search, a file's contents, a commit
 * message), never a path: an `ssh://git@…` remote written into a file, or a
 * commit message that quotes one, is not a request about a machine.
 */
const TEXT_FIELDS: ReadonlySet<string> = new Set(['query', 'content', 'message', 'data', 'text', 'body'])

/** Positional text arguments of the channels this wrapper sees, by channel. */
const TEXT_ARGUMENTS: Readonly<Record<string, readonly number[]>> = {
  'fs:writefile': [1],
  'git:resolve-conflict': [2],
  'git:commit': [1],
  'git:stash-push': [1],
  'git:save-patch': [1],
}

/** Fields of an answer that hold a path on the machine, spelled again for this computer. */
const PATH_FIELDS = new Set([
  'path',
  'parentPath',
  'checkedPath',
  'repoRoot',
  'rootPath',
  'absolutePath',
  'checkoutPath',
])

type Found = { id: string } | { mixed: true } | null

/**
 * The machine an invoke's arguments name (top level, and one level into
 * objects and arrays), if any. Text arguments and fields (a search, a file's
 * contents, a commit message) are never read as paths. Anywhere else, a
 * string spelled `ssh://` that names no machine is refused rather than
 * handed to this computer's disk, where it would resolve under the working
 * directory.
 */
export function machineOfArgs(args: readonly unknown[], channel?: string): Found {
  let id: string | null = null
  let mixed = false
  const look = (value: unknown, depth: number): void => {
    if (typeof value === 'string') {
      if (!isMachinePath(value)) return
      const parsed = parseMachinePath(value)
      if (!parsed || (id !== null && id !== parsed.id)) mixed = true
      else id = parsed.id
      // Any other string goes to the machine as it is, so it is read there,
      // never here: a query that starts with `/` is not a path of this computer.
      return
    }
    if (depth >= 2) return
    if (Array.isArray(value)) for (const entry of value) look(entry, depth + 1)
    else if (isRecord(value))
      for (const [key, entry] of Object.entries(value)) if (!TEXT_FIELDS.has(key)) look(entry, depth + 1)
  }
  const text = (channel && TEXT_ARGUMENTS[channel]) || []
  args.forEach((arg, index) => {
    if (!text.includes(index)) look(arg, 0)
  })
  if (mixed) return { mixed: true }
  return id === null ? null : { id }
}

/** The arguments with every machine path on machine `id` made plain; text is passed on as it was written. */
export function plainArgs(args: readonly unknown[], channel?: string, id?: string): unknown[] {
  const plain = (value: unknown, depth: number): unknown => {
    if (typeof value === 'string') {
      const parsed = parseMachinePath(value)
      return parsed && (id === undefined || parsed.id === id) ? parsed.path : value
    }
    if (depth >= 2) return value
    if (Array.isArray(value)) return value.map((entry) => plain(entry, depth + 1))
    if (isRecord(value))
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, TEXT_FIELDS.has(key) ? entry : plain(entry, depth + 1)]),
      )
    return value
  }
  const text = (channel && TEXT_ARGUMENTS[channel]) || []
  return args.map((arg, index) => (text.includes(index) ? arg : plain(arg, 0)))
}

/** An answer with its paths on the machine spelled for this computer. File contents are never touched. */
export function spelledResult(id: string, channel: string, value: unknown): unknown {
  if (channel === 'git:get-repo-root')
    return typeof value === 'string' && value.startsWith('/') ? machinePath(id, value) : value
  const spell = (entry: unknown, depth: number): unknown => {
    if (depth > 4) return entry
    if (Array.isArray(entry)) return entry.map((item) => spell(item, depth + 1))
    if (!isRecord(entry)) return entry
    return Object.fromEntries(
      Object.entries(entry).map(([key, field]) => [
        // A map keyed by absolute paths (git status's files) is keyed by machine paths here.
        key.startsWith('/') ? machinePath(id, key) : key,
        PATH_FIELDS.has(key) && typeof field === 'string' && field.startsWith('/')
          ? machinePath(id, field)
          : spell(field, depth + 1),
      ]),
    )
  }
  return spell(value, 0)
}

/**
 * An `IpcMain` whose `handle` checks every invoke for a machine path first.
 * Handlers registered on it answer this computer's paths exactly as before.
 */
export function machineAwareIpc(ipcMain: IpcMain, route: MachineRoute | null): IpcMain {
  const handle = (channel: string, listener: (event: IpcMainInvokeEvent, ...args: any[]) => unknown) =>
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      // With the preview off there is no route: any machine path is refused
      // in words rather than read as a folder of this computer.
      const found = machineOfArgs(args, channel)
      if (found === null) return listener(event, ...args)
      if ('mixed' in found)
        return Promise.reject(new Error('That names paths on two SSH machines, or a machine path Studio cannot read.'))
      if (channel in MACHINE_QUIET_CHANNELS) return MACHINE_QUIET_CHANNELS[channel]
      if (!isMachineChannel(channel) || !route) return Promise.reject(new Error(notOnMachineYet(channel)))
      return route
        .call(found.id, channel, plainArgs(args, channel, found.id))
        .then((value) => spelledResult(found.id, channel, value))
    })
  return new Proxy(ipcMain, {
    get(target, property, receiver) {
      if (property === 'handle') return handle
      const value = Reflect.get(target, property, receiver) as unknown
      return typeof value === 'function' ? (value as (...input: unknown[]) => unknown).bind(target) : value
    },
  })
}
