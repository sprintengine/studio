import {
  CONVERSATION_MAX_CLIENT_FRAME_BYTES,
  CONVERSATION_MAX_FRAME_BYTES,
  isConversationWirePermissionPreset,
  parseConversationHelloAnswer,
  parseConversationServerFrame,
  type ConversationHelloAnswer,
  type ConversationParsedServerFrame,
  type ConversationServerFrame,
  type ConversationWirePermissionPreset,
} from './conversation.js'
import { normalizeStudioScopes, type StudioScope } from './scopes.js'

// The connection envelope: one connection per client, carrying every
// namespace. A request is answered under its id; a stream is keyed by the
// subscription id the client chose, and its frames are the conversation
// lane's own server frames wrapped with that id, so every client parses one
// vocabulary (`parseConversationServerFrame`) whichever way it connected.
//
// On the owner socket — a Unix domain socket, or a named pipe on Windows —
// each frame is one line of JSON, the framing Studio's automation socket uses.
// A transport with message boundaries of its own carries the same frames one
// per message. Nothing below depends on which.
//
// The order on a connection is fixed: the client's `hello` first, answered by
// `welcome` (or by `bye` and a close); then any number of requests and
// subscriptions, in any order, each settled under its own id.

/** The largest frame a Studio writes. A bigger logical frame arrives as `chunk` frames. */
export const STUDIO_MAX_FRAME_BYTES = CONVERSATION_MAX_FRAME_BYTES
/**
 * The largest frame a client may send: a `send` at the message limit with
 * every character escaped, plus its envelope. A longer line is skipped and
 * refused under the id it carries.
 */
export const STUDIO_MAX_CLIENT_FRAME_BYTES = CONVERSATION_MAX_CLIENT_FRAME_BYTES
/** How long a connection may stay open before its `hello`. */
export const STUDIO_HELLO_TIMEOUT_MS = 10_000
/** The most chunks one logical frame is cut into. 32 MB at 48k characters a chunk is well under it. */
export const STUDIO_MAX_CHUNKS = 4096
// A chunk's text is re-escaped inside its envelope; at 3 bytes per UTF-16
// unit at worst this stays well under the frame cap.
const CHUNK_CHARS = 48_000

// ── Client → Studio ─────────────────────────────────────────────────────────

/**
 * What a client proves who it is with: the token it was paired with (or the
 * owner token), or a one-time pairing code the person minted in Studio's
 * Settings, which the `welcome` exchanges for a token. The code stays good
 * until that token is first presented, so a welcome lost with its connection
 * is answered again (with a fresh token, voiding the lost one).
 */
export type StudioAuth = { token: string } | { pairingCode: string }

/** What a client says about itself. `name` is for the audit and Settings, never for authority. */
export type StudioClientInfo = { name: string; version?: string; capabilities?: string[] }

export type StudioHelloFrame = {
  t: 'hello'
  /** The newest Studio protocol version the client speaks. */
  protocolVersion: number
  /** The oldest it still speaks; absent, only `protocolVersion`. */
  minProtocolVersion?: number
  client: StudioClientInfo
  auth: StudioAuth
}

export type StudioRequestFrame = { t: 'req'; id: string; method: string; params?: unknown }

/**
 * Where a stream resumes: the last sequence the client holds and the log
 * generation it came from, both from the `synchronized` fence it last saw.
 */
export type StudioCursor = { afterSeq: number; generation: string }

export type StudioSubscribeFrame = { t: 'sub'; id: string; topic: string; params?: unknown; cursor?: StudioCursor }

export type StudioUnsubscribeFrame = { t: 'unsub'; id: string }

export type StudioClientFrame = StudioHelloFrame | StudioRequestFrame | StudioSubscribeFrame | StudioUnsubscribeFrame

// ── Studio → client ─────────────────────────────────────────────────────────

/**
 * What a connected client may do. `ceiling` is the loosest permission preset
 * a chat it starts or switches may run on, and the loosest a chat may already
 * run on for the client to drive it; an owner's is `bypass`.
 */
export type StudioGrant = {
  clientId: string
  name: string
  owner: boolean
  scopes: StudioScope[]
  ceiling: ConversationWirePermissionPreset
}

/**
 * Which Studio this is. `id` is minted once per data directory, so a client
 * that reaches one Studio by two routes recognises it as one.
 */
export type StudioEnvironment = {
  id: string
  hostKind: 'local' | 'wsl' | 'ssh' | 'tailnet'
  os: string
  arch: string
}

export type StudioServerIdentity = { name: string; version: string }

export type StudioWelcomeFrame = {
  t: 'welcome'
  protocolVersion: number
  minProtocolVersion: number
  server: StudioServerIdentity
  environment: StudioEnvironment
  /** The Studio capabilities this server serves (`STUDIO_CAPABILITIES`). */
  capabilities: string[]
  /** The conversation contract's own `hello` answer, exactly as the tailnet lane gives it. */
  conversation: ConversationHelloAnswer
  grant: StudioGrant
  /**
   * Only on the welcome that redeemed a pairing code: the token this client
   * presents from now on. It is shown this once and is never readable again;
   * Studio keeps only its hash.
   */
  pairing?: { token: string }
}

/**
 * Why a request was refused, as a `res` carries it. A refusal told in stable
 * words in place of the real cause carries `errorId`: an opaque id Studio
 * logged beside that cause, for someone looking into it to quote.
 */
export type StudioErrorBody = { code: string; message: string; retryAfterMs?: number; errorId?: string }

export type StudioResponseFrame =
  { t: 'res'; id: string; ok: true; result: unknown } | { t: 'res'; id: string; ok: false; error: StudioErrorBody }

/** One frame of a stream: a conversation server frame (`snapshot`, `event`, `synchronized`). */
export type StudioStreamFrame = { t: 'frame'; sub: string; frame: ConversationServerFrame }

/**
 * One message of a stream that has no cursor: each is whole and replaces
 * nothing the client must keep in order (a list a CLI reported, a status). The
 * `payload` is the topic's own, documented with the topic; a reconnect simply
 * subscribes again. A client that does not know the type skips it.
 */
export type StudioPushFrame = { t: 'push'; sub: string; payload: unknown }

/**
 * A subscription that did not start, or that ended. When `retryable`,
 * subscribe again after `retryAfterMs` with the last cursor; otherwise the
 * stream is not available to this client.
 */
export type StudioSubscriptionFailedFrame = {
  t: 'subFailed'
  sub: string
  code: string
  message: string
  retryable: boolean
  retryAfterMs?: number
  /** As on a refused request: the id Studio logged the real cause under. */
  errorId?: string
}

/** A logical frame over `STUDIO_MAX_FRAME_BYTES`: its `json` strings, in `index` order, concatenate to it. */
export type StudioChunkFrame = { t: 'chunk'; frameId: string; index: number; total: number; json: string }

/** Studio is closing the connection, and why. With `retryAfterMs`, reconnect after that long. */
export type StudioByeFrame = { t: 'bye'; code: string; message: string; retryAfterMs?: number }

export type StudioServerFrame =
  | StudioWelcomeFrame
  | StudioResponseFrame
  | StudioStreamFrame
  | StudioPushFrame
  | StudioSubscriptionFailedFrame
  | StudioChunkFrame
  | StudioByeFrame

/** A server frame after validation: a stream's inner frame is the conversation lane's parsed frame. */
export type StudioParsedServerFrame =
  Exclude<StudioServerFrame, StudioStreamFrame> | { t: 'frame'; sub: string; frame: ConversationParsedServerFrame }

// ── Codes ───────────────────────────────────────────────────────────────────

/**
 * Why a request or subscription was refused. A Studio may add codes; a client
 * reads one it does not know as a refusal it cannot act on specially. A
 * failed `conversation.create` also passes through the launch's own codes
 * (`unknown_workspace`, `no_cli_selected`, `unknown_skill`, …).
 */
export const STUDIO_ERROR_CODES = [
  // The frame, or a request's params, are not in the documented shape.
  'invalid_frame',
  'invalid_params',
  'unknown_method',
  'unknown_topic',
  // The client's grant does not cover the method or topic.
  'scope_required',
  // The method or topic, or a member of its params, is for Studio's own connections.
  'owner_required',
  // The conversation the request names does not exist here.
  'not_found',
  // Studio could not carry it out. Retryable only with `retryAfterMs`.
  'unavailable',
  // Too many requests or streams are already open on this connection.
  'busy',
  // A request, a command or a response over its size limit.
  'too_large',
  // The chat runs, or would run, looser than the client's ceiling.
  'ceiling_exceeded',
  'unsafe_remote_decision',
  'unsupported_model',
  // A subscription id already in use on this connection.
  'duplicate_subscription',
  // The client fell too far behind a stream; resubscribe with the last cursor.
  'resync_required',
] as const

export type StudioErrorCode = (typeof STUDIO_ERROR_CODES)[number]

/** Why Studio closed a connection. */
export const STUDIO_BYE_CODES = [
  // No valid credential, or a pairing code that is spent, expired or wrong.
  'unauthorized',
  'unsupported_protocol_version',
  // The first frame was not a hello, or it came too late.
  'hello_required',
  // The client was revoked in Settings while connected.
  'revoked',
  // The client stopped reading; reconnect after `retryAfterMs` and resume.
  'resync_required',
  // Studio is quitting or restarting its listener; reconnect after `retryAfterMs`.
  'shutting_down',
  'too_many_connections',
  'invalid_frame',
  // Studio failed handling a frame; reconnect after `retryAfterMs` and resume.
  'internal_error',
] as const

export type StudioByeCode = (typeof STUDIO_BYE_CODES)[number]

// ── Validation ──────────────────────────────────────────────────────────────

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function id(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200
}
function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
function version(value: unknown): value is number {
  return integer(value) && value >= 1
}
function text(value: unknown, max = 20_000): value is string {
  return typeof value === 'string' && value.length <= max
}
function code(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z_]{1,64}$/.test(value)
}
function name(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 120
}
const CAPABILITY = /^[a-z][a-z0-9.-]{0,63}$/
function capabilities(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && CAPABILITY.test(entry)).slice(0, 64)
    : []
}
// A secret is printable ASCII without spaces: anything else is not one Studio minted.
function secret(value: unknown): value is string {
  return typeof value === 'string' && /^[\x21-\x7e]{16,256}$/.test(value)
}
function retry(value: Record<string, unknown>): { retryAfterMs?: number } {
  return integer(value.retryAfterMs) ? { retryAfterMs: value.retryAfterMs } : {}
}
function errorId(value: Record<string, unknown>): { errorId?: string } {
  return typeof value.errorId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value.errorId)
    ? { errorId: value.errorId }
    : {}
}

/** A stream cursor, or null when it is not one. */
export function parseStudioCursor(value: unknown): StudioCursor | null {
  return record(value) && integer(value.afterSeq) && id(value.generation)
    ? { afterSeq: value.afterSeq, generation: value.generation }
    : null
}

/**
 * Validate one client frame at the trust boundary, keeping only the members
 * the envelope defines. Params are checked per method, by
 * `parseStudioMethodParams`; here they are only carried.
 */
export function parseStudioClientFrame(value: unknown): StudioClientFrame | null {
  if (!record(value) || typeof value.t !== 'string') return null
  switch (value.t) {
    case 'hello': {
      if (!version(value.protocolVersion)) return null
      if (value.minProtocolVersion !== undefined && !version(value.minProtocolVersion)) return null
      const client = value.client
      if (!record(client) || !name(client.name)) return null
      if (client.version !== undefined && !text(client.version, 64)) return null
      const auth = value.auth
      if (!record(auth)) return null
      const credential: StudioAuth | null = secret(auth.token)
        ? { token: auth.token }
        : secret(auth.pairingCode)
          ? { pairingCode: auth.pairingCode }
          : null
      if (!credential) return null
      return {
        t: 'hello',
        protocolVersion: value.protocolVersion,
        ...(value.minProtocolVersion === undefined ? {} : { minProtocolVersion: value.minProtocolVersion as number }),
        client: {
          name: client.name.trim(),
          ...(client.version === undefined ? {} : { version: client.version as string }),
          ...(client.capabilities === undefined ? {} : { capabilities: capabilities(client.capabilities) }),
        },
        auth: credential,
      }
    }
    case 'req':
      return id(value.id) && typeof value.method === 'string' && value.method.length <= 100
        ? {
            t: 'req',
            id: value.id,
            method: value.method,
            ...(value.params === undefined ? {} : { params: value.params }),
          }
        : null
    case 'sub': {
      if (!id(value.id) || typeof value.topic !== 'string' || value.topic.length > 100) return null
      const cursor = value.cursor === undefined ? undefined : parseStudioCursor(value.cursor)
      if (cursor === null) return null
      return {
        t: 'sub',
        id: value.id,
        topic: value.topic,
        ...(value.params === undefined ? {} : { params: value.params }),
        ...(cursor ? { cursor } : {}),
      }
    }
    case 'unsub':
      return id(value.id) ? { t: 'unsub', id: value.id } : null
    default:
      return null
  }
}

/**
 * The id a refused client frame is answered under: a request's or a
 * subscription's, when it carries a usable one. A frame with neither can only
 * be answered by closing the connection.
 */
export function studioClientFrameIds(value: unknown): { requestId?: string; subscriptionId?: string } {
  if (!record(value) || !id(value.id)) return {}
  if (value.t === 'req') return { requestId: value.id }
  if (value.t === 'sub' || value.t === 'unsub') return { subscriptionId: value.id }
  return {}
}

const SERVER_FRAME_TYPES = new Set(['welcome', 'res', 'frame', 'push', 'subFailed', 'chunk', 'bye'])

/**
 * Whether a frame's `t` is one this version of the envelope defines. A client
 * ignores a frame of any other type — a newer Studio may send one — but a
 * frame of a known type that `parseStudioServerFrame` refuses is broken.
 */
export function isKnownStudioServerFrameType(value: unknown): boolean {
  return record(value) && typeof value.t === 'string' && SERVER_FRAME_TYPES.has(value.t)
}

function grant(value: unknown): StudioGrant | null {
  if (!record(value) || !id(value.clientId) || !name(value.name) || typeof value.owner !== 'boolean') return null
  if (!isConversationWirePermissionPreset(value.ceiling)) return null
  return {
    clientId: value.clientId,
    name: value.name,
    owner: value.owner,
    scopes: normalizeStudioScopes(value.scopes),
    ceiling: value.ceiling,
  }
}

function environment(value: unknown): StudioEnvironment | null {
  if (!record(value) || !id(value.id) || !text(value.os, 64) || !text(value.arch, 64)) return null
  if (!['local', 'wsl', 'ssh', 'tailnet'].includes(value.hostKind as string)) return null
  return { id: value.id, hostKind: value.hostKind as StudioEnvironment['hostKind'], os: value.os, arch: value.arch }
}

/**
 * Validate one frame from a Studio, keeping only the members the envelope
 * defines. Null for a frame of an unknown type, or of a known type in the
 * wrong shape; `isKnownStudioServerFrameType` tells the two apart. A stream
 * frame whose inner conversation frame does not parse is refused whole, so a
 * client never advances a cursor past an event it could not read.
 */
export function parseStudioServerFrame(value: unknown): StudioParsedServerFrame | null {
  if (!isKnownStudioServerFrameType(value)) return null
  const frame = value as Record<string, unknown>
  switch (frame.t) {
    case 'welcome': {
      const server = frame.server
      const conversation = parseConversationHelloAnswer(frame.conversation)
      const granted = grant(frame.grant)
      const where = environment(frame.environment)
      if (!version(frame.protocolVersion) || !version(frame.minProtocolVersion)) return null
      if (!record(server) || !text(server.name, 120) || !text(server.version, 64)) return null
      if (!conversation || !granted || !where || !Array.isArray(frame.capabilities)) return null
      const pairing = frame.pairing
      if (pairing !== undefined && !(record(pairing) && secret(pairing.token))) return null
      return {
        t: 'welcome',
        protocolVersion: frame.protocolVersion,
        minProtocolVersion: frame.minProtocolVersion,
        server: { name: server.name, version: server.version },
        environment: where,
        capabilities: capabilities(frame.capabilities),
        conversation,
        grant: granted,
        ...(pairing === undefined ? {} : { pairing: { token: (pairing as { token: string }).token } }),
      }
    }
    case 'res': {
      if (!id(frame.id) || typeof frame.ok !== 'boolean') return null
      if (frame.ok) return { t: 'res', id: frame.id, ok: true, result: frame.result }
      const error = frame.error
      if (!record(error) || !code(error.code) || !text(error.message)) return null
      return {
        t: 'res',
        id: frame.id,
        ok: false,
        error: { code: error.code, message: error.message, ...retry(error), ...errorId(error) },
      }
    }
    case 'frame': {
      if (!id(frame.sub)) return null
      const inner = parseConversationServerFrame(frame.frame)
      return inner ? { t: 'frame', sub: frame.sub, frame: inner } : null
    }
    case 'push':
      return id(frame.sub) && Object.hasOwn(frame, 'payload')
        ? { t: 'push', sub: frame.sub, payload: frame.payload }
        : null
    case 'subFailed':
      return id(frame.sub) && code(frame.code) && text(frame.message) && typeof frame.retryable === 'boolean'
        ? {
            t: 'subFailed',
            sub: frame.sub,
            code: frame.code,
            message: frame.message,
            retryable: frame.retryable,
            ...retry(frame),
            ...errorId(frame),
          }
        : null
    case 'chunk':
      return id(frame.frameId) &&
        integer(frame.total) &&
        frame.total > 0 &&
        frame.total <= STUDIO_MAX_CHUNKS &&
        integer(frame.index) &&
        frame.index < frame.total &&
        typeof frame.json === 'string'
        ? { t: 'chunk', frameId: frame.frameId, index: frame.index, total: frame.total, json: frame.json }
        : null
    case 'bye':
      return code(frame.code) && text(frame.message)
        ? { t: 'bye', code: frame.code, message: frame.message, ...retry(frame) }
        : null
    default:
      return null
  }
}

// ── Chunking ────────────────────────────────────────────────────────────────

/**
 * One encoded logical frame as the wire frames that carry it: itself when it
 * fits `STUDIO_MAX_FRAME_BYTES`, else `chunk` frames under `frameId`. A Studio
 * writes a logical frame's chunks one after another, with nothing between.
 */
export function studioWireFrames(json: string, frameId: string): string[] {
  if (utf8Length(json) <= STUDIO_MAX_FRAME_BYTES) return [json]
  const total = Math.ceil(json.length / CHUNK_CHARS)
  const frames: string[] = []
  for (let index = 0; index < total; index++) {
    frames.push(
      JSON.stringify({
        t: 'chunk',
        frameId,
        index,
        total,
        json: json.slice(index * CHUNK_CHARS, (index + 1) * CHUNK_CHARS),
      } satisfies StudioChunkFrame),
    )
  }
  return frames
}

/** What an assembler made of one chunk. */
export type StudioChunkStep = { kind: 'pending' } | { kind: 'frame'; json: string } | { kind: 'error'; message: string }

/**
 * Reassembles chunked frames on a client. Chunks of one frame arrive
 * contiguously and in order; a chunk out of order, or one of another frame
 * before the last is complete, is an error, and the connection should be
 * dropped and resumed from its cursors rather than guessed at.
 */
export function createStudioChunkAssembler(): { push(chunk: StudioChunkFrame): StudioChunkStep } {
  let current: { frameId: string; total: number; parts: string[] } | null = null
  return {
    push(chunk) {
      if (!current) {
        if (chunk.index !== 0) return { kind: 'error', message: 'A chunked frame started mid-way.' }
        current = { frameId: chunk.frameId, total: chunk.total, parts: [] }
      }
      if (chunk.frameId !== current.frameId || chunk.total !== current.total || chunk.index !== current.parts.length) {
        current = null
        return { kind: 'error', message: 'A chunked frame arrived out of order.' }
      }
      current.parts.push(chunk.json)
      if (current.parts.length < current.total) return { kind: 'pending' }
      const json = current.parts.join('')
      current = null
      return { kind: 'frame', json }
    },
  }
}

// The UTF-8 length of a string, without a Buffer: this package runs in a
// browser as well as in Node.
function utf8Length(value: string): number {
  let bytes = 0
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index)
    if (unit < 0x80) bytes += 1
    else if (unit < 0x800) bytes += 2
    else if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4
        index++
      } else bytes += 3
    } else bytes += 3
  }
  return bytes
}
