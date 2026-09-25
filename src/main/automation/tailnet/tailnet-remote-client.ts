import { randomBytes } from 'crypto'
import { request as httpRequest } from 'http'
import { connect, type Socket } from 'net'

import {
  isTailnetScope,
  type TailnetPairRequestOutcome,
  type TailnetReverseGrant,
  type TailnetScope,
} from '../../../shared/tailnet'
import {
  checkTailnetTransportVersion,
  TAILNET_IDENTITY_PATH,
  TAILNET_MCP_PATH,
  TAILNET_PAIR_PATH,
  TAILNET_PAIR_COLLECT_PATH,
  TAILNET_PAIR_REQUEST_PATH,
  TAILNET_EVENTS_PATH,
  TAILNET_TERMINAL_PATH,
  TAILNET_WS_TICKET_PATH,
} from './tailnet-routes'
import {
  computeWebSocketAcceptKey,
  createWebSocketFrameDecoder,
  encodeMaskedCloseFrame,
  encodeMaskedPongFrame,
  encodeMaskedTextFrame,
  MAX_WEBSOCKET_MESSAGE_BYTES,
  WEBSOCKET_CLOSE_NORMAL,
} from './websocket-frames'
import { asRecord } from '../../../shared/records'

// The outbound client for tailnet remote control: the half that DIALS
// another machine's listener. Everything else under `tailnet/` answers calls;
// this places them.
//
// It lives in the main process, and not because that is convenient: the
// listener refuses any request carrying an `Origin` header, which a renderer's
// fetch and WebSocket both always send. The device token belongs here for the
// same kind of reason — a credential handed to a window is a credential one
// renderer bug away from the tailnet.
//
// Deliberately the same wire the stdio bridge speaks (`resources/automation/
// mcp-stdio-bridge.mjs`), because it IS the same protocol; the bridge cannot be
// imported (it is a dependency-free script for machines with no Studio at all)
// but the framing here is the app's own codec rather than a third copy.

/** A wrong port that accepts TCP and then says nothing must not hang the UI behind it. */
const REQUEST_TIMEOUT_MS = 10_000
/** The upgrade handshake only. An attached terminal is idle most of its life and is never timed out. */
const HANDSHAKE_TIMEOUT_MS = 10_000
/** Enough for any control response; a body larger than this is not our listener answering. */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024

export type TailnetEndpoint = { host: string; port: number }

export type RemoteCallOutcome<T> = { ok: true; value: T } | { ok: false; code: string; message: string }

/**
 * Split `host:port` — including the `[v6]:port` form the listener publishes.
 *
 * Returns null rather than guessing a port: an endpoint we cannot read is one we
 * must not dial, because the guess would be a request to somewhere nobody chose.
 */
export function parseTailnetEndpoint(value: string): TailnetEndpoint | null {
  const trimmed = value.trim()
  const bracketed = /^\[([^\]]+)\]:(\d+)$/u.exec(trimmed)
  if (bracketed) {
    const port = Number(bracketed[2])
    return isPort(port) ? { host: bracketed[1], port } : null
  }
  const separator = trimmed.lastIndexOf(':')
  if (separator <= 0) return null
  const host = trimmed.slice(0, separator)
  const port = Number(trimmed.slice(separator + 1))
  // An unbracketed colon in the host means a bare IPv6 literal, which is
  // ambiguous with the port separator; refuse it rather than truncate an address.
  if (!host || host.includes(':') || !isPort(port)) return null
  return { host, port }
}

export function formatTailnetEndpoint(endpoint: TailnetEndpoint): string {
  return endpoint.host.includes(':') ? `[${endpoint.host}]:${endpoint.port}` : `${endpoint.host}:${endpoint.port}`
}

/** A `sprintengine-tailnet://pair?…` link, as the other machine's Settings shows it. */
export function parsePairingUrl(value: string): { endpoint: TailnetEndpoint; pairingToken: string } | null {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'sprintengine-tailnet:') return null
  const endpointValue = url.searchParams.get('endpoint')
  const pairingToken = url.searchParams.get('token')
  if (!endpointValue || !pairingToken) return null
  const endpoint = parseTailnetEndpoint(endpointValue)
  return endpoint ? { endpoint, pairingToken } : null
}

type JsonAnswer = { status: number; body: unknown }

/** One HTTP round trip to a listener. Never throws for a status; a status is an answer. */
export function requestTailnetJson(input: {
  endpoint: TailnetEndpoint
  method: 'GET' | 'POST'
  path: string
  token?: string
  body?: unknown
  timeoutMs?: number
}): Promise<JsonAnswer> {
  const payload = input.body === undefined ? undefined : Buffer.from(JSON.stringify(input.body), 'utf8')
  const timeoutMs = input.timeoutMs ?? REQUEST_TIMEOUT_MS
  return new Promise((resolve, reject) => {
    const call = httpRequest(
      {
        host: input.endpoint.host,
        port: input.endpoint.port,
        method: input.method,
        path: input.path,
        headers: {
          Accept: 'application/json',
          Connection: 'close',
          // No Origin, ever: the listener refuses any request carrying one, and
          // rightly — see the transport notes in the knowledge graph.
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
          ...(input.token ? { Authorization: `Bearer ${input.token}` } : {}),
        },
      },
      (response) => {
        const chunks: Buffer[] = []
        let bytes = 0
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length
          if (bytes > MAX_RESPONSE_BYTES) {
            response.destroy()
            reject(new Error('the answer was larger than this transport carries'))
            return
          }
          chunks.push(chunk)
        })
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let body: unknown = null
          try {
            body = text ? JSON.parse(text) : null
          } catch {
            body = null
          }
          resolve({ status: response.statusCode ?? 0, body })
        })
        response.on('error', reject)
      },
    )
    call.on('error', reject)
    call.setTimeout(timeoutMs, () => {
      call.destroy(new Error(`no answer within ${Math.round(timeoutMs / 1000)}s`))
    })
    if (payload) call.write(payload)
    call.end()
  })
}

/** Redeem a one-time pairing code for a device token this machine can keep. */
export async function pairWithMachine(input: {
  endpoint: TailnetEndpoint
  pairingToken: string
  deviceName: string
}): Promise<RemoteCallOutcome<{ deviceId: string; deviceName: string; deviceToken: string; scopes: TailnetScope[] }>> {
  let answer: JsonAnswer
  try {
    answer = await requestTailnetJson({
      endpoint: input.endpoint,
      method: 'POST',
      path: TAILNET_PAIR_PATH,
      body: { pairingToken: input.pairingToken, deviceName: input.deviceName },
    })
  } catch (error) {
    return {
      ok: false,
      code: 'unreachable',
      message: `Could not reach ${formatTailnetEndpoint(input.endpoint)}: ${message(error)}.`,
    }
  }
  const record = asRecord(answer.body)
  if (answer.status !== 200 || typeof record?.deviceToken !== 'string') {
    const error = asRecord(record?.error)
    return {
      ok: false,
      code: typeof error?.code === 'string' ? error.code : `http_${answer.status}`,
      // The other machine's own words. A pairing refusal is the one moment a
      // person needs the exact reason — expired, already spent, wrong code.
      message: typeof error?.message === 'string' ? error.message : `Pairing was refused (HTTP ${answer.status}).`,
    }
  }
  return {
    ok: true,
    value: {
      deviceId: typeof record.deviceId === 'string' ? record.deviceId : '',
      deviceName: typeof record.deviceName === 'string' ? record.deviceName : input.deviceName,
      deviceToken: record.deviceToken,
      scopes: readScopes(record.scopes),
    },
  }
}

/**
 * Ask a machine to pair, for someone there to approve.
 *
 * Only the HASH of the collect secret goes over the wire; the secret itself
 * stays here and is presented to collect. The answer carries the comparison
 * code so this machine can show the same six digits the other one is showing.
 */
export async function requestPairingFromMachine(input: {
  endpoint: TailnetEndpoint
  deviceName: string
  collectHash: string
  /**
   * What this machine asks to be allowed to do there. Omitted rather than
   * defaulted when the caller names nothing: the far end owns that default, and
   * sending our idea of it would make an older listener and a newer one
   * disagree about a set neither of us chose.
   */
  scopes?: readonly TailnetScope[]
}): Promise<RemoteCallOutcome<{ requestId: string; comparisonCode: string; expiresAt: string }>> {
  let answer: JsonAnswer
  try {
    answer = await requestTailnetJson({
      endpoint: input.endpoint,
      method: 'POST',
      path: TAILNET_PAIR_REQUEST_PATH,
      body: {
        deviceName: input.deviceName,
        collectHash: input.collectHash,
        ...(input.scopes ? { scopes: [...input.scopes] } : {}),
      },
    })
  } catch (error) {
    return {
      ok: false,
      code: 'unreachable',
      message: `Could not reach ${formatTailnetEndpoint(input.endpoint)}: ${message(error)}.`,
    }
  }
  const record = asRecord(answer.body)
  if (answer.status !== 200 || typeof record?.requestId !== 'string') {
    const error = asRecord(record?.error)
    return {
      ok: false,
      code: typeof error?.code === 'string' ? error.code : `http_${answer.status}`,
      // The other machine's own words again — "there is already a request
      // waiting there" is the one thing a person needs to hear verbatim.
      message: typeof error?.message === 'string' ? error.message : `The request was refused (HTTP ${answer.status}).`,
    }
  }
  return {
    ok: true,
    value: {
      requestId: record.requestId,
      comparisonCode: typeof record.comparisonCode === 'string' ? record.comparisonCode : '',
      expiresAt: typeof record.expiresAt === 'string' ? record.expiresAt : '',
    },
  }
}

/**
 * Poll a request we made. The device token comes back to exactly one call.
 *
 * A POST with a body rather than the original GET (phase 6): when this
 * machine offered the other one a device here, `reverse` rides on the poll,
 * and the approver's listener stores it in the same exchange that hands our
 * token over. Sent on every poll rather than only the last, because there is
 * no way to know which poll will be the one that finds the approval.
 */
export async function collectPairingFromMachine(input: {
  endpoint: TailnetEndpoint
  requestId: string
  collectSecret: string
  reverse?: TailnetReverseGrant | null
}): Promise<RemoteCallOutcome<TailnetPairRequestOutcome>> {
  let answer: JsonAnswer
  try {
    answer = await requestTailnetJson({
      endpoint: input.endpoint,
      method: 'POST',
      path: TAILNET_PAIR_COLLECT_PATH,
      body: {
        id: input.requestId,
        secret: input.collectSecret,
        ...(input.reverse ? { reverse: input.reverse } : {}),
      },
    })
  } catch (error) {
    // A machine that has gone to sleep mid-wait is not a refusal: the caller
    // keeps polling rather than tearing the request down.
    return {
      ok: false,
      code: 'unreachable',
      message: `Could not reach ${formatTailnetEndpoint(input.endpoint)}: ${message(error)}.`,
    }
  }
  const record = asRecord(answer.body)
  const status = typeof record?.status === 'string' ? record.status : ''
  if (answer.status !== 200 || !status) {
    return { ok: false, code: `http_${answer.status}`, message: `The machine answered oddly (HTTP ${answer.status}).` }
  }
  if (status === 'approved') {
    return {
      ok: true,
      value: {
        status: 'approved',
        deviceId: typeof record?.deviceId === 'string' ? record.deviceId : '',
        deviceName: typeof record?.deviceName === 'string' ? record.deviceName : '',
        deviceToken: typeof record?.deviceToken === 'string' ? record.deviceToken : '',
        scopes: readScopes(record?.scopes),
      },
    }
  }
  if (status === 'pending') {
    return {
      ok: true,
      value: {
        status: 'pending',
        comparisonCode: typeof record?.comparisonCode === 'string' ? record.comparisonCode : '',
        expiresAt: typeof record?.expiresAt === 'string' ? record.expiresAt : '',
      },
    }
  }
  return { ok: true, value: { status: status === 'denied' ? 'denied' : 'expired' } }
}

/** What one authenticated handshake with a machine established. */
export type RemoteIdentity = {
  deviceId: string
  deviceName: string
  scopes: TailnetScope[]
  /** The wire that machine speaks; always inside this build's window, or the call refused. */
  transportVersion: number
  /**
   * What that machine says it can do, in its own words. Ask this before using
   * anything the transport did not always have, rather than inferring it from
   * `transportVersion` — see `tailnetPeerSupports`.
   *
   * Null when the peer published no list at all, which is not the same fact as
   * an empty one and must not be flattened into it: an empty list is a machine
   * saying it can do nothing, null is a machine that was never asked the
   * question. Builds from the day between the change feed shipping and the
   * capability list being advertised are exactly that, and a caller that reads
   * their silence as a denial would switch off a feature they serve.
   */
  capabilities: string[] | null
}

/**
 * What the remote says our device is and may do, right now.
 *
 * This is the handshake, and so it is where the transport version is enforced
 * (the first version shipped without that check, and a mismatched peer then failed later
 * on a payload shape instead). A machine outside the window is refused here
 * with a named code, so the Fleet records it as unreachable-with-a-reason
 * rather than as a machine that answered and then behaved oddly.
 *
 * `timeoutMs` is for the reachability check (phase 4), which asks this of
 * every paired machine on a timer: a sleeping laptop should cost a few
 * seconds per interval, not the ten a person-driven browse can afford.
 */
export async function readRemoteIdentity(input: {
  endpoint: TailnetEndpoint
  token: string
  timeoutMs?: number
}): Promise<RemoteCallOutcome<RemoteIdentity>> {
  let answer: JsonAnswer
  try {
    answer = await requestTailnetJson({
      endpoint: input.endpoint,
      method: 'GET',
      path: TAILNET_IDENTITY_PATH,
      token: input.token,
      timeoutMs: input.timeoutMs,
    })
  } catch (error) {
    return { ok: false, code: 'unreachable', message: describeUnreachable(input.endpoint, error) }
  }
  if (answer.status === 401) return { ok: false, code: 'unauthorized', message: UNAUTHORIZED_MESSAGE }
  const record = asRecord(answer.body)
  if (answer.status !== 200 || !record) {
    return { ok: false, code: `http_${answer.status}`, message: `That machine answered HTTP ${answer.status}.` }
  }
  const refusal = checkTailnetTransportVersion(record.transportVersion)
  if (refusal) return { ok: false, code: refusal.code, message: refusal.message }
  return {
    ok: true,
    value: {
      deviceId: typeof record.deviceId === 'string' ? record.deviceId : '',
      deviceName: typeof record.deviceName === 'string' ? record.deviceName : '',
      scopes: readScopes(record.scopes),
      transportVersion: record.transportVersion as number,
      capabilities: readCapabilities(record.capabilities),
    },
  }
}

/**
 * The capability list out of a handshake, or null when the peer named none.
 *
 * Anything that is not a string is dropped, but the list is not filtered
 * against our own: a peer may publish names this build has never heard of, and
 * the list is only ever asked "is X in here".
 */
function readCapabilities(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  return value.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.slice(0, 64))
}

/**
 * Call one gateway tool on the remote machine.
 *
 * Over the stateless POST endpoint rather than the WebSocket: these are
 * one-shot reads for a panel, they carry no connection-scoped declaration, and
 * holding a socket open per browse would be a socket per machine for a list
 * somebody glanced at.
 *
 * A tool that refuses (out of scope, unknown workspace) comes back as
 * `{ok:false}` with the tool's own code — never as an empty success.
 */
export async function callRemoteTool(input: {
  endpoint: TailnetEndpoint
  token: string
  tool: string
  args?: Record<string, unknown>
  timeoutMs?: number
}): Promise<RemoteCallOutcome<Record<string, unknown>>> {
  let answer: JsonAnswer
  try {
    answer = await requestTailnetJson({
      endpoint: input.endpoint,
      method: 'POST',
      path: TAILNET_MCP_PATH,
      token: input.token,
      timeoutMs: input.timeoutMs,
      body: {
        jsonrpc: '2.0',
        id: `fleet-${randomBytes(6).toString('hex')}`,
        method: 'tools/call',
        params: { name: input.tool, arguments: input.args ?? {} },
      },
    })
  } catch (error) {
    return { ok: false, code: 'unreachable', message: describeUnreachable(input.endpoint, error) }
  }
  if (answer.status === 401) return { ok: false, code: 'unauthorized', message: UNAUTHORIZED_MESSAGE }
  const envelope = asRecord(answer.body)
  if (answer.status !== 200 || !envelope) {
    return { ok: false, code: `http_${answer.status}`, message: `"${input.tool}" answered HTTP ${answer.status}.` }
  }
  const rpcError = asRecord(envelope.error)
  if (rpcError) {
    return {
      ok: false,
      code: 'rpc_error',
      message: typeof rpcError.message === 'string' ? rpcError.message : `"${input.tool}" failed on that machine.`,
    }
  }
  const result = asRecord(envelope.result)
  const structured = asRecord(result?.structuredContent)
  if (!structured) {
    return {
      ok: false,
      code: 'unreadable_result',
      message: `"${input.tool}" answered in a shape this build cannot read.`,
    }
  }
  if (result?.isError === true || structured.ok === false) {
    const failure = asRecord(structured.error)
    return {
      ok: false,
      code: typeof failure?.code === 'string' ? failure.code : 'tool_error',
      message: typeof failure?.message === 'string' ? failure.message : `"${input.tool}" was refused by that machine.`,
    }
  }
  return { ok: true, value: structured }
}

export type RemoteTerminalSocket = {
  /** Send one client frame (`input` or `resize`). No-op once closed. */
  send(frame: Record<string, unknown>): void
  /** Close from this end, telling the peer why. */
  close(reason: string): void
  isOpen(): boolean
}

export type RemoteTerminalSocketHandlers = {
  /** One decoded server frame: replay, output, attached, exit, ended, error. */
  onFrame(frame: Record<string, unknown>): void
  /**
   * The socket is finished. `code` is the peer's WebSocket close code where it
   * sent one (4401 means the device was revoked mid-stream), and `reason` is a
   * sentence for a person.
   */
  onClosed(outcome: { code: number | null; reason: string }): void
}

/**
 * Attach to one remote terminal session over its own WebSocket.
 *
 * Its own socket per attachment, mirroring the server side: a terminal printing
 * a build log is the chattiest thing this transport carries, and sharing would
 * put a browse behind it.
 */
export async function openRemoteTerminalSocket(input: {
  endpoint: TailnetEndpoint
  token: string
  sessionId: string
  /**
   * Where this pane's screen already stands in the session's output, from an
   * earlier dial. A host that still retains what follows sends only that; any
   * other host — including one from before resuming existed, which ignores
   * the parameters — sends the full replay.
   */
  resume?: { stream: string; position: number } | null
  handlers: RemoteTerminalSocketHandlers
}): Promise<RemoteCallOutcome<RemoteTerminalSocket>> {
  // The upgrade carries a 30-second single-use ticket, never the device token:
  // a query string lands in logs and history, so the long-lived credential is
  // only ever an Authorization header.
  let ticketAnswer: JsonAnswer
  try {
    ticketAnswer = await requestTailnetJson({
      endpoint: input.endpoint,
      method: 'POST',
      path: TAILNET_WS_TICKET_PATH,
      token: input.token,
      body: {},
    })
  } catch (error) {
    return { ok: false, code: 'unreachable', message: describeUnreachable(input.endpoint, error) }
  }
  if (ticketAnswer.status === 401) return { ok: false, code: 'unauthorized', message: UNAUTHORIZED_MESSAGE }
  const ticket = asRecord(ticketAnswer.body)?.ticket
  if (ticketAnswer.status !== 200 || typeof ticket !== 'string') {
    return {
      ok: false,
      code: `http_${ticketAnswer.status}`,
      message: `That machine would not open a stream (HTTP ${ticketAnswer.status}).`,
    }
  }

  const query: Record<string, string> = { sessionId: input.sessionId }
  if (input.resume) {
    query.stream = input.resume.stream
    query.after = String(input.resume.position)
  }
  const upgraded = await upgradeSocket(input.endpoint, ticket, TAILNET_TERMINAL_PATH, query)
  if (!upgraded.ok) return upgraded

  return { ok: true, value: driveTerminalSocket(upgraded.value.socket, upgraded.value.leftover, input.handlers) }
}

/**
 * Watch one machine's change feed (2026-09-05): a `changed` frame says its
 * terminal list or workspace list moved, and the caller re-reads. The same
 * ticket-then-upgrade the terminal attach uses, on the events route; frames
 * arrive on `onFrame` as plain objects, exactly as terminal frames do.
 */
export async function openRemoteEventsSocket(input: {
  endpoint: TailnetEndpoint
  token: string
  handlers: RemoteTerminalSocketHandlers
}): Promise<RemoteCallOutcome<RemoteTerminalSocket>> {
  let ticketAnswer: JsonAnswer
  try {
    ticketAnswer = await requestTailnetJson({
      endpoint: input.endpoint,
      method: 'POST',
      path: TAILNET_WS_TICKET_PATH,
      token: input.token,
      body: {},
    })
  } catch (error) {
    return { ok: false, code: 'unreachable', message: describeUnreachable(input.endpoint, error) }
  }
  if (ticketAnswer.status === 401) return { ok: false, code: 'unauthorized', message: UNAUTHORIZED_MESSAGE }
  const ticket = asRecord(ticketAnswer.body)?.ticket
  if (ticketAnswer.status !== 200 || typeof ticket !== 'string') {
    return {
      ok: false,
      code: `http_${ticketAnswer.status}`,
      message: `That machine would not open a change feed (HTTP ${ticketAnswer.status}).`,
    }
  }
  const upgraded = await upgradeSocket(input.endpoint, ticket, TAILNET_EVENTS_PATH, {})
  if (!upgraded.ok) return upgraded
  return { ok: true, value: driveTerminalSocket(upgraded.value.socket, upgraded.value.leftover, input.handlers) }
}

/** Open the TCP socket and complete the RFC 6455 handshake against one of the listener's WebSocket routes. */
function upgradeSocket(
  endpoint: TailnetEndpoint,
  ticket: string,
  path: string,
  query: Record<string, string>,
): Promise<RemoteCallOutcome<{ socket: Socket; leftover: Buffer }>> {
  return new Promise((resolve) => {
    const key = randomBytes(16).toString('base64')
    const expectedAccept = computeWebSocketAcceptKey(key)
    const socket = connect({ host: endpoint.host, port: endpoint.port })
    let head = Buffer.alloc(0)
    let settled = false

    const settle = (outcome: RemoteCallOutcome<{ socket: Socket; leftover: Buffer }>): void => {
      if (settled) return
      settled = true
      // Hand the socket over with no handshake listeners left on it, and with
      // the connect timeout cleared: an attached terminal is idle most of its
      // life and must never be timed out for it.
      socket.setTimeout(0)
      socket.removeListener('timeout', onTimeout)
      socket.removeListener('data', onData)
      socket.removeListener('error', onError)
      socket.removeListener('close', onClose)
      if (!outcome.ok) socket.destroy()
      resolve(outcome)
    }
    const refuse = (code: string, text: string): void => settle({ ok: false, code, message: text })
    const onError = (error: Error): void => refuse('unreachable', describeUnreachable(endpoint, error))
    const onClose = (): void => refuse('unreachable', 'That machine closed the connection during the handshake.')
    const onTimeout = (): void =>
      refuse('unreachable', describeUnreachable(endpoint, new Error('the handshake got no answer')))
    const onData = (chunk: Buffer): void => {
      head = Buffer.concat([head, chunk])
      const boundary = head.indexOf('\r\n\r\n')
      if (boundary === -1) {
        if (head.length > 64 * 1024) refuse('protocol', 'That machine sent an oversized handshake response.')
        return
      }
      const header = head.subarray(0, boundary).toString('utf8')
      const leftover = head.subarray(boundary + 4)
      const [statusLine, ...headerLines] = header.split('\r\n')
      const status = Number(statusLine.split(' ')[1])
      const headers = new Map(
        headerLines.map((line): [string, string] => {
          const colon = line.indexOf(':')
          return colon === -1
            ? [line.toLowerCase(), '']
            : [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()]
        }),
      )
      if (status !== 101) {
        // The listener names its refusals in a header; carrying that code
        // through is what lets the pane say "watch-only" instead of "HTTP 403".
        const code = headers.get('x-tailnet-error') ?? `http_${status}`
        refuse(code, refusalMessage(code, status))
        return
      }
      if (headers.get('sec-websocket-accept') !== expectedAccept) {
        refuse('protocol', 'The handshake key did not verify; that endpoint is not a Studio tailnet listener.')
        return
      }
      settle({ ok: true, value: { socket, leftover } })
    }

    socket.setTimeout(HANDSHAKE_TIMEOUT_MS)
    socket.on('timeout', onTimeout)
    socket.on('error', onError)
    socket.on('close', onClose)
    socket.on('data', onData)
    socket.on('connect', () => {
      const search = new URLSearchParams({ ticket, ...query })
      socket.write(
        [
          `GET ${path}?${search.toString()} HTTP/1.1`,
          `Host: ${formatTailnetEndpoint(endpoint)}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${key}`,
          'Sec-WebSocket-Version: 13',
          '',
          '',
        ].join('\r\n'),
      )
    })
  })
}

/** Frame loop for an upgraded terminal socket. */
function driveTerminalSocket(
  socket: Socket,
  leftover: Buffer,
  handlers: RemoteTerminalSocketHandlers,
): RemoteTerminalSocket {
  const decoder = createWebSocketFrameDecoder(MAX_WEBSOCKET_MESSAGE_BYTES, 'client')
  let closed = false
  let closeCode: number | null = null
  let closeReason = 'The connection to that machine ended.'

  const finish = (): void => {
    if (closed) return
    closed = true
    socket.destroy()
    handlers.onClosed({ code: closeCode, reason: closeReason })
  }

  const consume = (chunk: Buffer): void => {
    if (closed) return
    const decoded = decoder.push(chunk)
    if (decoded.kind === 'error') {
      closeReason = decoded.reason
      finish()
      return
    }
    for (const frame of decoded.frames) {
      if (frame.kind === 'close') {
        closeCode = frame.code
        closeReason = frame.reason || closeReasonFor(frame.code)
        finish()
        return
      }
      if (frame.kind === 'ping') {
        if (!socket.destroyed) socket.write(encodeMaskedPongFrame(frame.payload))
        continue
      }
      if (frame.kind !== 'text') continue
      let parsed: unknown
      try {
        parsed = JSON.parse(frame.text)
      } catch {
        // A frame we cannot read is a protocol failure, not something to skip:
        // silently dropping it would leave a pane waiting for output forever.
        closeReason = 'That machine sent a terminal frame this build could not read.'
        finish()
        return
      }
      const record = asRecord(parsed)
      if (record) handlers.onFrame(record)
    }
  }

  socket.on('data', consume)
  // An upgraded socket is half-open: a peer that vanishes makes Node emit
  // `end`, not `close`. Handling only one leaves a dead attachment believed live.
  socket.on('end', () => {
    closeReason = 'That machine stopped answering.'
    finish()
  })
  socket.on('close', finish)
  socket.on('error', (error: Error) => {
    closeReason = `The connection to that machine failed: ${message(error)}.`
    finish()
  })
  if (leftover.length > 0) consume(leftover)

  return {
    send(frame): void {
      if (closed || socket.destroyed) return
      socket.write(encodeMaskedTextFrame(JSON.stringify(frame)))
    },
    close(reason): void {
      if (closed) return
      closeReason = reason
      if (!socket.destroyed) {
        try {
          socket.write(encodeMaskedCloseFrame(WEBSOCKET_CLOSE_NORMAL, ''))
        } catch {
          // The peer is already gone; destroying below is the whole cleanup.
        }
      }
      finish()
    },
    isOpen: () => !closed && !socket.destroyed,
  }
}

const UNAUTHORIZED_MESSAGE =
  'That machine no longer accepts this pairing. It was revoked there, or its app data was reset. Pair again to reconnect.'

function refusalMessage(code: string, status: number): string {
  if (code === 'terminal_scope_required') {
    return 'This pairing may not open terminals on that machine. Pair again with the terminal scope.'
  }
  if (code === 'terminal_streaming_unavailable') return 'That machine is not serving terminals right now.'
  if (code === 'unauthorized') return UNAUTHORIZED_MESSAGE
  return `That machine refused the terminal stream (HTTP ${status}, ${code}).`
}

function closeReasonFor(code: number): string {
  if (code === 4401) return 'That machine revoked this pairing, so the terminal was disconnected.'
  if (code === 1000 || code === 1001) return 'That machine closed the terminal stream.'
  return `The terminal stream closed (code ${code}).`
}

function describeUnreachable(endpoint: TailnetEndpoint, error: unknown): string {
  return `${formatTailnetEndpoint(endpoint)} did not answer: ${message(error)}.`
}

function readScopes(value: unknown): TailnetScope[] {
  return Array.isArray(value) ? value.filter(isTailnetScope) : []
}

function isPort(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= 65535
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
