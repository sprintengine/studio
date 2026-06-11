import { createServer, type Server, type Socket } from 'net'
import { chmodSync, existsSync, unlinkSync } from 'fs'

// Minimal MCP server over a local socket: newline-delimited JSON-RPC 2.0 —
// the same framing as MCP's stdio transport, carried on a Unix domain socket
// (POSIX) or named pipe (Windows) so access is gated by filesystem permissions
// and no remote binding is possible. The app already hosts MCP servers for
// agents (sprintengine_mcp speaks the same dialect from Python); this is the
// TypeScript equivalent for the few methods the automation surface needs —
// initialize, tools/list, tools/call, ping — without adding an SDK dependency.

const JSONRPC_PARSE_ERROR = -32700
const JSONRPC_INVALID_REQUEST = -32600
const JSONRPC_METHOD_NOT_FOUND = -32601
const JSONRPC_INVALID_PARAMS = -32602
const JSONRPC_INTERNAL_ERROR = -32603

// One inbound frame may not exceed this; a client that streams an unbounded
// line gets an explicit error and a closed connection, never silent buffering.
const MAX_LINE_BYTES = 1024 * 1024

const FALLBACK_PROTOCOL_VERSION = '2025-03-26'

export type McpToolResult = {
  content: Array<{ type: 'text'; text: string }>
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

export type McpToolRegistration = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  handler: (args: Record<string, unknown>) => Promise<McpToolResult>
}

export type McpSocketServerOptions = {
  socketPath: string
  serverName: string
  serverVersion: string
  tools: McpToolRegistration[]
  log?: (message: string) => void
}

export type McpSocketServer = {
  start(): Promise<void>
  stop(): Promise<void>
  isRunning(): boolean
}

export function createMcpSocketServer(options: McpSocketServerOptions): McpSocketServer {
  let server: Server | null = null
  const sockets = new Set<Socket>()

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
    socket.on('data', (chunk: string) => {
      buffer += chunk
      if (buffer.length > MAX_LINE_BYTES) {
        respond(socket, errorResponse(null, JSONRPC_INVALID_REQUEST, 'Request frame exceeds the 1 MiB line limit.'))
        socket.destroy()
        return
      }
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line) void handleLine(socket, line)
        newline = buffer.indexOf('\n')
      }
    })
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => sockets.delete(socket))
  }

  async function handleLine(socket: Socket, line: string): Promise<void> {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      respond(socket, errorResponse(null, JSONRPC_PARSE_ERROR, 'Request is not valid JSON.'))
      return
    }
    if (!isRecord(parsed) || parsed.jsonrpc !== '2.0' || typeof parsed.method !== 'string') {
      respond(socket, errorResponse(idOf(parsed), JSONRPC_INVALID_REQUEST, 'Request is not a JSON-RPC 2.0 message.'))
      return
    }
    const id = idOf(parsed)
    const isNotification = id === null && !('id' in parsed)
    const params = isRecord(parsed.params) ? parsed.params : {}

    try {
      const result = await dispatch(parsed.method, params)
      if (result.kind === 'no_response') {
        if (!isNotification) respond(socket, { jsonrpc: '2.0', id, result: {} })
        return
      }
      if (result.kind === 'error') {
        if (!isNotification) respond(socket, errorResponse(id, result.code, result.errorMessage))
        return
      }
      if (!isNotification) respond(socket, { jsonrpc: '2.0', id, result: result.value })
    } catch (error) {
      options.log?.(`automation tool dispatch threw: ${message(error)}`)
      if (!isNotification) {
        respond(socket, errorResponse(id, JSONRPC_INTERNAL_ERROR, `Internal error: ${message(error)}`))
      }
    }
  }

  type DispatchOutcome =
    | { kind: 'result'; value: Record<string, unknown> }
    | { kind: 'error'; code: number; errorMessage: string }
    | { kind: 'no_response' }

  async function dispatch(method: string, params: Record<string, unknown>): Promise<DispatchOutcome> {
    switch (method) {
      case 'initialize': {
        const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : FALLBACK_PROTOCOL_VERSION
        return {
          kind: 'result',
          value: {
            protocolVersion: requested,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: options.serverName, version: options.serverVersion },
          },
        }
      }
      case 'notifications/initialized':
        return { kind: 'no_response' }
      case 'ping':
        return { kind: 'result', value: {} }
      case 'tools/list':
        return {
          kind: 'result',
          value: {
            tools: options.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
          },
        }
      case 'tools/call': {
        const name = typeof params.name === 'string' ? params.name : ''
        const tool = options.tools.find((candidate) => candidate.name === name)
        if (!tool) {
          return { kind: 'error', code: JSONRPC_INVALID_PARAMS, errorMessage: `Unknown tool "${name}".` }
        }
        const args = isRecord(params.arguments) ? params.arguments : {}
        // Tool-domain failures (unknown workspace, malformed payload) come back
        // as MCP tool results with isError: true — explicit, never fake success.
        const result = await tool.handler(args)
        return { kind: 'result', value: result as unknown as Record<string, unknown> }
      }
      default:
        return { kind: 'error', code: JSONRPC_METHOD_NOT_FOUND, errorMessage: `Method "${method}" is not supported.` }
    }
  }

  return {
    start,
    stop,
    isRunning: () => server !== null,
  }
}

type JsonRpcId = string | number | null

function errorResponse(id: JsonRpcId, code: number, errorMessage: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message: errorMessage } }
}

function respond(socket: Socket, payload: Record<string, unknown>): void {
  if (socket.destroyed) return
  socket.write(`${JSON.stringify(payload)}\n`)
}

function idOf(value: unknown): JsonRpcId {
  if (!isRecord(value)) return null
  return typeof value.id === 'string' || typeof value.id === 'number' ? value.id : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
