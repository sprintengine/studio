import { randomBytes } from 'crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import type { Duplex } from 'stream'

import { SUPPORTED_MCP_PROTOCOL_VERSIONS } from '../../../shared/mcp/protocol'
import { STUDIO_MCP_SERVER_NAME } from '../../../shared/product-identity'
import { toolError, type McpConnectionContext, type McpToolRegistration, type McpToolResult } from '../../../shared/modules/mcp-tools'
import {
  createMcpDispatcher,
  declaredProtocolVersion,
  isRecord,
  jsonRpcErrorResponse,
  jsonRpcIdOf,
  unsupportedProtocolVersionMessage,
  JSONRPC_INTERNAL_ERROR,
  JSONRPC_INVALID_PARAMS,
  JSONRPC_INVALID_REQUEST,
  JSONRPC_PARSE_ERROR,
  type McpDispatchGate,
} from '../mcp-dispatch'
import { isAllowedTailnetBindAddress } from './tailnet-interface'
import {
  TAILNET_HEALTH_PATH,
  TAILNET_IDENTITY_PATH,
  TAILNET_MCP_PATH,
  TAILNET_PAIR_PATH,
  TAILNET_STREAM_PATH,
  TAILNET_TERMINAL_PATH,
  TAILNET_WS_TICKET_PATH,
} from './tailnet-routes'
import {
  createTailnetTerminalStream,
  terminalAttachScopeFor,
  type TailnetTerminalStream,
} from './tailnet-terminal-stream'
import type { TerminalRemoteHost } from '../../terminal-remote-attach'
import type { TailnetDeviceStore } from './tailnet-devices'
import type { TailnetPeerResolver } from './tailnet-peer-identity'
import { normalizeAddress } from './tailnet-peer-identity'
import { tailnetScopeGrantsAccess, type TailnetDevice, type TailnetScope } from '../../../shared/tailnet'
import { requiredScopeForTool } from './tailnet-scopes'
import {
  computeWebSocketAcceptKey,
  createWebSocketFrameDecoder,
  encodeCloseFrame,
  encodePongFrame,
  encodeTextFrame,
  MAX_WEBSOCKET_MESSAGE_BYTES,
  WEBSOCKET_CLOSE_GOING_AWAY,
  WEBSOCKET_CLOSE_REVOKED,
} from './websocket-frames'

// The opt-in tailnet listener: the same ~60-tool gateway surface the local
// socket serves, reachable from another machine on the tailnet.
//
// This reverses MC-1650's Decision 1 for the remote case only, and does so
// under the epic's constraints: bound to the Tailscale interface address and
// nothing else, off unless a person enabled it, every request carrying a device
// token the desktop minted, every remote mutation audited with the device and
// the Tailscale peer it came from. The Unix socket is untouched — local clients
// keep using it, with filesystem permissions still their whole auth model.
//
// The transport is deliberately NOT spec Streamable HTTP. It is a small,
// explicit surface: one JSON-in/JSON-out MCP endpoint, plus WebSockets for
// clients that need a persistent channel — the RPC stream (tool-list
// notifications, connection-scoped identity) and, per attached terminal, a
// stream of its own (MC-2165). No SSE, no session resumption — those are
// advertised nowhere, so nothing can quietly depend on a half version.

export {
  TAILNET_ROUTE_PREFIX,
  TAILNET_HEALTH_PATH,
  TAILNET_PAIR_PATH,
  TAILNET_IDENTITY_PATH,
  TAILNET_MCP_PATH,
  TAILNET_WS_TICKET_PATH,
  TAILNET_STREAM_PATH,
  TAILNET_TERMINAL_PATH,
} from './tailnet-routes'

/** Version of THIS transport's envelope, separate from the MCP protocol version. */
export const TAILNET_TRANSPORT_VERSION = 1

/** The advisory connection-metadata declaration; only the stateful WebSocket can hold it. */
const CONNECT_METHOD = 'sprintengine.studio/connect'

const MAX_MCP_BODY_BYTES = 1024 * 1024
const MAX_CONTROL_BODY_BYTES = 64 * 1024
/** Long enough to open a socket, short enough that a leaked URL is worthless. */
const WS_TICKET_TTL_MS = 30_000

export type TailnetGatewayServerOptions = {
  bindAddress: string
  /** 0 binds an ephemeral port; only tests use it, since a discoverable listener needs a fixed one. */
  port: number
  serverName: string
  serverVersion: string
  resolveTools: () => McpToolRegistration[]
  /** The gateway's own mutation classification, so scopes cannot drift from the audit's. */
  isMutation: (toolName: string) => boolean
  devices: TailnetDeviceStore
  peers: TailnetPeerResolver
  /**
   * Watch-and-type access to this machine's terminals (MC-2165). Absent leaves
   * the terminal WebSocket route answering `terminal_streaming_unavailable`
   * rather than pretending the transport is there — the structured tool surface
   * is unaffected either way.
   */
  terminals?: TerminalRemoteHost
  onToolCall?: (event: {
    context: McpConnectionContext
    tool: string
    args: Record<string, unknown>
    durationMs: number
    result?: McpToolResult
    error?: unknown
  }) => void
  now?: () => number
  log?: (message: string) => void
}

export type TailnetGatewayServer = {
  start(): Promise<void>
  stop(): Promise<void>
  isRunning(): boolean
  /** The address actually bound, or null while stopped. */
  address(): { address: string; port: number } | null
  notifyToolsListChanged(): void
  /** Live WebSocket streams, by device — diagnostics and tests. */
  streamCount(): number
  /** Live attached terminals — diagnostics and tests. */
  terminalStreamCount(): number
}

type StreamSession = {
  socket: Duplex
  deviceId: string
  context: McpConnectionContext
}

export function createTailnetGatewayServer(options: TailnetGatewayServerOptions): TailnetGatewayServer {
  const now = options.now ?? (() => Date.now())
  let server: Server | null = null
  let unsubscribeRevocations: (() => void) | null = null
  const streams = new Set<StreamSession>()
  const terminalStreams = new Set<TailnetTerminalStream>()
  const tickets = new Map<string, { deviceId: string; expiresAtMs: number }>()

  const dispatcher = createMcpDispatcher({
    serverName: options.serverName,
    serverVersion: options.serverVersion,
    resolveTools: options.resolveTools,
    onToolCall: options.onToolCall,
  })

  async function start(): Promise<void> {
    if (server) return
    // The bind guard is the epic's hard rule and it runs BEFORE listen(), so a
    // misconfigured address can never produce even a momentarily-open port.
    if (!isAllowedTailnetBindAddress(options.bindAddress)) {
      throw new Error(
        `Refusing to bind the tailnet gateway to ${options.bindAddress || '(empty)'}: only a Tailscale address (100.64.0.0/10 or fd7a:115c:a1e0::/48) or loopback is allowed.`
      )
    }
    const next = createServer((request, response) => {
      void handleRequest(request, response).catch((error) => {
        options.log?.(`tailnet gateway request failed: ${message(error)}`)
        writeJson(response, 500, { error: { code: 'internal_error', message: 'The request could not be completed.' } })
      })
    })
    next.on('upgrade', (request, socket, head) => {
      void handleUpgrade(request, socket, head).catch((error) => {
        options.log?.(`tailnet gateway upgrade failed: ${message(error)}`)
        rejectUpgrade(socket, 500, 'internal_error')
      })
    })
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        next.removeListener('listening', onListening)
        reject(error)
      }
      const onListening = () => {
        next.removeListener('error', onError)
        resolve()
      }
      next.once('error', onError)
      next.once('listening', onListening)
      next.listen(options.port, options.bindAddress)
    })
    next.on('error', (error) => options.log?.(`tailnet gateway server error: ${error.message}`))
    // Revocation must reach a device that is already mid-stream, not just its
    // next request: a live WebSocket would otherwise keep serving a device the
    // user just removed.
    unsubscribeRevocations = options.devices.onDeviceRevoked((deviceId) => closeStreamsFor(deviceId))
    server = next
  }

  async function stop(): Promise<void> {
    const current = server
    if (!current) return
    server = null
    unsubscribeRevocations?.()
    unsubscribeRevocations = null
    tickets.clear()
    for (const stream of [...streams]) {
      // Send the close frame, then destroy rather than waiting for the peer's
      // reply: a client that never answers must not be able to hang shutdown.
      closeStream(stream, WEBSOCKET_CLOSE_GOING_AWAY, 'Server stopping.')
      stream.socket.destroy()
    }
    streams.clear()
    for (const terminal of [...terminalStreams]) terminal.close(WEBSOCKET_CLOSE_GOING_AWAY, 'Server stopping.')
    terminalStreams.clear()
    await new Promise<void>((resolve) => current.close(() => resolve()))
  }

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // Any `Origin` means a browser made this request. No client of this
    // transport is a browser, and a page on a tailnet machine must not be able
    // to drive the gateway through a user's browser (DNS-rebinding class).
    // Refusing outright is the honest rule; there is no origin to allow.
    if (request.headers.origin) {
      writeJson(response, 403, {
        error: { code: 'origin_not_allowed', message: 'Browser-originated requests are not accepted on this transport.' },
      })
      return
    }
    const path = pathOf(request.url)
    const method = request.method ?? 'GET'

    if (method === 'GET' && path === TAILNET_HEALTH_PATH) {
      // Unauthenticated on purpose: peer discovery (MC-2163) probes it to learn
      // that a machine speaks this transport. It therefore says only what a
      // prospective client must know to talk, and nothing about this machine,
      // its user, its workspaces, or whether any device is paired.
      writeJson(response, 200, {
        product: STUDIO_MCP_SERVER_NAME,
        transportVersion: TAILNET_TRANSPORT_VERSION,
        protocolVersions: SUPPORTED_MCP_PROTOCOL_VERSIONS,
      })
      return
    }

    if (method === 'POST' && path === TAILNET_PAIR_PATH) {
      const body = await readJsonBody(request, response, MAX_CONTROL_BODY_BYTES)
      if (body === undefined) return
      const outcome = options.devices.redeemPairing({
        token: isRecord(body) ? body.pairingToken : undefined,
        deviceName: isRecord(body) ? body.deviceName : undefined,
      })
      if (!outcome.ok) {
        // 401 for a bad or missing credential, 400 for a malformed request:
        // a client must be able to tell "wrong code" from "you forgot a field".
        const status = outcome.code === 'invalid_device_name' ? 400 : 401
        writeJson(response, status, { error: { code: outcome.code, message: outcome.message } })
        return
      }
      writeJson(response, 200, {
        deviceId: outcome.device.id,
        deviceName: outcome.device.name,
        deviceToken: outcome.deviceToken,
        scopes: outcome.device.scopes,
      })
      return
    }

    const device = authenticate(request)
    if (!device) {
      writeUnauthorized(response)
      return
    }
    const peerNode = await options.peers.resolve(normalizeAddress(request.socket.remoteAddress))
    options.devices.recordSeen(device.id, peerNode)

    if (method === 'GET' && path === TAILNET_IDENTITY_PATH) {
      writeJson(response, 200, {
        deviceId: device.id,
        deviceName: device.name,
        scopes: device.scopes,
        serverInfo: { name: options.serverName, version: options.serverVersion },
        transportVersion: TAILNET_TRANSPORT_VERSION,
        protocolVersions: SUPPORTED_MCP_PROTOCOL_VERSIONS,
      })
      return
    }

    if (method === 'POST' && path === TAILNET_WS_TICKET_PATH) {
      // The upgrade carries its credential in the query string, where it lands
      // in proxy logs and browser history — so what it carries is a 30-second
      // single-use ticket, never the long-lived device token.
      const ticket = `mctk_${randomBytes(24).toString('base64url')}`
      const expiresAtMs = now() + WS_TICKET_TTL_MS
      pruneTickets()
      tickets.set(ticket, { deviceId: device.id, expiresAtMs })
      writeJson(response, 200, { ticket, expiresAt: new Date(expiresAtMs).toISOString(), path: TAILNET_STREAM_PATH })
      return
    }

    if (method === 'POST' && path === TAILNET_MCP_PATH) {
      const body = await readJsonBody(request, response, MAX_MCP_BODY_BYTES)
      if (body === undefined) return
      // This endpoint is stateless: every POST builds a fresh context, so a
      // connection-scoped declaration has nothing to attach to. Accepting it
      // and discarding it would be the silent fallback the norms forbid — the
      // caller would believe it had declared a sprint run and then get
      // `no_active_sprint` from every run tool with no way to know why. Say so
      // instead, and name the channel that does hold state. Answered here
      // rather than in dispatch because the declaration is a NOTIFICATION: over
      // HTTP there is always a response to put the refusal in, over JSON-RPC
      // alone there would not be.
      if (isRecord(body) && body.method === CONNECT_METHOD) {
        writeJson(response, 400, {
          error: {
            code: 'stateless_transport',
            message: `${CONNECT_METHOD} needs a connection to attach to. Open a WebSocket at ${TAILNET_STREAM_PATH} with a ticket from ${TAILNET_WS_TICKET_PATH} and declare it there.`,
          },
        })
        return
      }
      const answer = await handleMessage(body, contextFor(device, peerNode), device, headerOf(request, 'mcp-protocol-version'))
      // A notification has no answer; 202 says "accepted, nothing to return".
      if (!answer) writeJson(response, 202, {})
      else writeJson(response, 200, answer)
      return
    }

    writeJson(response, 404, { error: { code: 'not_found', message: `No tailnet gateway route for ${method} ${path}.` } })
  }

  /** Run one JSON-RPC message; returns the response object, or null for a notification. */
  async function handleMessage(
    parsed: unknown,
    context: McpConnectionContext,
    device: TailnetDevice,
    protocolHeader: string | null
  ): Promise<Record<string, unknown> | null> {
    if (!isRecord(parsed) || parsed.jsonrpc !== '2.0' || typeof parsed.method !== 'string') {
      return jsonRpcErrorResponse(jsonRpcIdOf(parsed), JSONRPC_INVALID_REQUEST, 'Request is not a JSON-RPC 2.0 message.')
    }
    const id = jsonRpcIdOf(parsed)
    const isNotification = id === null && !('id' in parsed)
    const params = isRecord(parsed.params) ? parsed.params : {}
    const declared = declaredProtocolVersion(params, protocolHeader)
    if (declared.kind === 'unsupported') {
      const detail = unsupportedProtocolVersionMessage(declared.value)
      if (isNotification) {
        options.log?.(`tailnet gateway refused ${parsed.method}: ${detail}`)
        return null
      }
      return jsonRpcErrorResponse(id, JSONRPC_INVALID_PARAMS, detail)
    }
    try {
      const outcome = await dispatcher.dispatch(parsed.method, params, context, gateFor(device))
      if (isNotification) return null
      if (outcome.kind === 'no_response') return { jsonrpc: '2.0', id, result: {} }
      if (outcome.kind === 'error') return jsonRpcErrorResponse(id, outcome.code, outcome.errorMessage)
      return { jsonrpc: '2.0', id, result: outcome.value }
    } catch (error) {
      options.log?.(`tailnet tool dispatch threw: ${message(error)}`)
      if (isNotification) return null
      return jsonRpcErrorResponse(id, JSONRPC_INTERNAL_ERROR, `Internal error: ${message(error)}`)
    }
  }

  /** The device's scopes, applied to what it may see and what it may run. */
  function gateFor(device: TailnetDevice): McpDispatchGate {
    const granted = new Set<TailnetScope>(device.scopes)
    const allows = (toolName: string): boolean =>
      tailnetScopeGrantsAccess(granted, requiredScopeForTool(toolName, options.isMutation(toolName)))
    return {
      filterTools: (tools) => tools.filter((tool) => allows(tool.name)),
      authorizeToolCall: (toolName) =>
        allows(toolName)
          ? null
          : toolError(
              'tailnet_scope_required',
              `This device is not granted "${requiredScopeForTool(toolName, options.isMutation(toolName))}", which "${toolName}" requires. Re-pair the device with that scope in Settings.`
            ),
    }
  }

  function contextFor(device: TailnetDevice, peerNode: string | null): McpConnectionContext {
    return {
      metadata: {
        kind: 'remote-tailnet',
        deviceId: device.id,
        deviceName: device.name,
        ...(peerNode ? { peerNode } : {}),
      },
    }
  }

  function authenticate(request: IncomingMessage): TailnetDevice | null {
    const header = headerOf(request, 'authorization') ?? ''
    const prefix = 'Bearer '
    return header.startsWith(prefix) ? options.devices.authenticate(header.slice(prefix.length).trim()) : null
  }

  async function handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    if (request.headers.origin) return rejectUpgrade(socket, 403, 'origin_not_allowed')
    const path = pathOf(request.url)
    if (path !== TAILNET_STREAM_PATH && path !== TAILNET_TERMINAL_PATH) return rejectUpgrade(socket, 404, 'not_found')
    if ((headerOf(request, 'upgrade') ?? '').toLowerCase() !== 'websocket') return rejectUpgrade(socket, 400, 'not_a_websocket_upgrade')
    if ((headerOf(request, 'sec-websocket-version') ?? '') !== '13') return rejectUpgrade(socket, 400, 'unsupported_websocket_version')
    const key = headerOf(request, 'sec-websocket-key')
    if (!key) return rejectUpgrade(socket, 400, 'missing_websocket_key')

    const query = queryOf(request.url)
    const device = redeemTicket(query.get('ticket'))
    if (!device) return rejectUpgrade(socket, 401, 'unauthorized')

    if (path === TAILNET_TERMINAL_PATH) {
      // Refused BEFORE the 101, so a device without the grant never gets a
      // socket it could send an input frame on.
      if (!options.terminals) return rejectUpgrade(socket, 503, 'terminal_streaming_unavailable')
      if (!terminalAttachScopeFor(device.scopes)) return rejectUpgrade(socket, 403, 'terminal_scope_required')
      const sessionId = query.get('sessionId')?.trim()
      if (!sessionId) return rejectUpgrade(socket, 400, 'session_id_required')

      const terminalPeer = await options.peers.resolve(normalizeAddress(remoteAddressOf(socket)))
      options.devices.recordSeen(device.id, terminalPeer)
      acceptUpgrade(socket, key)
      // The stream can refuse itself (unknown session, missing grant) and run
      // `onClosed` before the constructor returns, so the callback reads the
      // reference through a box rather than closing over a `const` that is
      // still in its temporal dead zone.
      const registration: { stream: TailnetTerminalStream | null } = { stream: null }
      const stream = createTailnetTerminalStream({
        socket,
        sessionId,
        deviceId: device.id,
        deviceName: device.name,
        scopes: device.scopes,
        terminals: options.terminals,
        onClosed: () => {
          if (registration.stream) terminalStreams.delete(registration.stream)
        },
        log: options.log,
      })
      registration.stream = stream
      // A stream that refused its own attach has already closed and run
      // `onClosed` before this line, so only a live one is tracked.
      if (stream.isClosed()) return
      terminalStreams.add(stream)
      if (head?.length) socket.emit('data', head)
      return
    }

    const peerNode = await options.peers.resolve(normalizeAddress(remoteAddressOf(socket)))
    options.devices.recordSeen(device.id, peerNode)
    acceptUpgrade(socket, key)

    const session: StreamSession = { socket, deviceId: device.id, context: contextFor(device, peerNode) }
    streams.add(session)
    const decoder = createWebSocketFrameDecoder(MAX_WEBSOCKET_MESSAGE_BYTES)
    // Serialize per connection so a client's messages are answered in order.
    let pending = Promise.resolve()

    const consume = (chunk: Buffer): void => {
      const decoded = decoder.push(chunk)
      if (decoded.kind === 'error') {
        closeStream(session, decoded.code, decoded.reason)
        return
      }
      for (const frame of decoded.frames) {
        if (frame.kind === 'close') {
          closeStream(session, WEBSOCKET_CLOSE_GOING_AWAY, '')
          return
        }
        if (frame.kind === 'ping') {
          socket.write(encodePongFrame(frame.payload))
          continue
        }
        if (frame.kind !== 'text') continue
        const text = frame.text
        pending = pending.then(() => handleStreamMessage(session, text))
      }
    }

    if (head?.length) consume(head)
    socket.on('data', (chunk: Buffer) => consume(chunk))
    // An upgraded socket is half-open: a peer that disconnects makes Node emit
    // `end`, not `close` (the write side is still ours). Both are handled, or a
    // dropped client stays in `streams` for the life of the process and every
    // tool-list notification writes into a socket nobody is reading.
    socket.on('end', () => {
      streams.delete(session)
      socket.destroy()
    })
    socket.on('close', () => streams.delete(session))
    socket.on('error', () => {
      streams.delete(session)
      socket.destroy()
    })
  }

  async function handleStreamMessage(session: StreamSession, text: string): Promise<void> {
    // Re-check the device on every message, not only at upgrade: authorization
    // on a long-lived socket must follow the store, and the revocation listener
    // is a fast path, not the guarantee.
    const device = options.devices.listDevices().find((candidate) => candidate.id === session.deviceId)
    if (!device) {
      closeStream(session, WEBSOCKET_CLOSE_REVOKED, 'This device has been revoked.')
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      sendStream(session, jsonRpcErrorResponse(null, JSONRPC_PARSE_ERROR, 'Request is not valid JSON.'))
      return
    }
    const answer = await handleMessage(parsed, session.context, device, null)
    if (answer) sendStream(session, answer)
  }

  function redeemTicket(ticket: string | null): TailnetDevice | null {
    pruneTickets()
    if (!ticket) return null
    const entry = tickets.get(ticket)
    if (!entry) return null
    // Single use: consumed whether or not the device still exists.
    tickets.delete(ticket)
    if (entry.expiresAtMs <= now()) return null
    return options.devices.listDevices().find((device) => device.id === entry.deviceId) ?? null
  }

  function pruneTickets(): void {
    const current = now()
    for (const [ticket, entry] of tickets) if (entry.expiresAtMs <= current) tickets.delete(ticket)
  }

  function closeStreamsFor(deviceId: string): void {
    for (const stream of [...streams]) {
      if (stream.deviceId === deviceId) closeStream(stream, WEBSOCKET_CLOSE_REVOKED, 'This device has been revoked.')
    }
    // An attached terminal is the stream a revocation must reach fastest: it is
    // live output, and for a control-scoped device a live shell.
    for (const terminal of [...terminalStreams]) {
      if (terminal.deviceId === deviceId) terminal.close(WEBSOCKET_CLOSE_REVOKED, 'This device has been revoked.')
    }
    for (const [ticket, entry] of tickets) if (entry.deviceId === deviceId) tickets.delete(ticket)
  }

  /** Write the RFC 6455 handshake response for an accepted upgrade. */
  function acceptUpgrade(socket: Duplex, key: string): void {
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${computeWebSocketAcceptKey(key)}`,
        '',
        '',
      ].join('\r\n')
    )
  }

  function closeStream(session: StreamSession, code: number, reason: string): void {
    streams.delete(session)
    if (session.socket.destroyed) return
    try {
      session.socket.write(encodeCloseFrame(code, reason))
    } catch {
      // The peer is already gone; destroying below is the whole cleanup.
    }
    session.socket.end()
  }

  function sendStream(session: StreamSession, payload: Record<string, unknown>): void {
    if (session.socket.destroyed) return
    session.socket.write(encodeTextFrame(JSON.stringify(payload)))
  }

  /**
   * Read and parse a JSON body, answering the client on failure.
   *
   * Returns `undefined` when it already wrote the response — callers must
   * return immediately on that, and must not treat it as a valid body.
   */
  async function readJsonBody(
    request: IncomingMessage,
    response: ServerResponse,
    maxBytes: number
  ): Promise<unknown | undefined> {
    const chunks: Buffer[] = []
    let size = 0
    try {
      for await (const chunk of request) {
        const buffer = chunk as Buffer
        size += buffer.length
        if (size > maxBytes) {
          // Answer first, then stop reading. Breaking out of `for await`
          // destroys the request stream, so the response has to be on the wire
          // before that happens or the client sees a reset with no reason.
          writeJson(response, 413, {
            error: { code: 'body_too_large', message: `Request body exceeds the ${maxBytes}-byte limit.` },
          })
          await new Promise<void>((resolve) => response.once('finish', resolve))
          break
        }
        chunks.push(buffer)
      }
    } catch (error) {
      writeJson(response, 400, { error: { code: 'body_read_failed', message: message(error) } })
      return undefined
    }
    if (response.headersSent) return undefined
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      writeJson(response, 400, { error: { code: 'invalid_json', message: 'Request body is not valid JSON.' } })
      return undefined
    }
  }

  return {
    start,
    stop,
    isRunning: () => server !== null,
    address: () => {
      const bound = server?.address()
      return bound && typeof bound === 'object' ? { address: bound.address, port: bound.port } : null
    },
    notifyToolsListChanged: () => {
      for (const stream of streams) sendStream(stream, { jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
    },
    streamCount: () => streams.size,
    terminalStreamCount: () => terminalStreams.size,
  }
}

function writeUnauthorized(response: ServerResponse): void {
  response.setHeader('WWW-Authenticate', 'Bearer realm="sprintengine-studio-tailnet"')
  writeJson(response, 401, {
    error: { code: 'unauthorized', message: 'A paired device token is required. Pair this machine in Settings → Remote.' },
  })
}

function writeJson(response: ServerResponse, status: number, payload: Record<string, unknown>): void {
  // The catch-all 500 in the request handler can fire after a route already
  // answered; writing a second status line would throw over the first one.
  if (response.headersSent || response.writableEnded) return
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    // Nothing here is cacheable, and a proxy holding a tool result would be a
    // correctness bug before it was a privacy one.
    'Cache-Control': 'no-store',
  })
  response.end(body)
}

function rejectUpgrade(socket: Duplex, status: number, code: string): void {
  const reason =
    status === 401
      ? 'Unauthorized'
      : status === 403
        ? 'Forbidden'
        : status === 404
          ? 'Not Found'
          : status === 503
            ? 'Service Unavailable'
            : 'Bad Request'
  if (!socket.destroyed) {
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nX-Tailnet-Error: ${code}\r\n\r\n`)
  }
  socket.destroy()
}

/**
 * The peer address of an upgraded connection.
 *
 * Node types the `upgrade` socket as `Duplex` because the server may be TLS,
 * but every socket this plain-HTTP server upgrades is a `net.Socket` and
 * carries `remoteAddress`. Read defensively rather than casting the whole
 * socket: an address we cannot read means an unresolved peer, not a crash.
 */
function remoteAddressOf(socket: Duplex): string {
  const value = (socket as { remoteAddress?: unknown }).remoteAddress
  return typeof value === 'string' ? value : ''
}

function headerOf(request: IncomingMessage, name: string): string | null {
  const value = request.headers[name]
  if (typeof value === 'string') return value
  return Array.isArray(value) ? (value[0] ?? null) : null
}

function pathOf(url: string | undefined): string {
  return parseUrl(url).pathname
}

function queryOf(url: string | undefined): URLSearchParams {
  return parseUrl(url).searchParams
}

// The base is a placeholder: only the path and query are ever read from it, and
// a request line is always origin-form on this server.
function parseUrl(url: string | undefined): URL {
  try {
    return new URL(url ?? '/', 'http://tailnet.invalid')
  } catch {
    return new URL('/', 'http://tailnet.invalid')
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
