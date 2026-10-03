import { randomBytes } from 'node:crypto'

import {
  createPreviewProxy,
  type PreviewLoopbackName,
  type PreviewProxy,
  type PreviewProxyOptions,
} from './preview-proxy'
import { listAgentListeners, type AgentListener } from './preview-ports'

// The previews a web tab has open (phase 9 spec, 3.6; decision R77): which
// ports may be offered, opening one on a listener of its own, and closing it
// again. Only an owner's session reaches this (the web front door asks), so a
// port the person types is allowed as well as one an agent listens on; never
// a port below 1024, never one of the server's own, and the target is always
// the server's loopback, so this is not a way to reach another host.
//
// A preview closes when its tab asks, when its browser session is removed,
// after thirty minutes with no request, or when the server stops. A session
// holds at most eight.

export const MAX_PREVIEWS_PER_SESSION = 8
export const PREVIEW_IDLE_MS = 30 * 60 * 1000
const IDLE_CHECK_MS = 60 * 1000
const MIN_TYPED_PORT = 1024

export type PreviewView = {
  previewId: string
  port: number
  origin: string
  openedAt: number
  lastUsedAt: number
}

export type PreviewOpenResult =
  { ok: true; previewId: string; origin: string; enterUrl: string } | { ok: false; message: string }

export type PreviewService = {
  /** The ports an agent of this server listens on. */
  list(): Promise<{ ports: AgentListener[] }>
  open(input: {
    port: unknown
    sessionId: string
    typed?: boolean
    /** The loopback name the asking tab was opened on; the preview opens on the same one. */
    name?: PreviewLoopbackName
  }): Promise<PreviewOpenResult>
  close(previewId: string, sessionId: string): Promise<boolean>
  previewsOf(sessionId: string): PreviewView[]
  /** Close every preview a session holds: it was removed, or it ran out. */
  closeSession(sessionId: string): Promise<void>
  /** Hear a session's previews, whole, on every change. */
  onChanged(listener: (sessionId: string, previews: PreviewView[]) => void): () => void
  stop(): Promise<void>
}

export type PreviewServiceOptions = {
  /** The server's own listening ports, never offered or opened. */
  ownPorts: () => readonly number[]
  /** Studio's own origins: the pages that may frame a preview. */
  studioOrigins: () => readonly string[]
  listPorts?: () => Promise<AgentListener[]>
  createProxy?: (options: PreviewProxyOptions) => PreviewProxy
  now?: () => number
  idleCheckMs?: number
  log?: (message: string) => void
}

type Open = {
  previewId: string
  sessionId: string
  port: number
  openedAt: number
  proxy: PreviewProxy
  name: PreviewLoopbackName
}

export function createPreviewService(options: PreviewServiceOptions): PreviewService {
  const now = options.now ?? Date.now
  const make = options.createProxy ?? createPreviewProxy
  const listPorts =
    options.listPorts ?? (() => listAgentListeners({ rootPid: process.pid, ownPorts: options.ownPorts() }))
  const open = new Map<string, Open>()
  const listeners = new Set<(sessionId: string, previews: PreviewView[]) => void>()

  const view = (entry: Open): PreviewView => ({
    previewId: entry.previewId,
    port: entry.port,
    origin: entry.proxy.origin(entry.name),
    openedAt: entry.openedAt,
    lastUsedAt: entry.proxy.lastUsedAt(),
  })
  const previewsOf = (sessionId: string) =>
    [...open.values()].filter((entry) => entry.sessionId === sessionId).map(view)

  function announce(sessionId: string): void {
    const previews = previewsOf(sessionId)
    for (const listener of [...listeners]) {
      try {
        listener(sessionId, previews)
      } catch (error) {
        options.log?.(`a previews listener threw: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  async function closeEntry(entry: Open): Promise<void> {
    if (!open.delete(entry.previewId)) return
    await entry.proxy.stop().catch(() => undefined)
    announce(entry.sessionId)
  }

  const idle = setInterval(() => {
    const at = now()
    for (const entry of [...open.values()]) {
      if (at - entry.proxy.lastUsedAt() >= PREVIEW_IDLE_MS) void closeEntry(entry)
    }
  }, options.idleCheckMs ?? IDLE_CHECK_MS)
  idle.unref()

  return {
    async list() {
      const own = new Set(options.ownPorts())
      return { ports: (await listPorts().catch(() => [])).filter((entry) => !own.has(entry.port)) }
    },

    async open(input) {
      const port = input.port
      if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535)
        return { ok: false, message: 'A preview is of a port number.' }
      if (options.ownPorts().includes(port)) return { ok: false, message: `Port ${port} is Studio's own.` }
      if (port < MIN_TYPED_PORT) return { ok: false, message: `Ports below ${MIN_TYPED_PORT} are not previewed.` }
      // A port the person typed may be any above the system range; one that
      // was not typed must be one an agent listens on.
      if (input.typed !== true) {
        const listed = await listPorts().catch(() => [])
        if (!listed.some((entry) => entry.port === port))
          return { ok: false, message: `No agent of this Studio listens on port ${port}.` }
      }
      // The same port twice in one session is one preview, with a fresh way in.
      const existing = [...open.values()].find((entry) => entry.sessionId === input.sessionId && entry.port === port)
      const name = input.name ?? '127.0.0.1'
      if (existing) {
        existing.name = name
        const { enterUrl } = existing.proxy.mintEnterCode(name)
        return { ok: true, previewId: existing.previewId, origin: existing.proxy.origin(name), enterUrl }
      }
      if (previewsOf(input.sessionId).length >= MAX_PREVIEWS_PER_SESSION) {
        return {
          ok: false,
          message: `This browser has ${MAX_PREVIEWS_PER_SESSION} previews open already. Close one first.`,
        }
      }
      const previewId = randomBytes(9).toString('base64url')
      const proxy = make({
        previewId,
        targetPort: port,
        studioOrigins: options.studioOrigins(),
        now,
        log: options.log,
      })
      try {
        await proxy.start()
      } catch (error) {
        return {
          ok: false,
          message: `The preview could not start: ${error instanceof Error ? error.message : String(error)}`,
        }
      }
      open.set(previewId, { previewId, sessionId: input.sessionId, port, openedAt: now(), proxy, name })
      const { enterUrl } = proxy.mintEnterCode(name)
      announce(input.sessionId)
      return { ok: true, previewId, origin: proxy.origin(name), enterUrl }
    },

    async close(previewId, sessionId) {
      const entry = open.get(previewId)
      // Another session's preview is not this one's to close.
      if (!entry || entry.sessionId !== sessionId) return false
      await closeEntry(entry)
      return true
    },

    previewsOf,

    async closeSession(sessionId) {
      await Promise.all([...open.values()].filter((entry) => entry.sessionId === sessionId).map(closeEntry))
    },

    onChanged(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    async stop() {
      clearInterval(idle)
      const all = [...open.values()]
      open.clear()
      await Promise.all(all.map((entry) => entry.proxy.stop().catch(() => undefined)))
    },
  }
}
