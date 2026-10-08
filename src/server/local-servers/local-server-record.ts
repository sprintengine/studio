// The local server record: which servers a conversation's agent said it started
// (the gateway's `local_server.link`), kept where the Studio server keeps its
// data so a server linked yesterday is still listed after a restart. This is
// the OWNER of the links; whether each one is up right now is not kept here,
// because it is only true at the moment it was checked (local-server-domain.ts
// checks it).
//
// A SERVER IS ITS ADDRESS. Two links name the same server when they name the
// same host and port, with every loopback spelling (`localhost`, `127.0.0.1`,
// `[::1]`, the unspecified address an agent copied out of a dev server's
// banner) read as one host. Only one process can hold a port, so:
//
// - the same conversation linking it again updates the link in place (same
//   id, its title, command and folder replaced by what was given, moved to the
//   top);
// - another conversation linking it takes it over: the latest agent to say
//   "I started this" is the one whose process is on that port now.
//
// BOUNDED. At most `MAX_SERVERS_PER_CONVERSATION` per conversation and
// `MAX_SERVERS` in all; the oldest links go first.
//
// ONE FILE, `local-servers/linked.json` in the server's data directory,
// replaced whole through a temporary file on every change. A file that is
// missing is an empty record; one that cannot be read is kept aside as
// `.corrupt` and the record starts empty, rather than being overwritten.

import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename } from 'node:fs/promises'
import { isIP } from 'node:net'
import { dirname, isAbsolute, join } from 'node:path'

import {
  STUDIO_LOCAL_SERVER_MAX_COMMAND,
  STUDIO_LOCAL_SERVER_MAX_URL,
} from '../../../packages/studio-protocol/src/public'
import { writeFileAtomically } from '../../main/config-file-write'

const STORE_DIR = 'local-servers'
const STORE_FILE = 'linked.json'
const STORE_VERSION = 1
/** How long after a write of the record fails it is tried again. */
const WRITE_RETRY_MS = 5_000

/** The most servers one conversation keeps linked; its oldest link goes first. */
export const MAX_SERVERS_PER_CONVERSATION = 20
/** The most servers on the record; the oldest link goes first. */
export const MAX_SERVERS = 500
/** The longest title a link keeps. */
export const MAX_TITLE = 200

/** A conversation: a workspace and one agent in it. */
export type LocalServerConversationKey = { workspaceId: string; agentId: string }

/** One link, as it is stored. */
export type LinkedLocalServer = {
  id: string
  workspaceId: string
  agentId: string
  /** What a person opens: the agent's URL, with an unspecified host written as `localhost`. */
  url: string
  /** The agent's name for it; empty when it gave none. */
  title: string
  /** The host checked: lower case, unbracketed, every loopback spelling as `localhost`. */
  host: string
  port: number
  command?: string
  cwd?: string
  linkedAt: number
}

/** What an agent links: checked by `readLocalServerUrl` and the tool before it reaches the record. */
export type LocalServerLinkInput = { url: string; title?: string; command?: string; cwd?: string }

/** What a link came to: the entry, whether it is new, and whose it was when it moved. */
export type LocalServerLinkResult = {
  server: LinkedLocalServer
  created: boolean
  /** The conversation that had it before this one took it over. */
  movedFrom?: LocalServerConversationKey
  /** Links the caps pushed out. */
  dropped: LinkedLocalServer[]
}

export type LocalServerRecordOptions = {
  dataDir: string
  now?: () => number
  /** A new link's id; random and URL-safe unless given (tests). */
  newId?: () => string
  /**
   * A link the caps never push out: one a run the Studio started is following.
   * Dropping it would stop a server the person started, to make room for a
   * link nobody has looked at yet.
   */
  keep?: (id: string) => boolean
  log?: (message: string, error?: unknown) => void
}

export type LocalServerRecord = {
  /** Resolves once what was stored has been read. */
  whenLoaded(): Promise<void>
  /** Record a link; the input is already checked. */
  link(key: LocalServerConversationKey, input: LocalServerLinkInput): LocalServerLinkResult
  get(id: string): LinkedLocalServer | undefined
  /** Forget a link; the entry, or null when there was none. */
  remove(id: string): LinkedLocalServer | null
  /** A conversation's links, newest first. */
  forConversation(key: LocalServerConversationKey): LinkedLocalServer[]
  /** Every link in a workspace, newest first. */
  forWorkspace(workspaceId: string): LinkedLocalServer[]
  all(): LinkedLocalServer[]
  /** Settle the load and every write in flight: the tests' synchronisation point, and the quit's. */
  flush(): Promise<void>
  dispose(): void
}

/** The file the record lives in. */
export function localServerStorePath(dataDir: string): string {
  return join(dataDir, STORE_DIR, STORE_FILE)
}

/** A URL a link may carry: http or https, with a host. */
export type LocalServerAddress = { url: string; host: string; port: number }

/**
 * Read a link's URL: http or https with a host, at most
 * `STUDIO_LOCAL_SERVER_MAX_URL` long. The unspecified address (`0.0.0.0`,
 * `[::]`) is what many dev servers print when they listen on every interface,
 * and a browser cannot open it, so the URL keeps `localhost` in its place.
 * Null when it is not one.
 */
export function readLocalServerUrl(raw: string): LocalServerAddress | null {
  const text = raw.trim()
  if (!text || text.length > STUDIO_LOCAL_SERVER_MAX_URL) return null
  let parsed: URL
  try {
    parsed = new URL(text)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  if (!parsed.hostname) return null
  const bare = unbracket(parsed.hostname.toLowerCase())
  if (bare === '0.0.0.0' || bare === '::') parsed.hostname = 'localhost'
  const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null
  const url = parsed.toString()
  if (url.length > STUDIO_LOCAL_SERVER_MAX_URL) return null
  return { url, host: normalizeLocalServerHost(parsed.hostname), port }
}

/**
 * A host as a server's identity reads it: lower case, unbracketed, and every
 * spelling of the default loopback as `localhost`. Another 127.x address is
 * its own host: a server bound to 127.0.0.2 is not reachable at 127.0.0.1.
 */
export function normalizeLocalServerHost(hostname: string): string {
  const bare = unbracket(hostname.toLowerCase())
  return isLoopbackHost(bare) ? 'localhost' : bare
}

/**
 * Whether a host names this machine's default loopback, where a dev server
 * that says "localhost" listens: `localhost` and its subdomains, 127.0.0.1,
 * `::1` (and the mapped form the URL parser writes it in), and the
 * unspecified addresses, which a connection from here also lands on.
 */
export function isLoopbackHost(host: string): boolean {
  const bare = unbracket(host.toLowerCase())
  if (bare === 'localhost' || bare.endsWith('.localhost')) return true
  if (isIP(bare) === 4) return bare === '127.0.0.1' || bare === '0.0.0.0'
  return (
    bare === '::1' ||
    bare === '::' ||
    bare === '0:0:0:0:0:0:0:1' ||
    bare === '::ffff:127.0.0.1' ||
    bare === '::ffff:7f00:1'
  )
}

function unbracket(host: string): string {
  return host.replace(/^\[(.*)\]$/u, '$1')
}

const identityOf = (server: { host: string; port: number }) => `${server.host}:${server.port}`
const sameConversation = (a: LocalServerConversationKey, b: LocalServerConversationKey) =>
  a.workspaceId === b.workspaceId && a.agentId === b.agentId

export function createLocalServerRecord(options: LocalServerRecordOptions): LocalServerRecord {
  const now = options.now ?? (() => Date.now())
  const newId = options.newId ?? (() => randomBytes(9).toString('base64url'))
  const log =
    options.log ??
    ((message: string, error?: unknown) => {
      console.warn(`[local-servers] ${message}`, error ?? '')
    })
  const path = localServerStorePath(options.dataDir)
  /** Oldest link first: insertion order is link order, and a re-link moves to the end. */
  const entries = new Map<string, LinkedLocalServer>()
  let load: Promise<void> | null = null
  let writes: Promise<void> = Promise.resolve()
  let dirty = false
  let disposed = false
  let writeRetry: ReturnType<typeof setTimeout> | null = null
  // The file is there but could not be read (locked by a scanner, a
  // permission): nothing is written over it this run, or the next change
  // would replace every stored link with what this run knows.
  let unreadable = false

  function newestFirst(list: LinkedLocalServer[]): LinkedLocalServer[] {
    return list.reverse()
  }

  function put(entry: LinkedLocalServer): void {
    entries.delete(entry.id)
    entries.set(entry.id, entry)
  }

  /** Push out the oldest links past either cap; what went. */
  function trim(key?: LocalServerConversationKey): LinkedLocalServer[] {
    const dropped: LinkedLocalServer[] = []
    const kept = (entry: LinkedLocalServer) => options.keep?.(entry.id) === true
    if (key) {
      const own = [...entries.values()].filter((entry) => sameConversation(entry, key))
      let over = own.length - MAX_SERVERS_PER_CONVERSATION
      for (const entry of own) {
        if (over <= 0) break
        if (kept(entry)) continue
        entries.delete(entry.id)
        dropped.push(entry)
        over -= 1
      }
    }
    let over = entries.size - MAX_SERVERS
    for (const entry of [...entries.values()]) {
      if (over <= 0) break
      if (kept(entry)) continue
      entries.delete(entry.id)
      dropped.push(entry)
      over -= 1
    }
    return dropped
  }

  function whenLoaded(): Promise<void> {
    load ??= (async () => {
      let raw: string | null = null
      try {
        raw = await readFile(path, 'utf-8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
          unreadable = true
          log('could not read the local server record; keeping what is linked this run in memory only', error)
        }
      }
      if (raw === null || disposed) return
      const stored = parseStoreFile(raw)
      if (stored === null) {
        // Truncated, hand-edited, or written by a version this build does not
        // know: kept aside rather than overwritten by the next write.
        log('the local server record could not be understood; keeping it aside as .corrupt', new Error(path))
        await rename(path, `${path}.corrupt`).catch((error) => {
          log('could not keep an unreadable local server record aside', error)
        })
        return
      }
      // Anything linked while the file was being read is newer, and wins its address.
      const taken = new Set([...entries.values()].map(identityOf))
      const linkedSinceStart = [...entries.values()]
      entries.clear()
      for (const entry of stored.sort((a, b) => a.linkedAt - b.linkedAt)) {
        if (taken.has(identityOf(entry))) continue
        taken.add(identityOf(entry))
        put(entry)
      }
      for (const entry of linkedSinceStart) put(entry)
      for (const key of conversationsOf([...entries.values()])) trim(key)
      trim()
    })().catch((error) => log('could not load the local server record', error))
    return load
  }

  function persist(): void {
    dirty = true
    writes = writes.then(
      async () => {
        if (!dirty || disposed || unreadable) return
        dirty = false
        const snapshot = { version: STORE_VERSION, servers: [...entries.values()] }
        try {
          await mkdir(dirname(path), { recursive: true })
          await writeFileAtomically(path, `${JSON.stringify(snapshot, null, 2)}\n`)
        } catch (error) {
          log('could not write the local server record', error)
          // Still to write: tried again, or what changed is lost until something else does.
          dirty = true
          if (!writeRetry && !disposed) {
            writeRetry = setTimeout(() => {
              writeRetry = null
              if (dirty) persist()
            }, WRITE_RETRY_MS)
            writeRetry.unref?.()
          }
        }
      },
      () => undefined,
    )
  }

  function link(key: LocalServerConversationKey, input: LocalServerLinkInput): LocalServerLinkResult {
    const address = readLocalServerUrl(input.url)
    if (!address) throw new Error('A local server link needs an http or https URL with a host.')
    const identity = identityOf(address)
    const existing = [...entries.values()].find((entry) => identityOf(entry) === identity)
    const title = input.title?.trim().slice(0, MAX_TITLE)
    let server: LinkedLocalServer
    let movedFrom: LocalServerConversationKey | undefined
    if (existing && sameConversation(existing, key)) {
      // The same agent saying it again: what it gave now replaces what it gave
      // then, and what it left out is kept (a re-link to rename it still runs).
      server = {
        ...existing,
        url: address.url,
        host: address.host,
        port: address.port,
        ...(title ? { title } : {}),
        ...(input.command ? { command: input.command } : {}),
        ...(input.cwd ? { cwd: input.cwd } : {}),
        linkedAt: now(),
      }
    } else {
      // A new link, or another conversation's agent now on that port. The id
      // is kept across a move, so a run the Studio started is still followed.
      if (existing) movedFrom = { workspaceId: existing.workspaceId, agentId: existing.agentId }
      server = {
        id: existing?.id ?? uniqueId(),
        workspaceId: key.workspaceId,
        agentId: key.agentId,
        url: address.url,
        title: title ?? '',
        host: address.host,
        port: address.port,
        ...(input.command ? { command: input.command } : {}),
        ...(input.cwd ? { cwd: input.cwd } : {}),
        linkedAt: now(),
      }
    }
    put(server)
    const dropped = trim(key)
    persist()
    return { server, created: !existing, ...(movedFrom ? { movedFrom } : {}), dropped }
  }

  function uniqueId(): string {
    for (;;) {
      const id = newId()
      if (!entries.has(id)) return id
    }
  }

  return {
    whenLoaded,
    link,
    get: (id) => entries.get(id),
    remove(id) {
      const entry = entries.get(id)
      if (!entry) return null
      entries.delete(id)
      persist()
      return entry
    },
    forConversation: (key) => newestFirst([...entries.values()].filter((entry) => sameConversation(entry, key))),
    forWorkspace: (workspaceId) =>
      newestFirst([...entries.values()].filter((entry) => entry.workspaceId === workspaceId)),
    all: () => [...entries.values()],
    async flush() {
      await (load ?? Promise.resolve())
      await writes
    },
    dispose() {
      disposed = true
      if (writeRetry) clearTimeout(writeRetry)
      writeRetry = null
    },
  }
}

function conversationsOf(list: LinkedLocalServer[]): LocalServerConversationKey[] {
  const seen = new Map<string, LocalServerConversationKey>()
  for (const entry of list) seen.set(`${entry.workspaceId}\0${entry.agentId}`, entry)
  return [...seen.values()].map((entry) => ({ workspaceId: entry.workspaceId, agentId: entry.agentId }))
}

/** The stored links, or null when the file is not one this build can read. Entries it cannot read are skipped. */
function parseStoreFile(raw: string): LinkedLocalServer[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isObject(parsed) || parsed.version !== STORE_VERSION || !Array.isArray(parsed.servers)) return null
  const servers: LinkedLocalServer[] = []
  const ids = new Set<string>()
  for (const value of parsed.servers) {
    const entry = parseEntry(value)
    if (!entry || ids.has(entry.id)) continue
    ids.add(entry.id)
    servers.push(entry)
  }
  return servers
}

function parseEntry(value: unknown): LinkedLocalServer | null {
  if (!isObject(value)) return null
  const { id, workspaceId, agentId, url, title, command, cwd, linkedAt } = value
  if (!text(id, 200) || !text(workspaceId, 200) || !text(agentId, 200) || typeof url !== 'string') return null
  if (typeof linkedAt !== 'number' || !Number.isFinite(linkedAt)) return null
  const address = readLocalServerUrl(url)
  if (!address) return null
  if (command !== undefined && !text(command, STUDIO_LOCAL_SERVER_MAX_COMMAND)) return null
  if (cwd !== undefined && !(text(cwd, 4096) && isAbsolute(cwd))) return null
  return {
    id,
    workspaceId,
    agentId,
    url: address.url,
    title: typeof title === 'string' ? title.slice(0, MAX_TITLE) : '',
    host: address.host,
    port: address.port,
    ...(command ? { command } : {}),
    ...(cwd ? { cwd } : {}),
    linkedAt,
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}
