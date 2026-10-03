import type { IpcMain, IpcMainInvokeEvent } from 'electron'

import { isMachineChannel, MACHINE_QUIET_CHANNELS, notOnMachineYet } from '../../../shared/machine-channels'
import { isMachinePath, machinePath, parseMachinePath } from '../../../shared/machine-paths'

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

type Found = { id: string } | { mixed: true } | null

/** The machine an invoke's arguments name (top level, and one level into objects and arrays), if any. */
export function machineOfArgs(args: readonly unknown[]): Found {
  let id: string | null = null
  let local = false
  const look = (value: unknown, depth: number): void => {
    if (typeof value === 'string') {
      const parsed = isMachinePath(value) ? parseMachinePath(value) : null
      if (parsed) {
        if (id !== null && id !== parsed.id) local = true
        id = parsed.id
      } else if (isMachinePath(value)) local = true
      // Any other string goes to the machine as it is, so it is read there,
      // never here: a query that starts with `/` is not a path of this computer.
      return
    }
    if (depth >= 2) return
    if (Array.isArray(value)) for (const entry of value) look(entry, depth + 1)
    else if (isRecord(value)) for (const entry of Object.values(value)) look(entry, depth + 1)
  }
  for (const arg of args) look(arg, 0)
  if (local) return { mixed: true }
  return id === null ? null : { id }
}

/** The arguments with every machine path made plain. */
export function plainArgs(args: readonly unknown[]): unknown[] {
  const plain = (value: unknown, depth: number): unknown => {
    if (typeof value === 'string') return parseMachinePath(value)?.path ?? value
    if (depth >= 2) return value
    if (Array.isArray(value)) return value.map((entry) => plain(entry, depth + 1))
    if (isRecord(value))
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, plain(entry, depth + 1)]))
    return value
  }
  return args.map((arg) => plain(arg, 0))
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
      const found = machineOfArgs(args)
      if (found === null) return listener(event, ...args)
      if ('mixed' in found)
        return Promise.reject(new Error('That names paths on two machines, or a machine path Studio cannot read.'))
      if (channel in MACHINE_QUIET_CHANNELS) return MACHINE_QUIET_CHANNELS[channel]
      if (!isMachineChannel(channel) || !route) return Promise.reject(new Error(notOnMachineYet(channel)))
      return route.call(found.id, channel, plainArgs(args)).then((value) => spelledResult(found.id, channel, value))
    })
  return new Proxy(ipcMain, {
    get(target, property, receiver) {
      if (property === 'handle') return handle
      const value = Reflect.get(target, property, receiver) as unknown
      return typeof value === 'function' ? (value as (...input: unknown[]) => unknown).bind(target) : value
    },
  })
}
