import { randomBytes, randomUUID } from 'node:crypto'
import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Duplex } from 'node:stream'

import type { StudioGrant } from '../../../packages/studio-protocol/src/public'
import { hashSecret, secretsMatch } from '../../main/automation/tailnet/secret-hash'
import { normalizeOrigin } from './web-origins'

// Embeds (phase 9 spec, 5.4; decisions R58 and R59): another page shows one
// Studio conversation, read-only, in an iframe the server serves.
//
// An embed is a token, not a session. A third-party frame gets no first-party
// cookies (browsers block or partition them, and `SameSite=Strict` refuses
// them anyway), so the iframe page carries the token in its fragment and
// trades it for a single-use socket ticket. What that socket may do is held
// three ways, so no one mistake widens it:
//
// - its grant is `conversation:read` and nothing else, not an owner's, so
//   every method that writes or that only the owner's views read is refused
//   by the router, and what it reads is redacted as any app's is;
// - a gate on the socket passes only the frames that follow or page through
//   the one conversation the embed names, and closes it on anything else;
// - the embed expires (24 hours unless asked, 30 days at most), and revoking
//   it closes its sockets with 4401.
//
// Who may frame the page is the embed's own list of origins, read on every
// load into `frame-ancestors`. An embed with none cannot be framed at all.
// Only the token's hash reaches disk (0600).

export const EMBEDS_FILENAME = 'embeds.json'
export const EMBED_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000
export const EMBED_MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000
const MAX_EMBEDS = 256
const MAX_ORIGINS = 16

/** The conversation an embed shows, by its workspace and agent: never a folder (an owner's address). */
export type EmbedConversation = { workspaceId: string; agentId: string }

/** An embed as its owner sees it listed. Never its token. */
export type Embed = {
  embedId: string
  conversation: EmbedConversation
  origins: string[]
  live: boolean
  createdAt: string
  expiresAt: string
}

type StoredEmbed = Embed & { tokenHash: string }

export type EmbedCreateInput = {
  conversation: { workspaceId?: unknown; agentId?: unknown }
  origins?: unknown
  ttlMs?: unknown
  live?: unknown
}

export type EmbedStore = {
  create(input: EmbedCreateInput): { ok: true; embed: Embed; token: string } | { ok: false; message: string }
  list(): Embed[]
  get(embedId: string): Embed | null
  /** The embed a token proves, when it is this embed's and still live. */
  authenticate(embedId: string, token: string): Embed | null
  revoke(embedId: string): boolean
  onRevoked(listener: (embedId: string) => void): () => void
  /** The grant an embed's socket says hello under: read-only, never an owner's. */
  grantFor(embedId: string): StudioGrant | null
}

const ID = /^[\w-]{1,200}$/u

export function createEmbedStore(options: {
  dataDir: string
  now?: () => number
  log?: (message: string) => void
}): EmbedStore {
  const now = options.now ?? Date.now
  const path = join(options.dataDir, EMBEDS_FILENAME)
  const revokedListeners = new Set<(embedId: string) => void>()
  let embeds: StoredEmbed[] = load()

  function load(): StoredEmbed[] {
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as { embeds?: unknown }
      if (!Array.isArray(raw.embeds)) return []
      return raw.embeds.filter((entry): entry is StoredEmbed => {
        const value = entry as Partial<StoredEmbed> | null
        return (
          typeof value?.embedId === 'string' &&
          typeof value.tokenHash === 'string' &&
          typeof value.expiresAt === 'string' &&
          typeof value.conversation?.workspaceId === 'string' &&
          typeof value.conversation.agentId === 'string' &&
          Array.isArray(value.origins)
        )
      })
    } catch {
      return []
    }
  }

  function save(): void {
    const staged = `${path}.${process.pid}.tmp`
    writeFileSync(staged, `${JSON.stringify({ embeds }, null, 2)}\n`, { mode: 0o600 })
    if (process.platform !== 'win32') chmodSync(staged, 0o600)
    renameSync(staged, path)
  }

  const live = (embed: StoredEmbed) => Date.parse(embed.expiresAt) > now()
  const view = ({ tokenHash: _tokenHash, ...embed }: StoredEmbed): Embed => ({
    ...embed,
    conversation: { ...embed.conversation },
    origins: [...embed.origins],
  })

  function prune(): void {
    const expired = embeds.filter((embed) => !live(embed))
    if (expired.length === 0) return
    embeds = embeds.filter(live)
    save()
    for (const embed of expired) announce(embed.embedId)
  }

  function announce(embedId: string): void {
    for (const listener of [...revokedListeners]) {
      try {
        listener(embedId)
      } catch (error) {
        options.log?.(`an embed revocation listener threw: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  return {
    create(input) {
      prune()
      const workspaceId = input.conversation?.workspaceId
      const agentId = input.conversation?.agentId
      if (typeof workspaceId !== 'string' || !ID.test(workspaceId) || typeof agentId !== 'string' || !ID.test(agentId))
        return { ok: false, message: 'An embed names one conversation, by its workspace and agent.' }
      const asked = Array.isArray(input.origins) ? input.origins : []
      if (asked.length > MAX_ORIGINS) return { ok: false, message: `An embed allows at most ${MAX_ORIGINS} origins.` }
      const origins: string[] = []
      for (const value of asked) {
        const origin = typeof value === 'string' ? normalizeOrigin(value) : null
        if (!origin) return { ok: false, message: `${String(value)} is not an origin (scheme, host and port).` }
        if (!origins.includes(origin)) origins.push(origin)
      }
      const ttl =
        input.ttlMs === undefined
          ? EMBED_DEFAULT_TTL_MS
          : typeof input.ttlMs === 'number' && Number.isFinite(input.ttlMs) && input.ttlMs > 0
            ? Math.min(input.ttlMs, EMBED_MAX_TTL_MS)
            : null
      if (ttl === null) return { ok: false, message: 'An embed lives for a positive number of milliseconds.' }
      // A frozen embed (a snapshot taken at minting) is not built yet.
      if (input.live === false) return { ok: false, message: 'Only live embeds are available in this version.' }
      if (embeds.length >= MAX_EMBEDS) return { ok: false, message: `Studio holds ${MAX_EMBEDS} embeds already.` }
      const token = `mcemb_${randomBytes(32).toString('base64url')}`
      const at = now()
      const stored: StoredEmbed = {
        embedId: randomUUID(),
        conversation: { workspaceId, agentId },
        origins,
        live: true,
        createdAt: new Date(at).toISOString(),
        expiresAt: new Date(at + ttl).toISOString(),
        tokenHash: hashSecret(token),
      }
      embeds = [...embeds, stored]
      save()
      return { ok: true, embed: view(stored), token }
    },
    list() {
      prune()
      return embeds.map(view)
    },
    get(embedId) {
      const found = embeds.find((embed) => embed.embedId === embedId)
      return found && live(found) ? view(found) : null
    },
    authenticate(embedId, token) {
      const found = embeds.find((embed) => embed.embedId === embedId)
      if (!found || !live(found) || !secretsMatch(found.tokenHash, hashSecret(token))) return null
      return view(found)
    },
    revoke(embedId) {
      const before = embeds.length
      embeds = embeds.filter((embed) => embed.embedId !== embedId)
      if (embeds.length === before) return false
      save()
      announce(embedId)
      return true
    },
    onRevoked(listener) {
      revokedListeners.add(listener)
      return () => revokedListeners.delete(listener)
    },
    grantFor(embedId) {
      const found = embeds.find((embed) => embed.embedId === embedId)
      if (!found || !live(found)) return null
      return {
        clientId: `embed:${found.embedId}`,
        name: 'Embedded conversation',
        owner: false,
        scopes: ['conversation:read'],
        ceiling: 'manual',
      }
    },
  }
}

/** Whether one client frame stays within the embed: following or paging through its one conversation. */
export function embedFrameAllowed(line: string, conversation: EmbedConversation): boolean {
  let frame: { t?: unknown; method?: unknown; topic?: unknown; params?: { key?: unknown } }
  try {
    frame = JSON.parse(line) as typeof frame
  } catch {
    return false
  }
  const names = (key: unknown) => {
    const value = key as { workspaceId?: unknown; agentId?: unknown; workspaceRoot?: unknown } | null
    return (
      value?.workspaceId === conversation.workspaceId &&
      value.agentId === conversation.agentId &&
      value.workspaceRoot === undefined
    )
  }
  switch (frame.t) {
    case 'hello':
    case 'unsub':
      return true
    case 'sub':
      return frame.topic === 'conversation.session' && names(frame.params?.key)
    case 'req':
      if (frame.method === 'server.ping' || frame.method === 'server.info') return true
      return (
        (frame.method === 'conversation.loadEarlier' ||
          frame.method === 'conversation.toolDetail' ||
          frame.method === 'conversation.turnDiff') &&
        names(frame.params?.key)
      )
    default:
      return false
  }
}

/**
 * The client's side of a socket, passing only the frames an embed may send.
 * Anything else ends the socket: a page that sends one is not the embed page.
 */
export function gateEmbedFrames(inner: Duplex, conversation: EmbedConversation): Duplex {
  let pending = ''
  const gated: Duplex = new Duplex({
    read() {
      inner.resume()
    },
    write(chunk: Buffer | string, encoding, callback) {
      inner.write(chunk, encoding as BufferEncoding, callback)
    },
    final(callback) {
      inner.end()
      callback()
    },
    destroy(error, callback) {
      inner.destroy()
      callback(error)
    },
  })
  inner.on('data', (chunk: Buffer | string) => {
    pending += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    let newline = pending.indexOf('\n')
    while (newline !== -1) {
      const line = pending.slice(0, newline)
      pending = pending.slice(newline + 1)
      if (line && !embedFrameAllowed(line, conversation)) {
        inner.destroy()
        gated.destroy()
        return
      }
      if (line && !gated.push(`${line}\n`)) inner.pause()
      newline = pending.indexOf('\n')
    }
  })
  inner.on('end', () => gated.push(null))
  inner.on('close', () => gated.destroy())
  return gated
}
