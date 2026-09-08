import { createServer, type Server, type Socket } from 'net'
import { chmodSync, existsSync, unlinkSync } from 'fs'

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
  type JsonRpcId,
} from './mcp-dispatch'
import type {
  McpConnectionContext,
  McpConnectionMetadata,
  McpToolRegistration,
  McpToolResult,
} from '../../shared/modules/mcp-tools'

// Minimal MCP server over a local socket: newline-delimited JSON-RPC 2.0 —
// the same framing as MCP's stdio transport, carried on a Unix domain socket
// (POSIX) or named pipe (Windows) so access is gated by filesystem permissions
// and no remote binding is possible. The app already hosts MCP servers for
// agents (sprintengine_mcp speaks the same dialect from Python); this is the
// TypeScript equivalent for the few methods the automation surface needs —
// initialize, tools/list, tools/call, ping — without adding an SDK dependency.
//
// The MCP semantics themselves live in mcp-dispatch.ts, shared with the opt-in
// tailnet HTTP/WS listener (tailnet/tailnet-gateway-server.ts). This file owns
// framing and connection lifetime only. Filesystem permissions remain the
// entire authentication model HERE — the tailnet transport is separate, opt-in,
// and carries its own device-token auth.

// One inbound frame may not exceed this; a client that streams an unbounded
// line gets an explicit error and a closed connection, never silent buffering.
const MAX_LINE_BYTES = 1024 * 1024

// Canonical MCP tool/connection shapes moved to src/shared/modules/mcp-tools
// (MC-1855) so the module host and SDK can share them; re-exported here for
// the automation-surface importers.
export type { McpConnectionContext, McpConnectionMetadata, McpToolRegistration, McpToolResult }

export type McpSocketServerOptions = {
  socketPath: string
  serverName: string
  serverVersion: string
  /**
   * The current tool set, evaluated on every tools/list and tools/call rather
   * than captured at construction: module-contributed tools follow module
   * enablement live (MC-1855), and the gateway is constructed before modules
   * load, so a snapshot here would be permanently stale.
   */
  resolveTools: () => McpToolRegistration[]
  onToolCall?: (event: {
    context: McpConnectionContext
    tool: string
    args: Record<string, unknown>
    durationMs: number
    result?: McpToolResult
    error?: unknown
  }) => void
  log?: (message: string) => void
}

export type McpSocketServer = {
  start(): Promise<void>
  stop(): Promise<void>
  isRunning(): boolean
  /** Tell every connected client the tool set changed (module enable/disable). */
  notifyToolsListChanged(): void
}

export function createMcpSocketServer(options: McpSocketServerOptions): McpSocketServer {
  let server: Server | null = null
  const sockets = new Set<Socket>()
  const dispatcher = createMcpDispatcher({
    serverName: options.serverName,
    serverVersion: options.serverVersion,
    resolveTools: options.resolveTools,
    onToolCall: options.onToolCall,
  })

  async function start(): Promise<void> {
    if (server) return
    // A stale socket file from a crashed previous run would block listen();
    // remove it. A *live* second instance is prevented upstream by Electron's
    // single-instance lock, so this cannot disconnect a running server.
    if (process.platform !== 'win32' && existsSync(options.socketPath)) {
      unlinkSync(options.socketPath)
    }
    const next = createServer((socket) => handleConnection(socket))
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
      next.listen(options.socketPath)
    })
    if (process.platform !== 'win32') {
      // Owner-only access; the socket is the entire authentication model.
      chmodSync(options.socketPath, 0o600)
    }
    next.on('error', (error) => options.log?.(`automation socket server error: ${error.message}`))
    server = next
  }

  async function stop(): Promise<void> {
    const current = server
    if (!current) return
    server = null
    for (const socket of sockets) socket.destroy()
    sockets.clear()
    connectionContexts.clear()
    await new Promise<void>((resolve) => current.close(() => resolve()))
    if (process.platform !== 'win32' && existsSync(options.socketPath)) {
      try {
        unlinkSync(options.socketPath)
      } catch (error) {
        options.log?.(`automation socket cleanup failed: ${message(error)}`)
      }
    }
  }

  function handleConnection(socket: Socket): void {
    sockets.add(socket)
    socket.setEncoding('utf8')
    let buffer = ''
    connectionContexts.set(socket, { metadata: { kind: 'external-local' } })
    // Preserve request ordering within one stdio bridge. In particular, the
    // bridge's advisory connection-metadata notification must be applied before
    // an immediately-following initialize/tools call on the same TCP chunk.
    let pending = Promise.resolve()
    socket.on('data', (chunk: string) => {
      buffer += chunk
      if (buffer.length > MAX_LINE_BYTES) {
        respond(socket, jsonRpcErrorResponse(null, JSONRPC_INVALID_REQUEST, 'Request frame exceeds the 1 MiB line limit.'))
        socket.destroy()
        return
      }
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line) pending = pending.then(() => handleLine(socket, line))
        newline = buffer.indexOf('\n')
      }
    })
    socket.on('close', () => {
      sockets.delete(socket)
      connectionContexts.delete(socket)
    })
    socket.on('error', () => {
      sockets.delete(socket)
      connectionContexts.delete(socket)
    })
  }

  async function handleLine(socket: Socket, line: string): Promise<void> {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      respond(socket, jsonRpcErrorResponse(null, JSONRPC_PARSE_ERROR, 'Request is not valid JSON.'))
      return
    }
    if (!isRecord(parsed) || parsed.jsonrpc !== '2.0' || typeof parsed.method !== 'string') {
      respond(socket, jsonRpcErrorResponse(idOf(parsed), JSONRPC_INVALID_REQUEST, 'Request is not a JSON-RPC 2.0 message.'))
      return
    }
    const id = idOf(parsed)
    const isNotification = id === null && !('id' in parsed)
    const params = isRecord(parsed.params) ? parsed.params : {}

    // This transport carries no headers, so `params._meta` is the whole of the
    // per-request version channel. The accepted value is validated and
    // discarded: no behaviour here varies by version, so remembering it per
    // connection would be state nobody reads.
    const declared = declaredProtocolVersion(params)
    if (declared.kind === 'unsupported') {
      const detail = unsupportedProtocolVersionMessage(declared.value)
      // A notification cannot be answered; dropping it unlogged would be the silent
      // fallback the norms forbid, so the refusal goes to the log instead.
      if (isNotification) options.log?.(`automation socket refused ${parsed.method}: ${detail}`)
      else respond(socket, jsonRpcErrorResponse(id, JSONRPC_INVALID_PARAMS, detail))
      return
    }

    try {
      const context = connectionContexts.get(socket) ?? { metadata: { kind: 'external-local' as const } }
      const result = await dispatcher.dispatch(parsed.method, params, context)
      if (result.kind === 'no_response') {
        if (!isNotification) respond(socket, { jsonrpc: '2.0', id, result: {} })
        return
      }
      if (result.kind === 'error') {
        if (!isNotification) respond(socket, jsonRpcErrorResponse(id, result.code, result.errorMessage))
        return
      }
      if (!isNotification) respond(socket, { jsonrpc: '2.0', id, result: result.value })
    } catch (error) {
      options.log?.(`automation tool dispatch threw: ${message(error)}`)
      if (!isNotification) {
        respond(socket, jsonRpcErrorResponse(id, JSONRPC_INTERNAL_ERROR, `Internal error: ${message(error)}`))
      }
    }
  }

  const connectionContexts = new Map<Socket, McpConnectionContext>()

  return {
    start,
    stop,
    isRunning: () => server !== null,
    notifyToolsListChanged: () => {
      for (const socket of sockets) {
        respond(socket, { jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
      }
    },
  }
}

function respond(socket: Socket, payload: Record<string, unknown>): void {
  if (socket.destroyed) return
  let line = JSON.stringify(payload)
  // The cap is the wire's, in both directions: a result too large for one
  // line becomes an explicit tool error rather than a frame a bridge or a
  // tailnet peer refuses and drops the connection over.
  if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES && 'id' in payload) {
    const message = `The result was too large to send (${Buffer.byteLength(line, 'utf8')} bytes; the limit is ${MAX_LINE_BYTES}). Ask for less.`
    const structured = { error: { code: 'result_too_large', message } }
    line = JSON.stringify({
      jsonrpc: '2.0',
      id: payload.id,
      result: { content: [{ type: 'text', text: JSON.stringify(structured) }], structuredContent: structured, isError: true },
    })
  }
  socket.write(`${line}\n`)
}

function idOf(value: unknown): JsonRpcId {
  return jsonRpcIdOf(value)
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
