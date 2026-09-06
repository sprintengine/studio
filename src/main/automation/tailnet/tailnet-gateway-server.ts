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
  TAILNET_PAIR_COLLECT_PATH,
  TAILNET_PAIR_REQUEST_PATH,
  TAILNET_EVENTS_PATH,
  TAILNET_STREAM_PATH,
  TAILNET_TERMINAL_PATH,
  TAILNET_UPLOAD_PATH,
  TAILNET_WS_TICKET_PATH,
} from './tailnet-routes'
import { resolveUploadDestination, UPLOAD_MAX_BYTES } from './tailnet-uploads'
import {
  createTailnetTerminalStream,
  terminalAttachScopeFor,
  type TailnetTerminalStream,
} from './tailnet-terminal-stream'
import type { TerminalRemoteHost } from '../../terminal-remote-attach'
import type { TailnetCollectOutcome, TailnetDeviceStore } from './tailnet-devices'
import type { TailnetPeerResolver } from './tailnet-peer-identity'
import { normalizeAddress } from './tailnet-peer-identity'
import { parseTailnetEndpoint } from './tailnet-remote-client'
import { normalizeTailnetScopes, type TailnetReverseGrant } from '../../../shared/tailnet'
import { tailnetScopeGrantsAccess, type TailnetDevice, type TailnetScope } from '../../../shared/tailnet'
import { isLocalOnlyGatewayTool, requiredScopeForTool } from './tailnet-scopes'
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
  TAILNET_PAIR_REQUEST_PATH,
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
  /**
   * Fired when a peer asks to pair (MC-2233), so the surfaces that answer these
   * can refresh without polling. It carries no detail: a listener's job is to
   * go and read the requests, not to be told about one it has not authorised.
   */
  onPairRequested?: () => void
  /**
   * An approved asker's collect carried the reverse half of a both-ways
   * pairing (phase 6): a device the asker minted for THIS machine on its own
   * listener. Only fired for a grant whose endpoint is the asker's own
   * transport-proven address — a body cannot point this machine's credential
   * store at a third party — and only on the collect that took our token,
   * so it rides on an approval a person here already gave.
   */
  onReverseGrant?: (input: { grant: TailnetReverseGrant; askerName: string; peerNode: string | null }) => void
  /**
   * Device activity, for the live-state push (remote-sessions-ux): a device's
   * RPC stream or terminal attachment opening or closing — fired exactly once
   * per transition, so the service above derives "connected" and "driving
   * terminal X" without holding a socket reference of its own — and every
   * authenticated HTTP call (`request`), which is activity on a device that
   * may hold no socket at all. Opens and requests carry the peer as the
   * transport saw it, resolved at the same point `recordSeen` is.
   */
  onActivity?: (event: TailnetGatewayActivity) => void
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
  /** The change feed's per-kind push floor; tests shorten it. */
  changePushIntervalMs?: number
}

export type TailnetGatewayPeer = { peerNode: string | null; peerAddress: string }

export type TailnetGatewayActivity =
  | ({ kind: 'stream'; device: TailnetDevice; open: true } & TailnetGatewayPeer)
  | { kind: 'stream'; device: TailnetDevice; open: false }
  | ({ kind: 'terminal'; device: TailnetDevice; sessionId: string; open: true } & TailnetGatewayPeer)
  | { kind: 'terminal'; device: TailnetDevice; sessionId: string; open: false }
  | ({ kind: 'request'; device: TailnetDevice } & TailnetGatewayPeer)

export type TailnetGatewayServer = {
  start(): Promise<void>
  stop(): Promise<void>
  isRunning(): boolean
  /** The address actually bound, or null while stopped. */
  address(): { address: string; port: number } | null
  notifyToolsListChanged(): void
  /**
   * Tell every device on the change feed that this machine's terminal list
   * changed, or its workspace list. Throttled here, so a burst of hook frames
   * is one push; the device re-reads through terminal.list / workspace.list.
   */
  notifyTerminalsChanged(): void
  notifyWorkspacesChanged(): void
  /** Live WebSocket streams, by device — diagnostics and tests. */
  streamCount(): number
  /** Live attached terminals — diagnostics and tests. */
  terminalStreamCount(): number
  /** Live change-feed sockets — diagnostics and tests. */
  eventStreamCount(): number
}

type StreamSession = {
  socket: Duplex
  deviceId: string
  /** The device as authenticated at upgrade, for the close announcement. */
  device: TailnetDevice
  context: McpConnectionContext
}

type EventStream = { socket: Duplex; deviceId: string }

type ChangeKind = 'terminals' | 'workspaces'

/**
 * The floor between two pushes of one kind. A session broadcast already
 * coalesces to a frame; a second is what stops a busy hook stream turning
 * into a re-read per frame on every paired machine.
 */
export const TAILNET_CHANGE_PUSH_INTERVAL_MS = 1_000

export function createTailnetGatewayServer(options: TailnetGatewayServerOptions): TailnetGatewayServer {
  const now = options.now ?? (() => Date.now())
  let server: Server | null = null
  let unsubscribeRevocations: (() => void) | null = null
  const streams = new Set<StreamSession>()
  const terminalStreams = new Set<TailnetTerminalStream>()
  const eventStreams = new Set<EventStream>()
  const tickets = new Map<string, { deviceId: string; expiresAtMs: number }>()

  // ── The change feed ───────────────────────────────────────────────────────
  // A revision per kind, so a watcher that reconnects can see it missed
  // something and re-read; a throttle per kind, so a burst is one push.
  const changePushIntervalMs = Math.max(0, options.changePushIntervalMs ?? TAILNET_CHANGE_PUSH_INTERVAL_MS)
  const changeRevisions: Record<ChangeKind, number> = { terminals: 0, workspaces: 0 }
  const changePush: Record<ChangeKind, { lastSentAt: number; timer: ReturnType<typeof setTimeout> | null }> = {
    terminals: { lastSentAt: Number.NEGATIVE_INFINITY, timer: null },
    workspaces: { lastSentAt: Number.NEGATIVE_INFINITY, timer: null },
  }

  function notifyChanged(what: ChangeKind): void {
    changeRevisions[what] += 1
    const state = changePush[what]
    // A push already queued carries this revision too.
    if (state.timer) return
    const elapsed = now() - state.lastSentAt
    if (elapsed >= changePushIntervalMs) {
      pushChanged(what)
      return
    }
    state.timer = setTimeout(() => {
      state.timer = null
      pushChanged(what)
    }, changePushIntervalMs - elapsed)
    state.timer.unref?.()
  }

  function pushChanged(what: ChangeKind): void {
    changePush[what].lastSentAt = now()
    if (eventStreams.size === 0) return
    const payload = encodeTextFrame(JSON.stringify({ type: 'changed', what, revision: changeRevisions[what] }))
    for (const stream of eventStreams) {
      if (!stream.socket.destroyed) stream.socket.write(payload)
    }
  }

  function openEventStream(socket: Duplex, device: TailnetDevice, head: Buffer): void {
    const stream: EventStream = { socket, deviceId: device.id }
    eventStreams.add(stream)
    const decoder = createWebSocketFrameDecoder(MAX_WEBSOCKET_MESSAGE_BYTES)
    const drop = (): void => {
      eventStreams.delete(stream)
    }
    const consume = (chunk: Buffer): void => {
      const decoded = decoder.push(chunk)
      if (decoded.kind === 'error') {
        closeEventStream(stream, decoded.code, decoded.reason)
        return
      }
      for (const frame of decoded.frames) {
        if (frame.kind === 'close') {
          closeEventStream(stream, WEBSOCKET_CLOSE_GOING_AWAY, '')
          return
        }
        if (frame.kind === 'ping' && !socket.destroyed) socket.write(encodePongFrame(frame.payload))
        // Text frames are ignored: this channel speaks server → client only.
      }
    }
    // Where things stand, at once: a watcher that reconnected after a change
    // it missed compares revisions and re-reads without waiting for the next.
    socket.write(
      encodeTextFrame(
        JSON.stringify({ type: 'hello', revisions: { terminals: changeRevisions.terminals, workspaces: changeRevisions.workspaces } })
      )
    )
    if (head?.length) consume(head)
    socket.on('data', consume)
    socket.on('end', () => {
      drop()
      socket.destroy()
    })
    socket.on('close', drop)
    socket.on('error', () => {
      drop()
      socket.destroy()
    })
  }

  function closeEventStream(stream: EventStream, code: number, reason: string): void {
    eventStreams.delete(stream)
    if (stream.socket.destroyed) return
    try {
      stream.socket.write(encodeCloseFrame(code, reason))
    } catch {
      // The peer is already gone; ending below is the whole cleanup.
    }
    stream.socket.end()
  }

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
    for (const kind of ['terminals', 'workspaces'] as const) {
      const state = changePush[kind]
      if (state.timer) clearTimeout(state.timer)
      state.timer = null
    }
    for (const stream of [...eventStreams]) {
      closeEventStream(stream, WEBSOCKET_CLOSE_GOING_AWAY, 'Server stopping.')
      stream.socket.destroy()
    }
    eventStreams.clear()
    await new Promise<void>((resolve) => current.close(() => resolve()))
  }

  /**
   * One file from a paired device into a thread's own folder (backlog id 88).
   *
   * The destination comes from the SESSION, never the request: the phone names
   * a file, and the working directory it lands under is whatever the terminal
   * host says that session is running in. `resolveUploadDestination` holds the
   * guard and its tests; this is the transport around it.
   *
   * Streamed to disk with the ceiling enforced as the bytes arrive, so an
   * oversized upload is cut off mid-flight rather than buffered to discover
   * its size — and the part-written file is removed, because a truncated
   * screenshot in a folder an agent reads is worse than no screenshot.
   */
  async function handleUpload(
    request: IncomingMessage,
    response: ServerResponse,
    device: TailnetDevice,
    url: URL
  ): Promise<void> {
    // Writing a file into someone's project is a mutation on the terminal
    // family, so it takes the tier that types rather than the one that watches.
    if (!tailnetScopeGrantsAccess(new Set(device.scopes), 'terminal:control')) {
      writeJson(response, 403, {
        error: {
          code: 'tailnet_scope_required',
          message: 'This device may watch terminals but not write files into them.',
        },
      })
      return
    }
    if (!options.terminals) {
      writeJson(response, 501, {
        error: { code: 'terminal_unavailable', message: 'This build serves no terminals.' },
      })
      return
    }
    const sessionId = url.searchParams.get('sessionId')?.trim() ?? ''
    const name = url.searchParams.get('name')?.trim() ?? ''
    if (!sessionId || !name) {
      writeJson(response, 400, {
        error: { code: 'invalid_arguments', message: 'An upload needs a sessionId and a name.' },
      })
      return
    }
    const session = options.terminals.listSessions().find((candidate) => candidate.sessionId === sessionId)
    if (!session) {
      writeJson(response, 404, {
        error: { code: 'unknown_terminal', message: 'No terminal on this machine has that session id.' },
      })
      return
    }
    const destination = resolveUploadDestination({ cwd: session.cwd, sessionId, name, taken: new Set() })
    if (!destination.ok) {
      writeJson(response, destination.code === 'path_escape' ? 400 : 409, {
        error: { code: destination.code, message: destination.message },
      })
      return
    }
    // A declared length over the cap is refused before a byte is read.
    const declared = Number(request.headers['content-length'] ?? '')
    if (Number.isFinite(declared) && declared > UPLOAD_MAX_BYTES) {
      writeJson(response, 413, {
        error: { code: 'too_large', message: `That file is over the ${Math.floor(UPLOAD_MAX_BYTES / (1024 * 1024))}MB limit.` },
      })
      return
    }
    try {
      const written = await streamUploadToDisk(request, destination)
      options.log?.(`tailnet upload: ${device.name} wrote ${written} bytes to ${destination.path}`)
      writeJson(response, 200, { path: destination.path, bytes: written })
    } catch (error) {
      if (error instanceof UploadTooLarge) {
        writeJson(response, 413, {
          error: { code: 'too_large', message: `That file is over the ${Math.floor(UPLOAD_MAX_BYTES / (1024 * 1024))}MB limit.` },
        })
        return
      }
      options.log?.(`tailnet upload failed: ${message(error)}`)
      writeJson(response, 500, { error: { code: 'internal_error', message: 'The file could not be written.' } })
    }
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

    if (path === TAILNET_PAIR_REQUEST_PATH && (method === 'POST' || method === 'GET')) {
      await handlePairRequest(request, response, method)
      return
    }
    if (path === TAILNET_PAIR_COLLECT_PATH && method === 'POST') {
      await handlePairCollect(request, response)
      return
    }

    const device = authenticate(request)
    if (!device) {
      writeUnauthorized(response)
      return
    }
    const peerAddress = normalizeAddress(request.socket.remoteAddress)
    const peerNode = await options.peers.resolve(peerAddress)
    options.devices.recordSeen(device.id, peerNode)
    options.onActivity?.({ kind: 'request', device, peerNode, peerAddress })

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

    if (method === 'POST' && path === TAILNET_UPLOAD_PATH) {
      await handleUpload(request, response, device, parseUrl(request.url))
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
  /**
   * Pairing by approval (MC-2233), both halves.
   *
   * Unauthenticated, and deliberately ahead of the auth gate: a peer asking to
   * be paired has no credential yet, which is the whole point. What stands in
   * for one is the person at this machine, and the peer identity the store
   * records is the one this transport established — `whois` on the socket's own
   * address — never anything the body claimed.
   */
  async function handlePairRequest(
    request: IncomingMessage,
    response: ServerResponse,
    method: string
  ): Promise<void> {
    if (method === 'GET') {
      const query = parseUrl(request.url ?? '').searchParams
      const outcome = options.devices.collectPairRequest(query.get('id') ?? '', query.get('secret') ?? '')
      // Every outcome is a 200: "your request was declined" and "it lapsed" are
      // answers to a well-formed question, not failures of it. The client
      // branches on `status`, which it must do anyway.
      writeJson(response, 200, wireCollectOutcome(outcome))
      return
    }

    const body = await readJsonBody(request, response, MAX_CONTROL_BODY_BYTES)
    if (body === undefined) return
    const peerAddress = normalizeAddress(request.socket.remoteAddress)
    const outcome = options.devices.requestPairing({
      deviceName: isRecord(body) ? body.deviceName : undefined,
      // Unresolvable stays null and the panel says so, rather than the request
      // being refused: whois is unavailable on any machine without the
      // Tailscale CLI, and that must not make the feature unusable.
      peerNode: await options.peers.resolve(peerAddress),
      peerAddress: peerAddress ?? '',
      collectHash: isRecord(body) ? body.collectHash : undefined,
    })
    if (!outcome.ok) {
      // 429 for the caps, 400 for a malformed request: a client must be able to
      // tell "ask again later" from "you sent the wrong thing".
      const status =
        outcome.code === 'invalid_device_name' || outcome.code === 'invalid_collect_hash' ? 400 : 429
      writeJson(response, status, { error: { code: outcome.code, message: outcome.message } })
      return
    }
    // Audited like any other classified mutation, and for the same reason: a
    // stranger asking for access to this machine is a security event whether or
    // not anyone approves it. There is no device yet, so the record carries the
    // name asked for and the peer the transport proved — never a deviceId.
    options.onToolCall?.({
      context: {
        metadata: {
          kind: 'remote-tailnet',
          deviceName: outcome.request.deviceName,
          ...(outcome.request.peerNode ? { peerNode: outcome.request.peerNode } : {}),
        },
      },
      tool: 'tailnet.pair_request',
      args: { deviceName: outcome.request.deviceName, peerAddress: outcome.request.peerAddress },
      durationMs: 0,
    })
    options.onPairRequested?.()
    writeJson(response, 200, {
      requestId: outcome.request.id,
      // Echoed so the asking machine can show the digits beside the ones now on
      // the other screen. It is not a credential; comparing is its whole job.
      comparisonCode: outcome.request.comparisonCode,
      expiresAt: outcome.request.expiresAt,
    })
  }

  /**
   * The collect as a POST (phase 6): the same answer the GET gives, plus the
   * one thing a GET cannot carry — the asker's reverse grant, adopted only
   * when this very collect hands the asker OUR token (the approval a person
   * here gave), and only when its endpoint is the address the asker is
   * calling from. Anything else about the grant is refused silently: the
   * pairing the person approved still completes; the extra half does not.
   */
  async function handlePairCollect(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readJsonBody(request, response, MAX_CONTROL_BODY_BYTES)
    if (body === undefined) return
    const record = isRecord(body) ? body : {}
    const outcome = options.devices.collectPairRequest(
      typeof record.id === 'string' ? record.id : '',
      typeof record.secret === 'string' ? record.secret : ''
    )
    if (outcome.status === 'approved' && outcome.asker && isRecord(record.reverse)) {
      const peerAddress = normalizeAddress(request.socket.remoteAddress)
      const grant = readReverseGrant(record.reverse, peerAddress)
      if (grant) {
        options.onReverseGrant?.({
          grant,
          askerName: outcome.asker.deviceName,
          peerNode: outcome.asker.peerNode,
        })
      } else {
        options.log?.(
          `tailnet gateway ignored a reverse grant from ${peerAddress || 'an unknown address'}: `
          + 'its endpoint was not the asker\'s own address or it was malformed.'
        )
      }
    }
    writeJson(response, 200, wireCollectOutcome(outcome))
  }

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
    const scopeAllows = (toolName: string): boolean =>
      tailnetScopeGrantsAccess(granted, requiredScopeForTool(toolName, options.isMutation(toolName)))
    return {
      // Local-only first, and independent of scopes: the `tailnet.*` family is
      // not something a wider grant unlocks, it is off this transport entirely.
      filterTools: (tools) => tools.filter((tool) => !isLocalOnlyGatewayTool(tool.name) && scopeAllows(tool.name)),
      authorizeToolCall: (toolName) => {
        if (isLocalOnlyGatewayTool(toolName)) {
          return toolError(
            'tailnet_local_only',
            `"${toolName}" configures who may drive this machine and is served only on its owner-only local socket, never over the tailnet. Run it from an agent on that machine.`
          )
        }
        return scopeAllows(toolName)
          ? null
          : toolError(
              'tailnet_scope_required',
              `This device is not granted "${requiredScopeForTool(toolName, options.isMutation(toolName))}", which "${toolName}" requires. Re-pair the device with that scope in Settings.`
            )
      },
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
    if (path !== TAILNET_STREAM_PATH && path !== TAILNET_TERMINAL_PATH && path !== TAILNET_EVENTS_PATH) {
      return rejectUpgrade(socket, 404, 'not_found')
    }
    if ((headerOf(request, 'upgrade') ?? '').toLowerCase() !== 'websocket') return rejectUpgrade(socket, 400, 'not_a_websocket_upgrade')
    if ((headerOf(request, 'sec-websocket-version') ?? '') !== '13') return rejectUpgrade(socket, 400, 'unsupported_websocket_version')
    const key = headerOf(request, 'sec-websocket-key')
    if (!key) return rejectUpgrade(socket, 400, 'missing_websocket_key')

    const query = queryOf(request.url)
    const device = redeemTicket(query.get('ticket'))
    if (!device) return rejectUpgrade(socket, 401, 'unauthorized')

    if (path === TAILNET_EVENTS_PATH) {
      // Any paired device may watch: the feed says only that something
      // changed, and what the device may then read is decided by the tools'
      // own scopes. No `onActivity`: a watcher is ambient, not a connection.
      const eventsPeerAddress = normalizeAddress(remoteAddressOf(socket))
      const eventsPeer = await options.peers.resolve(eventsPeerAddress)
      options.devices.recordSeen(device.id, eventsPeer)
      acceptUpgrade(socket, key)
      openEventStream(socket, device, head)
      return
    }

    if (path === TAILNET_TERMINAL_PATH) {
      // Refused BEFORE the 101, so a device without the grant never gets a
      // socket it could send an input frame on.
      if (!options.terminals) return rejectUpgrade(socket, 503, 'terminal_streaming_unavailable')
      if (!terminalAttachScopeFor(device.scopes)) return rejectUpgrade(socket, 403, 'terminal_scope_required')
      const sessionId = query.get('sessionId')?.trim()
      if (!sessionId) return rejectUpgrade(socket, 400, 'session_id_required')

      const terminalPeerAddress = normalizeAddress(remoteAddressOf(socket))
      const terminalPeer = await options.peers.resolve(terminalPeerAddress)
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
          // Emit only when the stream was actually tracked: a stream that
          // refused its own attach closes before it is added and never
          // announced an open, so it must not announce a close.
          if (registration.stream && terminalStreams.delete(registration.stream)) {
            options.onActivity?.({ kind: 'terminal', device, sessionId, open: false })
          }
        },
        log: options.log,
      })
      registration.stream = stream
      // A stream that refused its own attach has already closed and run
      // `onClosed` before this line, so only a live one is tracked.
      if (stream.isClosed()) return
      terminalStreams.add(stream)
      options.onActivity?.({
        kind: 'terminal',
        device,
        sessionId,
        open: true,
        peerNode: terminalPeer,
        peerAddress: terminalPeerAddress,
      })
      if (head?.length) socket.emit('data', head)
      return
    }

    const streamPeerAddress = normalizeAddress(remoteAddressOf(socket))
    const peerNode = await options.peers.resolve(streamPeerAddress)
    options.devices.recordSeen(device.id, peerNode)
    acceptUpgrade(socket, key)

    const session: StreamSession = { socket, deviceId: device.id, device, context: contextFor(device, peerNode) }
    streams.add(session)
    options.onActivity?.({ kind: 'stream', device, open: true, peerNode, peerAddress: streamPeerAddress })
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
      dropStream(session)
      socket.destroy()
    })
    socket.on('close', () => dropStream(session))
    socket.on('error', () => {
      dropStream(session)
      socket.destroy()
    })
  }

  /**
   * Untrack a stream and announce the close exactly once, whichever of the
   * teardown paths (peer end/close/error, revocation, server stop) runs first —
   * `streams.delete` returning false is what dedupes.
   */
  function dropStream(session: StreamSession): void {
    if (streams.delete(session)) {
      options.onActivity?.({ kind: 'stream', device: session.device, open: false })
    }
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
    for (const stream of [...eventStreams]) {
      if (stream.deviceId === deviceId) closeEventStream(stream, WEBSOCKET_CLOSE_REVOKED, 'This device has been revoked.')
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
    dropStream(session)
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
    notifyTerminalsChanged: () => notifyChanged('terminals'),
    notifyWorkspacesChanged: () => notifyChanged('workspaces'),
    eventStreamCount: () => eventStreams.size,
    streamCount: () => streams.size,
    terminalStreamCount: () => terminalStreams.size,
  }
}

/** The collect outcome as the asker may see it: never who asked (it knows) nor the store's bookkeeping. */
function wireCollectOutcome(outcome: TailnetCollectOutcome): Record<string, unknown> {
  const { asker: _asker, ...wire } = outcome
  return wire
}

/**
 * Read a reverse grant off a collect body, or null when it must not be kept.
 *
 * The endpoint's host must be the address the collect arrived from. That is
 * the one fact the transport proves about the asker, and it is what stops a
 * peer from handing this machine a credential that dials somewhere else.
 */
function readReverseGrant(value: Record<string, unknown>, peerAddress: string): TailnetReverseGrant | null {
  if (!peerAddress) return null
  const endpoint = typeof value.endpoint === 'string' ? parseTailnetEndpoint(value.endpoint) : null
  if (!endpoint || normalizeAddress(endpoint.host) !== peerAddress) return null
  const deviceToken = typeof value.deviceToken === 'string' ? value.deviceToken.trim() : ''
  const deviceId = typeof value.deviceId === 'string' ? value.deviceId.trim() : ''
  if (!deviceToken || !deviceId) return null
  const machineName = typeof value.machineName === 'string' ? value.machineName.trim().slice(0, 120) : ''
  const deviceName = typeof value.deviceName === 'string' ? value.deviceName.trim().slice(0, 120) : ''
  return {
    endpoint: `${endpoint.host.includes(':') ? `[${endpoint.host}]` : endpoint.host}:${endpoint.port}`,
    machineName: machineName || endpoint.host,
    deviceId,
    deviceName,
    deviceToken,
    scopes: normalizeTailnetScopes(value.scopes),
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

/** Thrown when a body runs past the ceiling mid-flight. */
class UploadTooLarge extends Error {}

/**
 * Stream a request body into the thread's upload directory.
 *
 * The ceiling is counted as the bytes arrive rather than trusted from
 * `content-length`, which a client controls and can simply omit. A body that
 * runs past it is cut off and the part-written file removed: a truncated
 * screenshot sitting in a folder an agent reads is worse than no screenshot,
 * because the agent cannot tell the difference.
 */
async function streamUploadToDisk(
  request: IncomingMessage,
  destination: { directory: string; path: string }
): Promise<number> {
  const { mkdir, rm } = await import('node:fs/promises')
  const { createWriteStream } = await import('node:fs')
  await mkdir(destination.directory, { recursive: true })
  const sink = createWriteStream(destination.path, { flags: 'wx' })
  let written = 0
  try {
    await new Promise<void>((resolve, reject) => {
      const fail = (error: Error) => {
        request.unpipe(sink)
        sink.destroy()
        reject(error)
      }
      request.on('data', (chunk: Buffer) => {
        written += chunk.length
        if (written > UPLOAD_MAX_BYTES) fail(new UploadTooLarge('upload over the ceiling'))
      })
      request.on('error', fail)
      sink.on('error', fail)
      sink.on('finish', () => resolve())
      request.pipe(sink)
    })
  } catch (error) {
    await rm(destination.path, { force: true }).catch(() => {})
    throw error
  }
  return written
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
