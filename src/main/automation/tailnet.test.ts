import assert from 'node:assert/strict'
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { connect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createGatewayAuditStore, STUDIO_GATEWAY_AUDIT_FILENAME, type GatewayAuditRecord } from './gateway-audit'
import { createTailnetDeviceStore, TAILNET_DEVICES_FILENAME, type TailnetDeviceStore } from './tailnet/tailnet-devices'
import {
  createTailnetGatewayServer,
  TAILNET_CAPABILITIES,
  TAILNET_HEALTH_PATH,
  TAILNET_IDENTITY_PATH,
  TAILNET_MCP_PATH,
  TAILNET_PAIR_PATH,
  TAILNET_STREAM_PATH,
  TAILNET_TERMINAL_PATH,
  TAILNET_TRANSPORT_VERSION,
  TAILNET_WS_TICKET_PATH,
  type TailnetGatewayServer,
} from './tailnet/tailnet-gateway-server'
import { TAILNET_EVENTS_PATH, TAILNET_UPLOAD_PATH } from './tailnet/tailnet-routes'
import { resolveUploadDestination, sanitizeUploadName, uniqueName } from './tailnet/tailnet-uploads'
import { isAllowedTailnetBindAddress, isTailnetAddress, resolveTailnetInterface } from './tailnet/tailnet-interface'
import { createTailnetPeerResolver, normalizeAddress, peerNameFromWhois } from './tailnet/tailnet-peer-identity'
import { isLocalOnlyGatewayTool, requiredScopeForTool } from './tailnet/tailnet-scopes'
import { isStudioGatewayMutation } from './studio-gateway-tools'
import { createTailnetTools, type TailnetToolsFrontDoor } from './tailnet/tailnet-tools'
import { createTailnetRemoteService, formatEndpoint, pairingUrl } from './tailnet/tailnet-service'
import { DEFAULT_TAILNET_LISTENER_PORT, readTailnetSettings } from './tailnet/tailnet-settings'
import {
  computeWebSocketAcceptKey,
  createWebSocketFrameDecoder,
  encodeTextFrame,
  WEBSOCKET_CLOSE_REVOKED,
} from './tailnet/websocket-frames'
import { SUPPORTED_MCP_PROTOCOL_VERSIONS } from '../../shared/mcp/protocol'
import { STUDIO_MCP_SERVER_NAME } from '../../shared/product-identity'
import {
  tailnetScopeGrantsAccess,
  TAILNET_SCOPES,
  TAILNET_STRUCTURED_SCOPES,
  type TailnetRemoteStatus,
  type TailnetScope,
} from '../../shared/tailnet'
import type { TerminalSessionSnapshot } from '../../shared/electron-api'
import type { TerminalAttachTransport, TerminalRemoteHost } from '../terminal-remote-attach'
import { toolSuccess, type McpToolRegistration, type McpToolResult } from '../../shared/modules/mcp-tools'
import type { AgentLaunchRequest } from '../../shared/agent-launch'
import type { CliPermissionPreset } from '../../shared/electron-api'
import { createAutomationTools } from './automation-tools'
import { test } from 'vitest'

test('tailnet', async () => {
  // The tailnet listener. Every test here drives the REAL server over a
  // real TCP socket on loopback — the transport, the auth, and the audit are the
  // thing under test, so a fake would prove nothing about any of them.

  const MUTATIONS = new Set(['backlog.update', 'terminal.create', 'agent.launch', 'tailnet.offer_pairing'])

  function testTools(calls: string[] = []): McpToolRegistration[] {
    const tool = (name: string): McpToolRegistration => ({
      name,
      description: `Test tool ${name}`,
      inputSchema: { type: 'object', properties: {} },
      handler: async (args) => {
        calls.push(name)
        return toolSuccess({ ok: true, tool: name, workspaceId: args.workspaceId ?? null })
      },
    })
    return [
      'backlog.list',
      'backlog.update',
      'workspace.list',
      'workspace.checkout',
      'terminal.list',
      'terminal.create',
      'agent.launch',
    ].map(tool)
  }

  type Harness = {
    server: TailnetGatewayServer
    devices: TailnetDeviceStore
    port: number
    userDataDir: string
    calls: string[]
    terminals: StubTerminalHost
    auditRecords(): GatewayAuditRecord[]
    close(): Promise<void>
  }

  async function startHarness(
    options: {
      peerNode?: string | null
      terminals?: TerminalRemoteHost | null
      /** Serve a real tool set instead of the named stubs (the whole-flow case). */
      tools?: McpToolRegistration[]
      /** The change feed's push floor; the feed test shortens it. */
      changePushIntervalMs?: number
      /** The working directory the stub's sessions report — where an upload lands. */
      terminalCwd?: string
    } = {},
  ): Promise<Harness> {
    const userDataDir = mkdtempSync(join(tmpdir(), 'multicode-tailnet-'))
    const calls: string[] = []
    const devices = createTailnetDeviceStore({ resolveUserDataDir: () => userDataDir })
    const audit = createGatewayAuditStore({ resolveUserDataDir: () => userDataDir })
    const terminals = createStubTerminalHost(options.terminalCwd)
    const server = createTailnetGatewayServer({
      bindAddress: '127.0.0.1',
      port: 0,
      serverName: 'sprintengine-studio',
      serverVersion: '9.9.9',
      resolveTools: () => options.tools ?? testTools(calls),
      isMutation: (name) => MUTATIONS.has(name),
      devices,
      // `null` stands for a build with terminal streaming unwired, so the route's
      // own refusal is testable; every other harness gets the stub host.
      terminals: options.terminals === null ? undefined : (options.terminals ?? terminals),
      // whois is injected: the tests must not depend on a Tailscale install.
      peers: createTailnetPeerResolver({ runWhois: async () => options.peerNode ?? null }),
      onToolCall: ({ context, tool, args, durationMs, result, error }) => {
        if (!MUTATIONS.has(tool)) return
        audit.record({ connection: context.metadata, tool, args, durationMs, result, error })
      },
      ...(options.changePushIntervalMs !== undefined ? { changePushIntervalMs: options.changePushIntervalMs } : {}),
    })
    await server.start()
    const address = server.address()
    assert.ok(address, 'the harness server reports a bound address')
    return {
      server,
      devices,
      port: address.port,
      userDataDir,
      calls,
      terminals,
      auditRecords: () => {
        const path = join(userDataDir, STUDIO_GATEWAY_AUDIT_FILENAME)
        if (!existsSync(path)) return []
        return readFileSync(path, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as GatewayAuditRecord)
      },
      async close() {
        await server.stop()
        rmSync(userDataDir, { recursive: true, force: true })
      },
    }
  }

  type HttpAnswer = { status: number; headers: Record<string, string | string[] | undefined>; body: unknown }

  function call(
    port: number,
    method: string,
    path: string,
    options: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<HttpAnswer> {
    return new Promise((resolve, reject) => {
      const payload = options.body === undefined ? undefined : JSON.stringify(options.body)
      const request = httpRequest(
        {
          host: '127.0.0.1',
          port,
          method,
          path,
          // No connection pooling: a pooled socket from an earlier call would
          // make "is this port still listening" untestable.
          agent: false,
          headers: {
            ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
            ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
            ...options.headers,
          },
        },
        (response) => {
          const chunks: Buffer[] = []
          response.on('data', (chunk: Buffer) => chunks.push(chunk))
          response.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8')
            let body: unknown = text
            try {
              body = text ? JSON.parse(text) : null
            } catch {
              // Left as text; a test asserting on shape will fail loudly.
            }
            resolve({ status: response.statusCode ?? 0, headers: response.headers, body })
          })
        },
      )
      request.on('error', reject)
      if (payload) request.write(payload)
      request.end()
    })
  }

  /**
   * A raw-body POST, which the upload route needs and `call` cannot express:
   * `call` JSON-encodes whatever it is given, and the upload's whole point is
   * that the body is the file's own bytes.
   */
  function callRaw(
    port: number,
    path: string,
    options: { token?: string; body: Buffer; chunked?: boolean; headers?: Record<string, string> },
  ): Promise<HttpAnswer> {
    return new Promise((resolve, reject) => {
      let answered = false
      const request = httpRequest(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path,
          agent: false,
          headers: {
            'Content-Type': 'application/octet-stream',
            // Chunked is the case that matters for the ceiling: a client controls
            // `content-length` and can simply omit it, so the server counts.
            ...(options.chunked ? { 'Transfer-Encoding': 'chunked' } : { 'Content-Length': options.body.length }),
            ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
            ...options.headers,
          },
        },
        (response) => {
          const chunks: Buffer[] = []
          answered = true
          const settle = () => {
            const text = Buffer.concat(chunks).toString('utf8')
            let body: unknown = text
            try {
              body = text ? JSON.parse(text) : null
            } catch {
              // Left as text; a test asserting on shape will fail loudly.
            }
            resolve({ status: response.statusCode ?? 0, headers: response.headers, body })
          }
          response.on('data', (chunk: Buffer) => chunks.push(chunk))
          response.on('end', settle)
          // The refusal hangs up, which can close the socket before `end`. The
          // answer is already whole by then, so this settles rather than hangs.
          response.on('close', settle)
          response.on('aborted', settle)
        },
      )
      // The server answers an oversized body before reading all of it and then
      // hangs up, so the write legitimately fails under us. A reset AFTER the
      // answer arrived is the refusal working; a reset BEFORE it must fail loudly
      // rather than hang.
      request.on('error', (error: NodeJS.ErrnoException) => {
        if (answered) return
        if (error.code === 'ECONNRESET' || error.code === 'EPIPE') {
          reject(new Error(`the connection was cut before any answer arrived: ${error.code}`))
          return
        }
        reject(error)
      })
      request.write(options.body)
      request.end()
    })
  }

  function uploadPath(sessionId: string, name: string): string {
    return `${TAILNET_UPLOAD_PATH}?sessionId=${encodeURIComponent(sessionId)}&name=${encodeURIComponent(name)}`
  }

  async function pairDevice(
    harness: Harness,
    options: { scopes?: TailnetScope[]; name?: string } = {},
  ): Promise<{ deviceId: string; deviceToken: string }> {
    const offer = harness.devices.offerPairing({ scopes: options.scopes ?? [...TAILNET_STRUCTURED_SCOPES] })
    const answer = await call(harness.port, 'POST', TAILNET_PAIR_PATH, {
      body: { pairingToken: offer.token, deviceName: options.name ?? 'laptop' },
    })
    assert.equal(answer.status, 200)
    const body = answer.body as { deviceId: string; deviceToken: string }
    return { deviceId: body.deviceId, deviceToken: body.deviceToken }
  }

  function rpc(id: number, method: string, params?: Record<string, unknown>): Record<string, unknown> {
    return { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }
  }

  // ── A stand-in terminal runtime for the TRANSPORT tests ──────────────────────
  //
  // The runtime's own half — multi-sender fan-out, per-viewer gates, replay-then-
  // live, drop-and-resync — is driven against the real terminal runtime and a
  // real pty mock in terminal-runtime.test.ts. What is under test HERE is the
  // socket: auth, scope enforcement at the frame, revocation. So this implements
  // the same port with an in-memory session, and records what the transport asked
  // it to do.

  type StubTerminalHost = TerminalRemoteHost & {
    /** Register a session, as a spawn does. Attachable from the moment it exists. */
    create(sessionId: string): void
    /** Push output to every attached viewer, as a pty's onData would. */
    emit(sessionId: string, data: string): void
    writes: Array<{ sessionId: string; data: string }>
    resizes: Array<{ sessionId: string; cols: number; rows: number }>
    attachedCount(): number
  }

  function createStubTerminalHost(cwd = '/tmp/project'): StubTerminalHost {
    const replay = new Map<string, string>([['session_one', 'scrollback so far\r\n']])
    const attached = new Map<string, { sessionId: string; transport: TerminalAttachTransport }>()
    const writes: Array<{ sessionId: string; data: string }> = []
    const resizes: Array<{ sessionId: string; cols: number; rows: number }> = []

    const snapshotFor = (sessionId: string): TerminalSessionSnapshot =>
      ({
        sessionId,
        processAlive: true,
        kind: 'agent',
        agentName: 'Scout',
        cli: 'claude-code',
        cwd,
        visible: true,
        suspended: false,
        reapExempt: false,
        startedAt: 0,
        lastOutputAt: 0,
        lastInputAt: null,
        lastVisibleAt: null,
        activity: { kind: 'working', since: 0 },
        exitedAt: null,
        outputBufferLength: 0,
        retainedOutputBytes: 0,
        historyTier: 'standard',
        replayLimitBytes: 1024,
      }) as unknown as TerminalSessionSnapshot

    return {
      writes,
      resizes,
      attachedCount: () => attached.size,
      create(sessionId) {
        replay.set(sessionId, '')
      },
      emit(sessionId, data) {
        replay.set(sessionId, `${replay.get(sessionId) ?? ''}${data}`)
        for (const viewer of attached.values()) {
          if (viewer.sessionId === sessionId && viewer.transport.isOpen()) {
            viewer.transport.send({ type: 'output', data })
          }
        }
      },
      listSessions: () => [...replay.keys()].map(snapshotFor),
      attach({ sessionId, scope, transport }) {
        if (!replay.has(sessionId)) {
          return { ok: false, code: 'unknown_terminal', message: `No terminal session "${sessionId}".` }
        }
        attached.set(transport.viewerId, { sessionId, transport })
        transport.send({ type: 'replay', data: replay.get(sessionId) ?? '', reason: 'attach' })
        const refuse = (verb: string) => ({
          ok: false as const,
          code: 'terminal_control_required',
          message: `Watch-only: cannot ${verb}.`,
        })
        return {
          ok: true,
          attachment: {
            sessionId,
            scope,
            session: snapshotFor(sessionId),
            write: (data) => {
              if (scope !== 'control') return refuse('type')
              writes.push({ sessionId, data })
              return { ok: true }
            },
            resize: (cols, rows) => {
              if (scope !== 'control') return refuse('resize')
              resizes.push({ sessionId, cols, rows })
              return { ok: true }
            },
            detach: () => {
              attached.delete(transport.viewerId)
            },
          },
        }
      },
    }
  }

  // ── A minimal client-side WebSocket, enough to prove the server's half ────────

  type TestWebSocket = {
    socket: Socket
    /** The raw HTTP response head — 101 on success, or the refusal that replaced it. */
    handshake: string
    send(payload: Record<string, unknown>): void
    /** Next server text frame, parsed. */
    nextMessage(): Promise<Record<string, unknown>>
    /** Resolves with the close code the server sent, or null if it closed without one. */
    closed: Promise<number | null>
  }

  /** A masked client text frame, in whichever length form the payload needs. */
  function maskedTextFrame(text: string): Buffer {
    const payload = Buffer.from(text, 'utf8')
    assert.ok(payload.length < 65536, 'test frames stay under the 16-bit length form')
    const mask = randomBytes(4)
    const masked = Buffer.from(payload)
    for (let index = 0; index < masked.length; index += 1) masked[index] ^= mask[index % 4]
    let header: Buffer
    if (payload.length < 126) {
      header = Buffer.from([0x81, 0x80 | payload.length])
    } else {
      header = Buffer.alloc(4)
      header[0] = 0x81
      header[1] = 0x80 | 126
      header.writeUInt16BE(payload.length, 2)
    }
    return Buffer.concat([header, mask, masked])
  }

  async function openWebSocket(
    port: number,
    ticket: string,
    route: { path?: string; query?: Record<string, string> } = {},
  ): Promise<TestWebSocket> {
    const key = randomBytes(16).toString('base64')
    const socket = connect({ host: '127.0.0.1', port })
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('error', reject)
    })
    const extraQuery = Object.entries(route.query ?? {})
      .map(([name, value]) => `&${name}=${encodeURIComponent(value)}`)
      .join('')
    socket.write(
      [
        `GET ${route.path ?? TAILNET_STREAM_PATH}?ticket=${encodeURIComponent(ticket)}${extraQuery} HTTP/1.1`,
        'Host: 127.0.0.1',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        '',
        '',
      ].join('\r\n'),
    )

    const messages: Record<string, unknown>[] = []
    const waiters: Array<(value: Record<string, unknown>) => void> = []
    let closeCode: number | null = null
    let resolveClosed: (code: number | null) => void = () => {}
    const closed = new Promise<number | null>((resolve) => {
      resolveClosed = resolve
    })

    // Declared BEFORE the handshake await: a terminal attach sends its replay
    // frame immediately after the 101, so `consume` can run from inside the
    // handshake handler — with the declaration below the await that is a
    // temporal-dead-zone crash rather than a decoded frame.
    let buffer = Buffer.alloc(0)

    const handshake = await new Promise<string>((resolve, reject) => {
      let headBuffer = Buffer.alloc(0)
      const onData = (chunk: Buffer): void => {
        headBuffer = Buffer.concat([headBuffer, chunk])
        const end = headBuffer.indexOf('\r\n\r\n')
        if (end === -1) return
        socket.removeListener('data', onData)
        const head = headBuffer.subarray(0, end + 4).toString('utf8')
        const rest = headBuffer.subarray(end + 4)
        socket.on('data', (next: Buffer) => consume(next))
        if (rest.length) consume(rest)
        resolve(head)
      }
      socket.on('data', onData)
      socket.once('error', reject)
      socket.once('close', () => resolve(headBuffer.toString('utf8')))
    })
    if (handshake.startsWith('HTTP/1.1 101')) {
      assert.ok(
        handshake.includes(`Sec-WebSocket-Accept: ${computeWebSocketAcceptKey(key)}`),
        'the server computes the RFC 6455 accept key',
      )
    }

    // Server frames are never masked, so the shared decoder cannot read them;
    // this is the client-side mirror of it, and small enough to keep inline.
    function consume(chunk: Buffer): void {
      buffer = Buffer.concat([buffer, chunk])
      for (;;) {
        if (buffer.length < 2) return
        const opcode = buffer[0] & 0x0f
        let length = buffer[1] & 0x7f
        let offset = 2
        if (length === 126) {
          if (buffer.length < 4) return
          length = buffer.readUInt16BE(2)
          offset = 4
        }
        if (buffer.length < offset + length) return
        const payload = buffer.subarray(offset, offset + length)
        buffer = buffer.subarray(offset + length)
        if (opcode === 0x8) {
          closeCode = payload.length >= 2 ? payload.readUInt16BE(0) : null
          resolveClosed(closeCode)
          return
        }
        if (opcode !== 0x1) continue
        const parsed = JSON.parse(payload.toString('utf8')) as Record<string, unknown>
        const waiter = waiters.shift()
        if (waiter) waiter(parsed)
        else messages.push(parsed)
      }
    }
    socket.on('close', () => resolveClosed(closeCode))

    return {
      socket,
      handshake,
      send: (payload) => socket.write(maskedTextFrame(JSON.stringify(payload))),
      nextMessage: () =>
        new Promise((resolve) => {
          const queued = messages.shift()
          if (queued) resolve(queued)
          else waiters.push(resolve)
        }),
      closed,
    }
  }

  async function waitFor(predicate: () => boolean, description: string, timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (predicate()) return
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(`Timed out waiting for ${description}`)
  }

  // ── Bind policy ──────────────────────────────────────────────────────────────

  async function testBindAddressAllowsOnlyTailnetOrLoopback(): Promise<void> {
    for (const allowed of [
      '100.64.0.1',
      '100.101.102.103',
      '100.127.255.254',
      '127.0.0.1',
      '::1',
      'fd7a:115c:a1e0::1',
    ]) {
      assert.equal(isAllowedTailnetBindAddress(allowed), true, `${allowed} is a legal bind address`)
    }
    for (const refused of [
      '0.0.0.0',
      '::',
      '',
      '192.168.1.20',
      '10.0.0.4',
      '172.16.3.9',
      '100.63.255.255',
      '100.128.0.1',
      '8.8.8.8',
    ]) {
      assert.equal(isAllowedTailnetBindAddress(refused), false, `${refused} must never be bound`)
    }
    // 100.64.0.0/10 boundaries, stated separately from the bind allowlist so a
    // loopback exemption cannot hide a wrong range.
    assert.equal(isTailnetAddress('100.64.0.0'), true)
    assert.equal(isTailnetAddress('100.127.255.255'), true)
    assert.equal(isTailnetAddress('100.63.255.255'), false)
    assert.equal(isTailnetAddress('100.128.0.0'), false)
    assert.equal(isTailnetAddress('127.0.0.1'), false)

    // The server refuses before listen(), so a bad address never opens a port.
    for (const bindAddress of ['0.0.0.0', '192.168.1.20']) {
      const refused = createTailnetGatewayServer({
        bindAddress,
        port: 0,
        serverName: 'sprintengine-studio',
        serverVersion: '9.9.9',
        resolveTools: () => [],
        isMutation: () => false,
        devices: createTailnetDeviceStore({ resolveUserDataDir: () => tmpdir() }),
        peers: createTailnetPeerResolver({ runWhois: async () => null }),
      })
      await assert.rejects(() => refused.start(), /Refusing to bind the tailnet gateway/u)
      assert.equal(refused.isRunning(), false)
      assert.equal(refused.address(), null)
    }

    // Whatever this machine reports must itself satisfy the policy — a resolver
    // that handed back a LAN address would defeat every guard above.
    const resolved = resolveTailnetInterface()
    if (resolved) assert.equal(isTailnetAddress(resolved.address), true)
    assert.equal(
      resolveTailnetInterface({ en0: [{ address: '192.168.1.5', family: 'IPv4', internal: false } as never] }),
      null,
      'a LAN-only machine has no tailnet interface',
    )
  }

  async function testDisabledMeansNoListeningTcpSocket(): Promise<void> {
    const userDataDir = mkdtempSync(join(tmpdir(), 'multicode-tailnet-off-'))
    try {
      // Default-off in every build: a profile that has never been configured.
      assert.deepEqual(readTailnetSettings(userDataDir).settings, {
        enabled: false,
        port: DEFAULT_TAILNET_LISTENER_PORT,
        notifications: true,
      })

      const service = createTailnetRemoteService({
        resolveUserDataDir: () => userDataDir,
        serverName: 'sprintengine-studio',
        serverVersion: '9.9.9',
        resolveTools: () => testTools(),
        isMutation: (name) => MUTATIONS.has(name),
        resolveBindAddress: () => '127.0.0.1',
      })
      const initial = await service.initialize()
      assert.equal(initial.enabled, false)
      assert.equal(initial.running, false)
      assert.equal(initial.endpoint, null)

      // Turn it on to learn a port that is definitely ours, then turn it off and
      // prove the socket is gone rather than merely reported as stopped.
      const enabled = await service.setEnabled(true)
      assert.equal(enabled.running, true)
      assert.ok(enabled.endpoint?.startsWith('127.0.0.1:'), `endpoint is loopback-bound: ${enabled.endpoint}`)
      const port = Number(enabled.endpoint?.split(':').pop())
      assert.equal((await call(port, 'GET', TAILNET_HEALTH_PATH)).status, 200)

      const disabled = await service.setEnabled(false)
      assert.equal(disabled.running, false)
      assert.equal(disabled.endpoint, null)
      await assert.rejects(() => call(port, 'GET', TAILNET_HEALTH_PATH), /ECONNREFUSED/u)
      await service.shutdown()
    } finally {
      rmSync(userDataDir, { recursive: true, force: true })
    }
  }

  async function testEnabledWithoutATailnetRefusesInsteadOfBindingAnythingElse(): Promise<void> {
    const userDataDir = mkdtempSync(join(tmpdir(), 'multicode-tailnet-none-'))
    try {
      const service = createTailnetRemoteService({
        resolveUserDataDir: () => userDataDir,
        serverName: 'sprintengine-studio',
        serverVersion: '9.9.9',
        resolveTools: () => [],
        isMutation: () => false,
        // Tailscale is not up on this machine.
        resolveBindAddress: () => null,
      })
      const status = await service.setEnabled(true)
      assert.equal(status.enabled, true)
      assert.equal(status.running, false)
      assert.equal(status.endpoint, null)
      assert.match(status.lastError ?? '', /no Tailscale interface was found/u)
      await service.shutdown()
    } finally {
      rmSync(userDataDir, { recursive: true, force: true })
    }
  }

  async function testTheListenerBindsWhenTailscaleComesUpAfterTheApp(): Promise<void> {
    // The boot race the owner hit on 2026-09-05: Studio launched from a login
    // item before Tailscale was up, the listener refused to bind, and nothing
    // ever looked again — the setting read `enabled: true` for hours while the
    // phone got "the desktop did not answer" from a machine that was running
    // fine. The refusal must be a "not yet", not a verdict.
    const userDataDir = mkdtempSync(join(tmpdir(), 'multicode-tailnet-late-'))
    try {
      // A port nothing else holds, and loopback as the "interface": the bind
      // guard allows loopback, and a real 100.64/10 address cannot be bound on a
      // machine that does not actually have it (EADDRNOTAVAIL). The setting file
      // is written directly because the port must be free BEFORE the service
      // reads it — `isUsablePort` refuses 0, so there is no ephemeral escape.
      const port = await freePort()
      writeFileSync(
        join(userDataDir, 'tailnet-remote-settings.json'),
        JSON.stringify({ enabled: false, port, notifications: true }),
      )

      let tailscaleIsUp = false
      const service = createTailnetRemoteService({
        resolveUserDataDir: () => userDataDir,
        serverName: 'sprintengine-studio',
        serverVersion: '9.9.9',
        resolveTools: () => [],
        isMutation: () => false,
        resolveBindAddress: () => (tailscaleIsUp ? '127.0.0.1' : null),
        interfaceWatchMs: 5,
      })

      const refused = await service.setEnabled(true)
      assert.equal(refused.running, false, 'nothing binds while there is no interface')
      assert.match(refused.lastError ?? '', /no Tailscale interface was found/u)

      tailscaleIsUp = true
      await waitFor(() => service.getStatus().running, 'the listener to bind once an interface appears')
      const bound = service.getStatus()
      assert.equal(bound.running, true, 'the watcher binds once an interface appears')
      assert.equal(bound.endpoint, `127.0.0.1:${port}`, 'bound somewhere unexpected')
      assert.equal(bound.lastError, null, 'the stale refusal is cleared once it stops being true')

      await service.shutdown()
    } finally {
      rmSync(userDataDir, { recursive: true, force: true })
    }
  }

  async function testTheListenerStandsDownWhenTailscaleGoesAway(): Promise<void> {
    // The other half of the late-Tailscale watch. Quitting Tailscale takes the
    // address off the interface, but the socket bound to it stays open as far as
    // Node is concerned — so `isRunning()` kept answering true and every surface
    // said "Serving" against a machine nothing could reach. Reported by the
    // owner on 2026-09-05, having disconnected Tailscale and watched the glyph
    // stay green.
    const userDataDir = mkdtempSync(join(tmpdir(), 'multicode-tailnet-away-'))
    try {
      const port = await freePort()
      writeFileSync(
        join(userDataDir, 'tailnet-remote-settings.json'),
        JSON.stringify({ enabled: false, port, notifications: true }),
      )
      let tailscaleIsUp = true
      const events: Array<{ running: boolean; error: string | null }> = []
      const service = createTailnetRemoteService({
        resolveUserDataDir: () => userDataDir,
        serverName: 'sprintengine-studio',
        serverVersion: '9.9.9',
        resolveTools: () => [],
        isMutation: () => false,
        resolveBindAddress: () => (tailscaleIsUp ? '127.0.0.1' : null),
        interfaceWatchMs: 5,
        onEvent: (payload) => {
          if (payload.event.kind === 'listener') {
            events.push({ running: payload.event.running, error: payload.event.running ? null : payload.event.error })
          }
        },
      })

      const serving = await service.setEnabled(true)
      assert.equal(serving.running, true, 'bound while Tailscale is up')

      tailscaleIsUp = false
      await waitFor(() => !service.getStatus().running, 'the listener to stand down when the interface goes away')
      const down = service.getStatus()
      assert.equal(down.running, false, 'not serving, because nothing can reach it')
      assert.equal(down.endpoint, null, 'and no endpoint is claimed')
      assert.match(down.lastError ?? '', /Tailscale is no longer up/u, 'the reason is said, not left blank')
      assert.ok(
        events.some((event) => !event.running && /no longer up/u.test(event.error ?? '')),
        'every window is told over the push channel, not on next open',
      )

      // And the same beat brings it back: standing down is not a verdict either.
      tailscaleIsUp = true
      await waitFor(() => service.getStatus().running, 'the listener to bind again when Tailscale returns')
      assert.equal(service.getStatus().lastError, null, 'the stale reason is cleared once it stops being true')

      await service.shutdown()
    } finally {
      rmSync(userDataDir, { recursive: true, force: true })
    }
  }

  /** A port that is free right now, for a test that must really bind one. */
  async function freePort(): Promise<number> {
    const net = await import('node:net')
    return await new Promise<number>((resolve, reject) => {
      const probe = net.createServer()
      probe.once('error', reject)
      probe.listen(0, '127.0.0.1', () => {
        const address = probe.address()
        const value = typeof address === 'object' && address ? address.port : 0
        probe.close(() => resolve(value))
      })
    })
  }

  async function testTheInterfaceWatchStopsWhenTheListenerIsTurnedOff(): Promise<void> {
    // The watch must not outlive the setting: a machine that never runs
    // Tailscale, with remote turned back off, should be enumerating nothing.
    const userDataDir = mkdtempSync(join(tmpdir(), 'multicode-tailnet-watch-'))
    try {
      let looks = 0
      const service = createTailnetRemoteService({
        resolveUserDataDir: () => userDataDir,
        serverName: 'sprintengine-studio',
        serverVersion: '9.9.9',
        resolveTools: () => [],
        isMutation: () => false,
        resolveBindAddress: () => {
          looks += 1
          return null
        },
        interfaceWatchMs: 5,
      })
      await service.setEnabled(true)
      await new Promise((resolve) => setTimeout(resolve, 40))
      await service.setEnabled(false)
      const afterOff = looks
      await new Promise((resolve) => setTimeout(resolve, 40))
      assert.equal(looks, afterOff, 'the watch kept polling after remote control was turned off')
      await service.shutdown()
    } finally {
      rmSync(userDataDir, { recursive: true, force: true })
    }
  }

  // ── Uploads from a paired device (backlog id 88) ─────────────────────────────

  async function testUploadDestinationsCannotEscapeTheThreadsFolder(): Promise<void> {
    const cwd = '/Users/someone/repo'
    // The ordinary case: inside the thread's own folder, under a per-session dir.
    const ok = resolveUploadDestination({ cwd, sessionId: 'sess_1', name: 'shot.png' })
    assert.equal(ok.ok, true)
    if (ok.ok) {
      assert.equal(ok.path, '/Users/someone/repo/.sprintengine/uploads/sess_1/shot.png')
      assert.ok(ok.path.startsWith(cwd + '/'), 'the file lands under the working directory')
    }

    // Traversal, in every shape a phone could send it. None of these may produce
    // a path outside the folder; each becomes a leaf name instead.
    for (const name of [
      '../../../../etc/passwd',
      '..\\..\\Windows\\System32\\drivers\\etc\\hosts',
      '/etc/passwd',
      'C:\\Windows\\win.ini',
      '....//....//escape.txt',
      '.',
      '..',
    ]) {
      const attempt = resolveUploadDestination({ cwd, sessionId: 'sess_1', name })
      assert.equal(attempt.ok, true, `${name} should be sanitised, not refused`)
      if (attempt.ok) {
        assert.ok(
          attempt.path.startsWith('/Users/someone/repo/.sprintengine/uploads/sess_1/'),
          `${name} escaped to ${attempt.path}`,
        )
        assert.doesNotMatch(attempt.path.split('/uploads/sess_1/')[1] ?? '', /[\\/]/u, `${name} kept a separator`)
      }
    }

    // A session id is a path segment too, and it is not more trusted than a name.
    const forgedSession = resolveUploadDestination({ cwd, sessionId: '../../..', name: 'shot.png' })
    assert.equal(forgedSession.ok, true)
    if (forgedSession.ok) {
      assert.ok(
        forgedSession.path.startsWith('/Users/someone/repo/.sprintengine/uploads/'),
        'a forged session id escaped',
      )
    }

    // No working directory is a refusal, not a fallback to somewhere convenient:
    // an agent confined to its project cannot read a file outside it, so the
    // upload would "succeed" and be useless.
    for (const cwdless of [null, undefined, '', '   ', 'relative/path']) {
      const refused = resolveUploadDestination({ cwd: cwdless, sessionId: 'sess_1', name: 'shot.png' })
      assert.equal(refused.ok, false, `${String(cwdless)} should be refused`)
      if (!refused.ok) assert.equal(refused.code, 'invalid_session')
    }
  }

  async function testUploadNamesAreLeavesAndNeverOverwrite(): Promise<void> {
    assert.equal(sanitizeUploadName('holiday photo.png'), 'holiday photo.png')
    assert.equal(sanitizeUploadName('  ../../secret.env  '), 'secret.env')
    assert.equal(sanitizeUploadName('..'), 'upload', 'a name that sanitises to nothing still gets one')
    assert.equal(sanitizeUploadName(''), 'upload')
    assert.equal(sanitizeUploadName('a\u0000b\u001fc.txt'), 'abc.txt', 'control characters are removed')
    assert.equal(sanitizeUploadName('what:is*this?.png'), 'what_is_this_.png')
    assert.ok(sanitizeUploadName('x'.repeat(400)).length <= 120, 'a name cannot be unbounded')

    // Two photos from a camera roll carry the same name far more often than not,
    // and silently replacing the first is a loss nobody can see from a phone.
    const taken = new Set(['shot.png', 'shot (2).png'])
    assert.equal(uniqueName('shot.png', taken), 'shot (3).png')
    assert.equal(uniqueName('notes', new Set(['notes'])), 'notes (2)')
    assert.equal(uniqueName('fresh.png', taken), 'fresh.png')
  }

  // ── Pairing and authentication ───────────────────────────────────────────────

  async function testUnpairedClientsGet401AndPairedClientsDriveTheGateway(): Promise<void> {
    const harness = await startHarness({ peerNode: 'mac-mini.tail1234.ts.net' })
    try {
      const unauthorized = await call(harness.port, 'POST', TAILNET_MCP_PATH, { body: rpc(1, 'tools/list') })
      assert.equal(unauthorized.status, 401)
      assert.equal((unauthorized.body as { error: { code: string } }).error.code, 'unauthorized')
      assert.match(String(unauthorized.headers['www-authenticate']), /^Bearer /u)

      assert.equal(
        (
          await call(harness.port, 'POST', TAILNET_MCP_PATH, {
            token: 'mctn_not-a-real-token',
            body: rpc(1, 'tools/list'),
          })
        ).status,
        401,
        'a fabricated token is not a credential',
      )

      const device = await pairDevice(harness)
      const listed = await call(harness.port, 'POST', TAILNET_MCP_PATH, {
        token: device.deviceToken,
        body: rpc(2, 'tools/list'),
      })
      assert.equal(listed.status, 200)
      const tools = (listed.body as { result: { tools: Array<{ name: string }>; ttlMs: number } }).result
      assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
        'agent.launch',
        'backlog.list',
        'backlog.update',
        'workspace.checkout',
        'workspace.list',
      ])
      assert.equal(tools.ttlMs, 300_000, 'the tailnet transport carries the same tools/list TTL as the socket')

      const called = await call(harness.port, 'POST', TAILNET_MCP_PATH, {
        token: device.deviceToken,
        body: rpc(3, 'tools/call', { name: 'workspace.list', arguments: { workspaceId: 'w1' } }),
      })
      assert.equal(called.status, 200)
      assert.deepEqual(harness.calls, ['workspace.list'])
      assert.equal(
        (called.body as { result: { structuredContent: { workspaceId: string } } }).result.structuredContent
          .workspaceId,
        'w1',
      )

      const identity = await call(harness.port, 'GET', TAILNET_IDENTITY_PATH, { token: device.deviceToken })
      assert.equal(identity.status, 200)
      assert.equal((identity.body as { deviceId: string }).deviceId, device.deviceId)
      // Identity says the same wire facts health does, for a client that paired
      // long ago and is asking again on a Studio that may since have moved on.
      const identityBody = identity.body as Record<string, unknown>
      assert.equal(identityBody.transportVersion, TAILNET_TRANSPORT_VERSION)
      assert.deepEqual(identityBody.capabilities, ['events', 'sliced-frames', 'upload'])

      // The pairing code is one-time: replaying it does not mint a second device.
      const replayed = await call(harness.port, 'POST', TAILNET_PAIR_PATH, {
        body: { pairingToken: 'mcpair_whatever', deviceName: 'laptop-2' },
      })
      assert.equal(replayed.status, 401)
      assert.equal(harness.devices.listDevices().length, 1)

      // Only the hash is persisted; the device token itself never reaches disk.
      const stored = readFileSync(join(harness.userDataDir, TAILNET_DEVICES_FILENAME), 'utf8')
      assert.equal(stored.includes(device.deviceToken), false, 'the device token is never written to disk')
      assert.match(stored, /"tokenHash": "[0-9a-f]{64}"/u)
    } finally {
      await harness.close()
    }
  }

  async function testBrowserOriginatedRequestsAreRefused(): Promise<void> {
    const harness = await startHarness()
    try {
      const device = await pairDevice(harness)
      const answer = await call(harness.port, 'POST', TAILNET_MCP_PATH, {
        token: device.deviceToken,
        body: rpc(1, 'tools/list'),
        headers: { Origin: 'http://evil.example' },
      })
      assert.equal(answer.status, 403)
      assert.equal((answer.body as { error: { code: string } }).error.code, 'origin_not_allowed')
    } finally {
      await harness.close()
    }
  }

  async function testOversizedAndMalformedBodiesAreRefusedExplicitly(): Promise<void> {
    const harness = await startHarness()
    try {
      const device = await pairDevice(harness)
      const oversize = await call(harness.port, 'POST', TAILNET_MCP_PATH, {
        token: device.deviceToken,
        body: { jsonrpc: '2.0', id: 1, method: 'ping', params: { padding: 'x'.repeat(1024 * 1024 + 16) } },
      })
      assert.equal(oversize.status, 413, 'the client learns why, rather than seeing a bare reset')
      assert.equal((oversize.body as { error: { code: string } }).error.code, 'body_too_large')

      const malformed = await call(harness.port, 'POST', TAILNET_MCP_PATH, {
        token: device.deviceToken,
        headers: { 'Content-Type': 'application/json' },
        body: 'not-an-object',
      })
      assert.equal(malformed.status, 200)
      assert.equal(
        (malformed.body as { error: { code: number } }).error.code,
        -32600,
        'a non-JSON-RPC body is a JSON-RPC invalid-request, not a transport error',
      )

      // The listener still answers after both refusals.
      assert.equal((await call(harness.port, 'GET', TAILNET_HEALTH_PATH)).status, 200)
    } finally {
      await harness.close()
    }
  }

  async function testHealthEndpointLeaksNothingBeyondProductAndProtocol(): Promise<void> {
    const harness = await startHarness()
    try {
      await pairDevice(harness, { name: 'a-device-nobody-should-learn-about' })
      const answer = await call(harness.port, 'GET', TAILNET_HEALTH_PATH)
      assert.equal(answer.status, 200)
      const body = answer.body as Record<string, unknown>
      assert.deepEqual(Object.keys(body).sort(), ['capabilities', 'product', 'protocolVersions', 'transportVersion'])
      assert.equal(body.product, STUDIO_MCP_SERVER_NAME)
      assert.deepEqual(body.protocolVersions, [...SUPPORTED_MCP_PROTOCOL_VERSIONS])
      // What the wire speaks IS a prospective client's business: it is the whole
      // reason the route is unauthenticated. Version 2 and the feature list say
      // it outright, so a phone need not probe for the change feed.
      assert.equal(body.transportVersion, 2)
      assert.equal(TAILNET_TRANSPORT_VERSION, 2)
      assert.deepEqual(body.capabilities, ['events', 'sliced-frames', 'upload'])
      assert.deepEqual([...TAILNET_CAPABILITIES], body.capabilities)
      // Nothing about this machine, its user, its workspaces, or its devices.
      assert.equal(JSON.stringify(body).includes('a-device-nobody-should-learn-about'), false)
    } finally {
      await harness.close()
    }
  }

  // ── Scopes ───────────────────────────────────────────────────────────────────

  async function testScopesNarrowWhatADeviceSeesAndMayCall(): Promise<void> {
    assert.equal(requiredScopeForTool('backlog.update', true), 'backlog:operate')
    assert.equal(requiredScopeForTool('backlog.list', false), 'backlog:read')
    assert.equal(requiredScopeForTool('terminal.create', true), 'terminal:control')
    assert.equal(requiredScopeForTool('terminal.list', false), 'terminal:observe')
    // The catch-all family, including a tool this mapping has never seen.
    assert.equal(requiredScopeForTool('review_submit_brief', true), 'workspace:operate')
    assert.equal(requiredScopeForTool('some.future.tool', true), 'workspace:operate')
    // The mobile companion lane (tailnet-mobile-transport): the snapshot is a
    // plain read; the command envelope is classified a mutation, so a paired
    // phone needs workspace:operate to drive it and every dispatch is audited.
    assert.equal(
      requiredScopeForTool('workspace.snapshot', isStudioGatewayMutation('workspace.snapshot')),
      'workspace:read',
    )
    // checkout-and-branch-on-remote-create: the checkout facts are a plain
    // read; minting the worktree stays agent.launch's, on workspace:operate.
    assert.equal(
      requiredScopeForTool('workspace.checkout', isStudioGatewayMutation('workspace.checkout')),
      'workspace:read',
    )
    assert.equal(requiredScopeForTool('agent.launch', isStudioGatewayMutation('agent.launch')), 'workspace:operate')
    assert.equal(
      requiredScopeForTool('workspace.mobile_command', isStudioGatewayMutation('workspace.mobile_command')),
      'workspace:operate',
    )

    const harness = await startHarness()
    try {
      // Read-only on the backlog, nothing else.
      const device = await pairDevice(harness, { scopes: ['backlog:read'] })
      const listed = await call(harness.port, 'POST', TAILNET_MCP_PATH, {
        token: device.deviceToken,
        body: rpc(1, 'tools/list'),
      })
      assert.deepEqual(
        (listed.body as { result: { tools: Array<{ name: string }> } }).result.tools.map((tool) => tool.name),
        ['backlog.list'],
      )

      const refused = await call(harness.port, 'POST', TAILNET_MCP_PATH, {
        token: device.deviceToken,
        body: rpc(2, 'tools/call', { name: 'backlog.update', arguments: {} }),
      })
      assert.equal(refused.status, 200, 'an authorization refusal is a tool result, not a transport failure')
      const result = (refused.body as { result: { isError: boolean; structuredContent: { error: { code: string } } } })
        .result
      assert.equal(result.isError, true)
      assert.equal(result.structuredContent.error.code, 'tailnet_scope_required')
      assert.deepEqual(harness.calls, [], 'the refused handler never ran')

      // A refused MUTATION is still audited: an attempt is a security event.
      const audited = harness.auditRecords()
      assert.equal(audited.length, 1)
      assert.equal(audited[0].tool, 'backlog.update')
      assert.equal(audited[0].outcome, 'failure')
      assert.equal(audited[0].errorCode, 'tailnet_scope_required')

      // checkout-and-branch-on-remote-create: a worktree minted for a remote
      // chat rides agent.launch, a mutation — so it lands in the audit with the
      // device that asked, granted or refused. The read beside it does not.
      const worktreeMaker = await pairDevice(harness, {
        scopes: ['workspace:operate', 'terminal:control'],
        name: 'air',
      })
      const minted = await call(harness.port, 'POST', TAILNET_MCP_PATH, {
        token: worktreeMaker.deviceToken,
        body: rpc(3, 'tools/call', {
          name: 'agent.launch',
          arguments: { workspaceId: 'w1', worktree: { baseRef: 'main' } },
        }),
      })
      assert.equal(minted.status, 200)
      await call(harness.port, 'POST', TAILNET_MCP_PATH, {
        token: worktreeMaker.deviceToken,
        body: rpc(4, 'tools/call', { name: 'workspace.checkout', arguments: { workspaceId: 'w1' } }),
      })
      const terminalsOnly = await pairDevice(harness, { scopes: ['terminal:control'], name: 'kiosk' })
      await call(harness.port, 'POST', TAILNET_MCP_PATH, {
        token: terminalsOnly.deviceToken,
        body: rpc(5, 'tools/call', { name: 'agent.launch', arguments: { workspaceId: 'w1', worktree: {} } }),
      })
      const worktreeAudit = harness.auditRecords().filter((record) => record.tool === 'agent.launch')
      assert.equal(worktreeAudit.length, 2, 'the granted and the refused worktree create are both audited')
      assert.equal(worktreeAudit[0].outcome, 'success')
      assert.equal(worktreeAudit[0].connection.deviceId, worktreeMaker.deviceId, 'with the device that asked')
      assert.equal(worktreeAudit[0].connection.deviceName, 'air')
      assert.equal(worktreeAudit[1].outcome, 'failure')
      assert.equal(worktreeAudit[1].errorCode, 'tailnet_scope_required')
      assert.equal(worktreeAudit[1].connection.deviceId, terminalsOnly.deviceId)
      assert.ok(
        !harness.auditRecords().some((record) => record.tool === 'workspace.checkout'),
        'the checkout read is not a mutation and is not audited',
      )

      // operate implies read within its family, and never across families.
      const operator = await pairDevice(harness, { scopes: ['backlog:operate'], name: 'operator' })
      const operatorTools = await call(harness.port, 'POST', TAILNET_MCP_PATH, {
        token: operator.deviceToken,
        body: rpc(3, 'tools/list'),
      })
      assert.deepEqual(
        (operatorTools.body as { result: { tools: Array<{ name: string }> } }).result.tools
          .map((tool) => tool.name)
          .sort(),
        ['backlog.list', 'backlog.update'],
      )
    } finally {
      await harness.close()
    }
  }

  // ── The tailnet.* configuration family ───────────────────────────────────────

  async function testTailnetConfigurationToolsAreNeverServedOverTheTailnet(): Promise<void> {
    // The prefix rule is the guarantee, so pin that the whole family answers to
    // it — a tool added later that did not would be served remotely by default.
    const names = createTailnetTools({ resolveTailnet: () => null }).map((tool) => tool.name)
    assert.ok(names.length > 0)
    assert.deepEqual(
      names.filter((name) => !isLocalOnlyGatewayTool(name)),
      [],
    )
    assert.equal(isLocalOnlyGatewayTool('backlog.list'), false)

    const calls: string[] = []
    const stubs: McpToolRegistration[] = names.map((name) => ({
      name,
      description: `Test tool ${name}`,
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        calls.push(name)
        return toolSuccess({ ok: true })
      },
    }))
    const harness = await startHarness({ tools: [...testTools(calls), ...stubs] })
    try {
      // Every scope the vocabulary has, including the terminal tier — this is the
      // most-trusted device that can exist, and it still may not see the family.
      const device = await pairDevice(harness, { scopes: [...TAILNET_SCOPES] })
      const listed = await call(harness.port, 'POST', TAILNET_MCP_PATH, {
        token: device.deviceToken,
        body: rpc(1, 'tools/list'),
      })
      const served = (listed.body as { result: { tools: Array<{ name: string }> } }).result.tools.map(
        (tool) => tool.name,
      )
      assert.deepEqual(
        served.filter((name) => name.startsWith('tailnet.')),
        [],
        'the family is invisible to a paired device',
      )
      assert.ok(served.includes('backlog.update'), 'everything else a full grant covers is still served')

      const refused = await call(harness.port, 'POST', TAILNET_MCP_PATH, {
        token: device.deviceToken,
        body: rpc(2, 'tools/call', { name: 'tailnet.offer_pairing', arguments: {} }),
      })
      assert.equal(refused.status, 200, 'a local-only refusal is a tool result, not a transport failure')
      const result = (refused.body as { result: { isError: boolean; structuredContent: { error: { code: string } } } })
        .result
      assert.equal(result.isError, true)
      assert.equal(result.structuredContent.error.code, 'tailnet_local_only')
      assert.deepEqual(calls, [], 'the refused handler never ran, so no code was minted')

      // A device manufacturing another grant is the attempt this rule exists to
      // stop; it is audited with the device that made it, like any mutation.
      const audited = harness.auditRecords()
      assert.equal(audited.length, 1)
      assert.equal(audited[0].tool, 'tailnet.offer_pairing')
      assert.equal(audited[0].outcome, 'failure')
      assert.equal(audited[0].errorCode, 'tailnet_local_only')
    } finally {
      await harness.close()
    }
  }

  async function testTailnetToolsRefuseRatherThanMintACodeThatPointsAtNothing(): Promise<void> {
    const base: TailnetRemoteStatus = {
      enabled: false,
      running: false,
      endpoint: null,
      port: 8787,
      tailnetAddress: null,
      lastError: null,
      notifications: true,
      devices: [],
      pairing: null,
      pairRequests: [],
    }
    let status: TailnetRemoteStatus = { ...base }
    const minted: Array<{ scopes?: unknown }> = []
    const front: TailnetToolsFrontDoor = {
      getTailnetStatus: () => status,
      setTailnetEnabled: async (enabled) => {
        status = {
          ...status,
          enabled,
          running: false,
          lastError: enabled ? 'Tailscale is not running on this machine.' : null,
        }
        return status
      },
      offerTailnetPairing: (input) => {
        minted.push(input ?? {})
        return {
          token: 'mcpair_test',
          scopes: [...TAILNET_STRUCTURED_SCOPES],
          expiresAt: '2026-09-09T00:00:00.000Z',
          pairingUrl: 'multicode-tailnet://pair?endpoint=100.64.0.1%3A8787&token=mcpair_test',
        }
      },
      // This test is about refusing to mint a code that points at nothing, not
      // about approvals — the two request handlers exist to satisfy the front-door
      // contract and are never reached here.
      approveTailnetPairRequest: () => ({
        ok: false as const,
        code: 'request_not_found' as const,
        message: 'No such pairing request.',
        status,
      }),
      denyTailnetPairRequest: () => status,
      cancelTailnetPairing: () => status,
      revokeTailnetDevice: () => status,
      listTailnetPeers: async () => ({
        tailscaleAvailable: false,
        unavailableReason: 'The Tailscale CLI was not found on this machine.',
        probedPort: 8787,
        peers: [],
      }),
    }
    const tools = new Map(createTailnetTools({ resolveTailnet: () => front }).map((tool) => [tool.name, tool]))
    const run = (name: string, args: Record<string, unknown> = {}): Promise<McpToolResult> => {
      const tool = tools.get(name)
      assert.ok(tool, `${name} is registered`)
      return tool.handler(args)
    }
    const errorCode = (result: McpToolResult): string =>
      (result.structuredContent as { error?: { code?: string } } | undefined)?.error?.code ?? ''
    // Tool content is a union of text and image parts (the browser tools return
    // snapshots); every tailnet tool answers in text, so narrow before reading it.
    const firstText = (result: McpToolResult): string => {
      const part = result.content[0]
      assert.ok(part && part.type === 'text', 'the tool answered with a text part')
      return part.text
    }

    // Nothing listening: a code is a URL pointing at a listener, so minting one
    // here would hand back a credential that cannot be redeemed anywhere. Same
    // rule the Settings panel enforces (tailnetPanelModel).
    const offered = await run('tailnet.offer_pairing')
    assert.equal(offered.isError, true)
    assert.equal(errorCode(offered), 'tailnet_not_running')
    assert.deepEqual(minted, [], 'the refusal is before the mint, not a discarded code')

    // Enabling with no Tailscale is a failed request, not a partial success: the
    // caller must not go on believing there is something to pair against.
    const enabled = await run('tailnet.set_enabled', { enabled: true })
    assert.equal(enabled.isError, true)
    assert.equal(errorCode(enabled), 'tailnet_listener_not_running')
    assert.match(firstText(enabled), /Tailscale is not running/)
    assert.equal(status.enabled, true, 'the setting still persisted, and the message says so')

    assert.equal(errorCode(await run('tailnet.set_enabled', { enabled: 'yes' })), 'invalid_enabled')

    status = { ...status, running: true, endpoint: '100.64.0.1:8787', tailnetAddress: '100.64.0.1', lastError: null }

    // A misspelled scope is refused with the vocabulary rather than silently
    // falling back to the default grant, which is what normalization would do.
    const badScopes = await run('tailnet.offer_pairing', { scopes: ['backlog:read', 'terminal:full'] })
    assert.equal(errorCode(badScopes), 'invalid_scopes')
    assert.match(firstText(badScopes), /terminal:full/)
    assert.match(firstText(badScopes), /terminal:control/)
    assert.deepEqual(minted, [])

    const ok = await run('tailnet.offer_pairing', { scopes: ['backlog:read'] })
    assert.notEqual(ok.isError, true)
    assert.deepEqual(minted, [{ scopes: ['backlog:read'], origin: { kind: 'agent', by: null } }])
    const pairing = (ok.structuredContent as { pairing: { token: string; pairingUrl: string } }).pairing
    assert.equal(pairing.token, 'mcpair_test')
    assert.match(pairing.pairingUrl, /^multicode-tailnet:\/\/pair\?/)

    // Revoking an id nobody is paired under is reported, not absorbed: the store
    // is idempotent, so a silent success would read as "that device is gone".
    assert.equal(errorCode(await run('tailnet.revoke_device', { deviceId: 'tnd_nope' })), 'unknown_device')
    assert.equal(errorCode(await run('tailnet.revoke_device', { deviceId: '  ' })), 'invalid_device_id')

    // Status carries the offer's scopes and expiry, never anything redeemable.
    status = { ...status, pairing: { scopes: ['backlog:read'], expiresAt: '2026-09-09T00:00:00.000Z' } }
    const read = await run('tailnet.status')
    assert.notEqual(read.isError, true)
    assert.ok(!firstText(read).includes('mcpair_'), 'no pairing code is re-readable from status')

    // Before the service exists the family answers rather than throwing.
    const early = createTailnetTools({ resolveTailnet: () => null })
    assert.equal(errorCode(await early[0].handler({})), 'tailnet_unavailable')
  }

  // ── Audit ────────────────────────────────────────────────────────────────────

  async function testRemoteMutationsAreAuditedWithDeviceAndPeerIdentity(): Promise<void> {
    const harness = await startHarness({ peerNode: 'mac-mini.tail1234.ts.net' })
    try {
      const device = await pairDevice(harness, { name: 'kitchen-laptop' })
      await call(harness.port, 'POST', TAILNET_MCP_PATH, {
        token: device.deviceToken,
        body: rpc(1, 'tools/call', { name: 'workspace.list', arguments: { workspaceId: 'w1' } }),
      })
      assert.deepEqual(harness.auditRecords(), [], 'reads stay unaudited (existing gateway policy)')

      await call(harness.port, 'POST', TAILNET_MCP_PATH, {
        token: device.deviceToken,
        body: rpc(2, 'tools/call', { name: 'backlog.update', arguments: { workspaceId: 'w1', status: 'completed' } }),
      })
      const records = harness.auditRecords()
      assert.equal(records.length, 1)
      assert.equal(records[0].tool, 'backlog.update')
      assert.equal(records[0].outcome, 'success')
      assert.equal(records[0].connection.kind, 'remote-tailnet')
      assert.equal(records[0].connection.deviceId, device.deviceId)
      assert.equal(records[0].connection.deviceName, 'kitchen-laptop')
      assert.equal(records[0].connection.peerNode, 'mac-mini.tail1234.ts.net')
      assert.equal(records[0].targets.workspaceId, 'w1')

      // The stateless endpoint refuses a connection-scoped declaration outright
      // rather than accepting it and dropping it — otherwise the caller would
      // believe it had declared an identity the audit would never carry.
      const declared = await call(harness.port, 'POST', TAILNET_MCP_PATH, {
        token: device.deviceToken,
        body: { jsonrpc: '2.0', method: 'sprintengine.studio/connect', params: { agentId: 'developer-1' } },
      })
      assert.equal(declared.status, 400)
      assert.equal((declared.body as { error: { code: string } }).error.code, 'stateless_transport')
      assert.match((declared.body as { error: { message: string } }).error.message, /WebSocket/u)
    } finally {
      await harness.close()
    }
  }

  // The change feed (2026-09-05): a paired device opens the events route and
  // hears "changed" once per burst, never per change; a watcher is not a
  // connection; a revocation reaches the feed like every other socket.
  async function testTheChangeFeedPushesOncePerBurstAndFollowsRevocation(): Promise<void> {
    const harness = await startHarness({ changePushIntervalMs: 80 })
    try {
      const device = await pairDevice(harness, { name: 'watcher', scopes: ['workspace:read'] })
      const ticket = (await call(harness.port, 'POST', TAILNET_WS_TICKET_PATH, { token: device.deviceToken })).body as {
        ticket: string
      }
      const feed = await openWebSocket(harness.port, ticket.ticket, { path: TAILNET_EVENTS_PATH })
      assert.ok(
        feed.handshake.startsWith('HTTP/1.1 101'),
        `the events route upgrades: ${feed.handshake.split('\r\n')[0]}`,
      )
      const hello = await feed.nextMessage()
      assert.equal(hello.type, 'hello')
      assert.deepEqual(hello.revisions, { terminals: 0, workspaces: 0 })
      assert.equal(harness.server.eventStreamCount(), 1)
      assert.equal(harness.server.streamCount(), 0, 'a watcher is not an RPC connection')

      harness.server.notifyTerminalsChanged()
      assert.deepEqual(await feed.nextMessage(), { type: 'changed', what: 'terminals', revision: 1 })

      // A burst inside the floor is one push per kind, carrying the last revision.
      harness.server.notifyTerminalsChanged()
      harness.server.notifyTerminalsChanged()
      harness.server.notifyWorkspacesChanged()
      const pushed = [await feed.nextMessage(), await feed.nextMessage()]
      assert.deepEqual(pushed.map((frame) => `${frame.what}:${frame.revision}`).sort(), ['terminals:3', 'workspaces:1'])

      assert.equal(harness.devices.revokeDevice(device.deviceId), true)
      assert.equal(await feed.closed, 4401, 'a revocation closes the feed with the revoked code')
      assert.equal(harness.server.eventStreamCount(), 0)
    } finally {
      await harness.close()
    }
  }

  async function testADeclaredIdentityCannotOverwriteTheProvenDeviceIdentity(): Promise<void> {
    const harness = await startHarness({ peerNode: 'mac-mini.tail1234.ts.net' })
    try {
      const device = await pairDevice(harness, { name: 'kitchen-laptop' })
      const ticket = (await call(harness.port, 'POST', TAILNET_WS_TICKET_PATH, { token: device.deviceToken })).body as {
        ticket: string
      }
      const stream = await openWebSocket(harness.port, ticket.ticket)

      // The WebSocket DOES hold connection state, so the declaration is accepted
      // — and this is where the spoof guard has to hold.
      stream.send(
        rpc(1, 'sprintengine.studio/connect', {
          agentId: 'developer-1',
          agentName: 'Trusted Local Agent',
          workspaceId: 'w9',
        }),
      )
      assert.equal((await stream.nextMessage()).id, 1)

      stream.send(rpc(2, 'tools/call', { name: 'backlog.update', arguments: { workspaceId: 'w9' } }))
      assert.equal((await stream.nextMessage()).id, 2)

      const record = harness.auditRecords().at(-1)
      assert.ok(record)
      // The advisory fields it declared are honoured…
      assert.equal(record.connection.workspaceId, 'w9')
      assert.equal(record.connection.agentId, 'developer-1')
      // …but it is still recorded as the remote device it actually is, not as a
      // trusted local Studio agent.
      assert.equal(record.connection.kind, 'remote-tailnet')
      assert.equal(record.connection.deviceId, device.deviceId)
      assert.equal(record.connection.deviceName, 'kitchen-laptop')
      assert.equal(record.connection.peerNode, 'mac-mini.tail1234.ts.net')

      stream.socket.destroy()
    } finally {
      await harness.close()
    }
  }

  async function testPeerIdentityIsNullRatherThanInventedWhenWhoisIsUnavailable(): Promise<void> {
    assert.equal(peerNameFromWhois('{"Node":{"Name":"mac-mini.tail1234.ts.net."}}'), 'mac-mini.tail1234.ts.net')
    assert.equal(peerNameFromWhois('{"UserProfile":{"LoginName":"someone@example.com"}}'), 'someone@example.com')
    assert.equal(peerNameFromWhois('not json'), null)
    assert.equal(peerNameFromWhois('{}'), null)
    assert.equal(normalizeAddress('::ffff:100.101.102.103'), '100.101.102.103')
    assert.equal(normalizeAddress('fd7a:115c:a1e0::1%utun4'), 'fd7a:115c:a1e0::1')

    let whoisCalls = 0
    const resolver = createTailnetPeerResolver({
      runWhois: async () => {
        whoisCalls += 1
        throw new Error('tailscale is not installed')
      },
    })
    assert.equal(await resolver.resolve('100.101.102.103'), null)
    assert.equal(await resolver.resolve('100.101.102.103'), null)
    assert.equal(whoisCalls, 1, 'a failed lookup is cached, so a missing CLI is not spawned per call')

    const harness = await startHarness({ peerNode: null })
    try {
      const device = await pairDevice(harness)
      await call(harness.port, 'POST', TAILNET_MCP_PATH, {
        token: device.deviceToken,
        body: rpc(1, 'tools/call', { name: 'backlog.update', arguments: { workspaceId: 'w1' } }),
      })
      const record = harness.auditRecords()[0]
      assert.equal(record.connection.deviceId, device.deviceId)
      assert.equal(record.connection.peerNode, undefined, 'an unresolved peer is absent, never a placeholder name')
    } finally {
      await harness.close()
    }
  }

  // ── WebSocket streams and revocation ─────────────────────────────────────────

  async function testWebSocketTicketsAreSingleUseAndTokensNeverRideTheUrl(): Promise<void> {
    const harness = await startHarness()
    try {
      const device = await pairDevice(harness)
      // The long-lived token is not a ticket: it cannot be used to upgrade.
      const withToken = await openWebSocket(harness.port, device.deviceToken)
      assert.equal(await withToken.closed, null)
      assert.equal(harness.server.streamCount(), 0)

      const ticketed = await call(harness.port, 'POST', TAILNET_WS_TICKET_PATH, { token: device.deviceToken })
      assert.equal(ticketed.status, 200)
      const ticket = (ticketed.body as { ticket: string }).ticket

      const stream = await openWebSocket(harness.port, ticket)
      stream.send(rpc(1, 'tools/call', { name: 'workspace.list', arguments: { workspaceId: 'ws' } }))
      const answer = await stream.nextMessage()
      assert.equal((answer as { id: number }).id, 1)
      assert.equal(
        (answer as { result: { structuredContent: { workspaceId: string } } }).result.structuredContent.workspaceId,
        'ws',
      )

      // Single use: the same ticket cannot open a second stream.
      const replay = await openWebSocket(harness.port, ticket)
      assert.equal(await replay.closed, null)
      await waitFor(() => harness.server.streamCount() === 1, 'the replayed upgrade to be rejected')

      stream.socket.destroy()
    } finally {
      await harness.close()
    }
  }

  async function testRevocationLandsOnTheNextRequestAndKillsLiveStreams(): Promise<void> {
    const harness = await startHarness()
    try {
      const device = await pairDevice(harness)
      const ticket = (await call(harness.port, 'POST', TAILNET_WS_TICKET_PATH, { token: device.deviceToken })).body as {
        ticket: string
      }
      const stream = await openWebSocket(harness.port, ticket.ticket)
      stream.send(rpc(1, 'ping'))
      assert.equal((await stream.nextMessage()).id, 1)
      await waitFor(() => harness.server.streamCount() === 1, 'the stream to register')

      assert.equal(harness.devices.revokeDevice(device.deviceId), true)

      // The live stream is terminated with the revocation close code…
      assert.equal(await stream.closed, WEBSOCKET_CLOSE_REVOKED)
      await waitFor(() => harness.server.streamCount() === 0, 'the revoked stream to be dropped')

      // …and the next HTTP request is refused.
      const refused = await call(harness.port, 'POST', TAILNET_MCP_PATH, {
        token: device.deviceToken,
        body: rpc(2, 'tools/list'),
      })
      assert.equal(refused.status, 401)

      // A ticket minted before the revoke cannot be spent afterwards.
      const staleTicket = (await call(harness.port, 'POST', TAILNET_WS_TICKET_PATH, { token: device.deviceToken }))
        .status
      assert.equal(staleTicket, 401)
      assert.equal(harness.devices.listDevices().length, 0)
    } finally {
      await harness.close()
    }
  }

  // ── Frame codec ──────────────────────────────────────────────────────────────

  async function testWebSocketCodecRefusesWhatItDoesNotImplement(): Promise<void> {
    const decoder = createWebSocketFrameDecoder()
    const decoded = decoder.push(maskedTextFrame('{"hello":"world"}'))
    assert.equal(decoded.kind, 'frames')
    assert.deepEqual(decoded.kind === 'frames' ? decoded.frames : [], [{ kind: 'text', text: '{"hello":"world"}' }])

    // A message split across TCP chunks is buffered, not dropped.
    const whole = maskedTextFrame('{"split":true}')
    const chunked = createWebSocketFrameDecoder()
    assert.deepEqual(chunked.push(whole.subarray(0, 3)), { kind: 'frames', frames: [] })
    const rest = chunked.push(whole.subarray(3))
    assert.deepEqual(rest.kind === 'frames' ? rest.frames : [], [{ kind: 'text', text: '{"split":true}' }])

    // An unmasked client frame is an RFC 6455 violation the server must fail on.
    const unmasked = createWebSocketFrameDecoder()
    const payload = Buffer.from('hi', 'utf8')
    const bad = unmasked.push(Buffer.concat([Buffer.from([0x81, payload.length]), payload]))
    assert.equal(bad.kind, 'error')
    assert.match(bad.kind === 'error' ? bad.reason : '', /must be masked/u)

    // Fragmentation and binary frames are refused rather than half-handled.
    const fragmented = createWebSocketFrameDecoder()
    const frame = maskedTextFrame('x')
    frame[0] = 0x01 // text, FIN clear
    const fragmentResult = fragmented.push(frame)
    assert.equal(fragmentResult.kind, 'error')
    assert.match(fragmentResult.kind === 'error' ? fragmentResult.reason : '', /Fragmented messages are not supported/u)

    const binary = createWebSocketFrameDecoder()
    const binaryFrame = maskedTextFrame('x')
    binaryFrame[0] = 0x82
    const binaryResult = binary.push(binaryFrame)
    assert.equal(binaryResult.kind, 'error')

    // Over-long frames are refused by declared length, before any allocation.
    const tooBig = createWebSocketFrameDecoder(16)
    const header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 0x80 | 126
    header.writeUInt16BE(4096, 2)
    const oversize = tooBig.push(header)
    assert.equal(oversize.kind, 'error')

    assert.equal(
      computeWebSocketAcceptKey('dGhlIHNhbXBsZSBub25jZQ=='),
      's3pPLMBiTxaQ9kYGzzhZRbK+xOo=',
      'RFC 6455 §1.3 vector',
    )
    assert.ok(encodeTextFrame('a').equals(Buffer.from([0x81, 0x01, 0x61])), 'server frames are unmasked')
  }

  // ── Terminal attach ────────────────────────────────────────────────

  /** Request a ticket and open a terminal socket for one session. */
  async function attachTerminal(harness: Harness, deviceToken: string, sessionId: string): Promise<TestWebSocket> {
    const ticket = await call(harness.port, 'POST', TAILNET_WS_TICKET_PATH, { token: deviceToken })
    assert.equal(ticket.status, 200)
    return openWebSocket(harness.port, (ticket.body as { ticket: string }).ticket, {
      path: TAILNET_TERMINAL_PATH,
      query: { sessionId },
    })
  }

  async function testTerminalAttachReplaysThenStreamsToEveryAttachedViewer(): Promise<void> {
    const harness = await startHarness()
    try {
      const device = await pairDevice(harness, { scopes: ['terminal:control'], name: 'laptop' })
      const first = await attachTerminal(harness, device.deviceToken, 'session_one')

      // Replay first, so the viewer paints the screen before any live byte.
      const replay = await first.nextMessage()
      assert.equal(replay.type, 'replay')
      assert.equal(replay.reason, 'attach')
      assert.equal(replay.data, 'scrollback so far\r\n')

      const header = await first.nextMessage()
      assert.equal(header.type, 'attached')
      assert.equal(header.sessionId, 'session_one')
      assert.equal(header.scope, 'control')

      // A second concurrent viewer sees the same stream.
      const observer = await pairDevice(harness, { scopes: ['terminal:observe'], name: 'phone' })
      const second = await attachTerminal(harness, observer.deviceToken, 'session_one')
      assert.equal((await second.nextMessage()).type, 'replay')
      assert.equal((await second.nextMessage()).scope, 'observe')
      await waitFor(() => harness.server.terminalStreamCount() === 2, 'both terminal streams to register')

      harness.terminals.emit('session_one', 'live output\r\n')
      assert.deepEqual(await first.nextMessage(), { type: 'output', data: 'live output\r\n' })
      assert.deepEqual(await second.nextMessage(), { type: 'output', data: 'live output\r\n' })

      // Control scope types and resizes; both reach the runtime port.
      first.send({ type: 'input', data: 'echo hi\n' })
      await waitFor(() => harness.terminals.writes.length === 1, 'the input frame to reach the terminal')
      assert.deepEqual(harness.terminals.writes[0], { sessionId: 'session_one', data: 'echo hi\n' })
      first.send({ type: 'resize', cols: 200, rows: 60 })
      await waitFor(() => harness.terminals.resizes.length === 1, 'the resize frame to reach the terminal')
      assert.deepEqual(harness.terminals.resizes[0], { sessionId: 'session_one', cols: 200, rows: 60 })

      // A malformed frame is named, not silently dropped.
      first.send({ type: 'nonsense' })
      assert.equal((await first.nextMessage()).code, 'unknown_frame')

      first.socket.destroy()
      second.socket.destroy()
      await waitFor(() => harness.server.terminalStreamCount() === 0, 'closed sockets to be forgotten')
    } finally {
      await harness.close()
    }
  }

  async function testObserveScopedAttachCannotInjectInput(): Promise<void> {
    const harness = await startHarness()
    try {
      const device = await pairDevice(harness, { scopes: ['terminal:observe'], name: 'phone' })
      const stream = await attachTerminal(harness, device.deviceToken, 'session_one')
      assert.equal((await stream.nextMessage()).type, 'replay')
      assert.equal((await stream.nextMessage()).scope, 'observe')

      // Refused at the FRAME: the runtime is never asked, and the client is told
      // why rather than watching its keystrokes vanish.
      stream.send({ type: 'input', data: 'rm -rf /\n' })
      const refusedInput = await stream.nextMessage()
      assert.equal(refusedInput.type, 'error')
      assert.equal(refusedInput.code, 'terminal_control_required')
      stream.send({ type: 'resize', cols: 10, rows: 10 })
      assert.equal((await stream.nextMessage()).code, 'terminal_control_required')

      assert.deepEqual(harness.terminals.writes, [], 'no observe-scoped byte reaches the terminal')
      assert.deepEqual(harness.terminals.resizes, [])

      // Watching still works — the refusal is about input only.
      harness.terminals.emit('session_one', 'still watching\r\n')
      assert.deepEqual(await stream.nextMessage(), { type: 'output', data: 'still watching\r\n' })
      stream.socket.destroy()
    } finally {
      await harness.close()
    }
  }

  async function testTerminalStreamsAreRefusedWithoutAGrantASessionOrARuntime(): Promise<void> {
    const harness = await startHarness()
    try {
      // The structured-command set never carries the terminal tier, so the
      // upgrade is refused BEFORE the 101 — no socket to send input on.
      const structured = await pairDevice(harness, { scopes: [...TAILNET_STRUCTURED_SCOPES], name: 'ops' })
      const refused = await attachTerminal(harness, structured.deviceToken, 'session_one')
      assert.ok(refused.handshake.startsWith('HTTP/1.1 403'), refused.handshake)
      assert.ok(refused.handshake.includes('terminal_scope_required'), refused.handshake)
      assert.equal(harness.server.terminalStreamCount(), 0)

      // No session id is a client error, not a stream that attaches to nothing.
      const watcher = await pairDevice(harness, { scopes: ['terminal:observe'], name: 'phone' })
      const ticket = await call(harness.port, 'POST', TAILNET_WS_TICKET_PATH, { token: watcher.deviceToken })
      const noSession = await openWebSocket(harness.port, (ticket.body as { ticket: string }).ticket, {
        path: TAILNET_TERMINAL_PATH,
      })
      assert.ok(noSession.handshake.startsWith('HTTP/1.1 400'), noSession.handshake)
      assert.ok(noSession.handshake.includes('session_id_required'), noSession.handshake)

      // An unknown session is refused on the open socket, with the code named.
      const ghost = await attachTerminal(harness, watcher.deviceToken, 'session_that_never_existed')
      const answer = await ghost.nextMessage()
      assert.equal(answer.type, 'error')
      assert.equal(answer.code, 'unknown_terminal')
      assert.equal(await ghost.closed, 1000)
      assert.equal(harness.server.terminalStreamCount(), 0)
    } finally {
      await harness.close()
    }

    // A build with terminal streaming unwired says so rather than pretending.
    const unwired = await startHarness({ terminals: null })
    try {
      const device = await pairDevice(unwired, { scopes: ['terminal:control'], name: 'laptop' })
      const stream = await attachTerminal(unwired, device.deviceToken, 'session_one')
      assert.ok(stream.handshake.startsWith('HTTP/1.1 503'), stream.handshake)
      assert.ok(stream.handshake.includes('terminal_streaming_unavailable'), stream.handshake)
    } finally {
      await unwired.close()
    }
  }

  async function testRevocationClosesAnAttachedTerminalImmediately(): Promise<void> {
    const harness = await startHarness()
    try {
      const device = await pairDevice(harness, { scopes: ['terminal:control'], name: 'laptop' })
      const stream = await attachTerminal(harness, device.deviceToken, 'session_one')
      assert.equal((await stream.nextMessage()).type, 'replay')
      assert.equal((await stream.nextMessage()).type, 'attached')
      await waitFor(() => harness.server.terminalStreamCount() === 1, 'the terminal stream to register')

      // Revocation must reach live output — and, for a control-scoped device, a
      // live shell — without waiting for the device's next message.
      harness.devices.revokeDevice(device.deviceId)
      assert.equal(await stream.closed, WEBSOCKET_CLOSE_REVOKED)
      await waitFor(() => harness.server.terminalStreamCount() === 0, 'the revoked stream to be forgotten')
      assert.equal(harness.terminals.attachedCount(), 0, 'revocation detaches the viewer from the runtime')
    } finally {
      await harness.close()
    }
  }

  async function testTerminalToolsSitBehindTheTerminalScope(): Promise<void> {
    assert.equal(requiredScopeForTool('terminal.list', false), 'terminal:observe')
    assert.equal(requiredScopeForTool('terminal.write', true), 'terminal:control')
    // Creating a terminal is a mutation, so the same mapping puts it in the
    // typing half of the tier rather than the watching half.
    assert.equal(requiredScopeForTool('terminal.create', true), 'terminal:control')
    // Control implies observe, and the implication never leaves the tier.
    assert.equal(tailnetScopeGrantsAccess(new Set(['terminal:control']), 'terminal:observe'), true)
    assert.equal(tailnetScopeGrantsAccess(new Set(['terminal:observe']), 'terminal:control'), false)
    assert.equal(tailnetScopeGrantsAccess(new Set(['workspace:operate']), 'terminal:observe'), false)
    assert.equal(tailnetScopeGrantsAccess(new Set(['terminal:control']), 'workspace:read'), false)

    const harness = await startHarness()
    try {
      // The structured-command set is the pairing default, and it does NOT show
      // a device the terminals on this machine.
      const structured = await pairDevice(harness, { scopes: [...TAILNET_STRUCTURED_SCOPES], name: 'ops' })
      const structuredTools = await call(harness.port, 'POST', TAILNET_MCP_PATH, {
        token: structured.deviceToken,
        body: rpc(1, 'tools/list'),
      })
      const structuredNames = (structuredTools.body as { result: { tools: Array<{ name: string }> } }).result.tools.map(
        (tool) => tool.name,
      )
      assert.equal(structuredNames.includes('terminal.list'), false)
      // Nor the tool that OPENS one: control is never implied by the structured
      // scopes, however much of the app they otherwise reach (epic decision 4).
      assert.equal(structuredNames.includes('terminal.create'), false)
      assert.equal(tailnetScopeGrantsAccess(new Set(['workspace:operate']), 'terminal:control'), false)

      const refused = await call(harness.port, 'POST', TAILNET_MCP_PATH, {
        token: structured.deviceToken,
        body: rpc(2, 'tools/call', { name: 'terminal.list', arguments: {} }),
      })
      const result = (refused.body as { result: { isError: boolean; structuredContent: { error: { code: string } } } })
        .result
      assert.equal(result.isError, true)
      assert.equal(result.structuredContent.error.code, 'tailnet_scope_required')
      assert.equal(harness.calls.length, 0, 'the refused handler never ran')

      const watcher = await pairDevice(harness, { scopes: ['terminal:observe'], name: 'phone' })
      const watcherTools = await call(harness.port, 'POST', TAILNET_MCP_PATH, {
        token: watcher.deviceToken,
        body: rpc(3, 'tools/list'),
      })
      // A watch-only device is not even shown the tool that opens a terminal.
      assert.deepEqual(
        (watcherTools.body as { result: { tools: Array<{ name: string }> } }).result.tools.map((tool) => tool.name),
        ['terminal.list'],
      )

      // …and calling it anyway is refused, with the attempt audited: a device
      // reaching for a shell it was not granted is a security event, not a typo.
      const auditedBefore = harness.auditRecords().length
      const denied = await call(harness.port, 'POST', TAILNET_MCP_PATH, {
        token: watcher.deviceToken,
        body: rpc(4, 'tools/call', { name: 'terminal.create', arguments: { workspaceId: 'ws-1' } }),
      })
      const deniedResult = (
        denied.body as {
          result: { isError: boolean; structuredContent: { error: { code: string } } }
        }
      ).result
      assert.equal(deniedResult.isError, true)
      assert.equal(deniedResult.structuredContent.error.code, 'tailnet_scope_required')
      assert.equal(harness.calls.includes('terminal.create'), false, 'the refused handler never ran')
      const deniedRecords = harness.auditRecords().slice(auditedBefore)
      assert.equal(deniedRecords.length, 1)
      assert.equal(deniedRecords[0].tool, 'terminal.create')
      assert.equal(deniedRecords[0].errorCode, 'tailnet_scope_required')
      assert.equal(deniedRecords[0].connection.deviceName, 'phone', 'the audit names the device that reached for it')

      // Control is the grant that opens one, and the success is audited with the
      // same device identity — creation is a mutation like any other.
      const driver = await pairDevice(harness, { scopes: ['terminal:control'], name: 'laptop' })
      const created = await call(harness.port, 'POST', TAILNET_MCP_PATH, {
        token: driver.deviceToken,
        body: rpc(5, 'tools/call', { name: 'terminal.create', arguments: { workspaceId: 'ws-1' } }),
      })
      assert.equal((created.body as { result: { isError?: boolean } }).result.isError, undefined)
      assert.equal(harness.calls.includes('terminal.create'), true)
      const createdRecord = harness.auditRecords().at(-1)
      assert.equal(createdRecord?.tool, 'terminal.create')
      assert.equal(createdRecord?.outcome, 'success')
      assert.equal(createdRecord?.connection.deviceName, 'laptop')
    } finally {
      await harness.close()
    }
  }

  // ── Remote terminal create ─────────────────────────────────────────
  //
  // The item's acceptance in one test: from a client that has only a device
  // token, open a terminal on THIS machine, attach to it, type, and see output.
  // The tool under test is the REAL `terminal.create` from the gateway's own tool
  // set — not a stub named after it — so what this proves is the actual round
  // trip a remote client makes. Only the pty is stood in for: `launchAgent`
  // registers a session in the same terminal host the attach route serves, which
  // is exactly the relationship the real runtime has (main mints the session id,
  // then the attach socket resolves that id against the runtime).

  /** The gateway tool set, over a terminal host a launch can register sessions in. */
  function realTerminalTools(input: {
    terminals: StubTerminalHost
    launches: AgentLaunchRequest[]
    /** This machine's agent-spawn preset; a terminal.create with none named takes it. */
    spawnPermissionDefault?: CliPermissionPreset | null
  }): McpToolRegistration[] {
    const workspace = {
      id: 'ws-mini',
      name: 'Mac Mini',
      mode: 'standard',
      folderPath: '/tmp/project',
      agents: {},
    }
    let spawned = 0
    // Only the backends the terminal tools actually reach are supplied. The rest
    // belong to tools this test never calls; a stub for each would be noise, and
    // an unsupplied one throws rather than answering wrongly if that ever changes.
    const backends = {
      getWorkspaceSyncSnapshot: () => ({
        sequence: 1,
        state: {
          workspaces: [workspace],
          activeWorkspaceId: workspace.id,
          primaryWorkspaceWindowId: null,
          workspaceWindows: [],
        },
      }),
      listTerminalSessions: () => input.terminals.listSessions(),
      getAgentSpawnPermissionDefault: () => input.spawnPermissionDefault ?? 'auto',
      launchAgent: async (request: AgentLaunchRequest) => {
        input.launches.push(request)
        const sessionId = `spawned-${++spawned}`
        input.terminals.create(sessionId)
        return { ok: true as const, workspaceId: request.workspaceId, agentId: `agent-${spawned}`, sessionId }
      },
    }
    return createAutomationTools(backends as unknown as Parameters<typeof createAutomationTools>[0])
  }

  async function testARemoteClientOpensATerminalHereAttachesAndDrivesIt(): Promise<void> {
    const terminals = createStubTerminalHost()
    const launches: AgentLaunchRequest[] = []
    const harness = await startHarness({ terminals, tools: realTerminalTools({ terminals, launches }) })
    try {
      const laptop = await pairDevice(harness, { scopes: ['terminal:control'], name: 'laptop' })

      // The workspace is named, not identified: a device holding only the
      // terminal scopes cannot call workspace.list, so this is the path it has.
      const created = await call(harness.port, 'POST', TAILNET_MCP_PATH, {
        token: laptop.deviceToken,
        body: rpc(1, 'tools/call', { name: 'terminal.create', arguments: { workspaceName: 'Mac Mini' } }),
      })
      const payload = (
        created.body as {
          result: { isError?: boolean; structuredContent: { sessionId: string; permissionPreset: string } }
        }
      ).result
      assert.equal(payload.isError, undefined, JSON.stringify(payload.structuredContent))
      const sessionId = payload.structuredContent.sessionId
      assert.equal(sessionId, 'spawned-1')
      // This machine's own spawn default, not a preset the remote caller chose.
      assert.equal(payload.structuredContent.permissionPreset, 'auto')
      assert.equal(launches[0].workspaceId, 'ws-mini')

      // …and the id it handed back is attachable, on the same connection's token.
      const stream = await attachTerminal(harness, laptop.deviceToken, sessionId)
      assert.equal((await stream.nextMessage()).type, 'replay', 'a fresh session replays its empty screen first')
      const header = await stream.nextMessage()
      assert.equal(header.type, 'attached')
      assert.equal(header.sessionId, sessionId)
      assert.equal(header.scope, 'control')

      // Type a command, see the output — the round trip the item asks for.
      stream.send({ type: 'input', data: 'echo remote\n' })
      await waitFor(() => terminals.writes.length === 1, 'the typed command to reach the new session')
      assert.deepEqual(terminals.writes[0], { sessionId, data: 'echo remote\n' })
      terminals.emit(sessionId, 'remote\r\n')
      assert.deepEqual(await stream.nextMessage(), { type: 'output', data: 'remote\r\n' })

      // The creation is on the audit trail with the device that made it.
      const record = harness.auditRecords().at(-1)
      assert.equal(record?.tool, 'terminal.create')
      assert.equal(record?.outcome, 'success')
      assert.equal(record?.connection.deviceName, 'laptop')
      assert.equal(record?.connection.kind, 'remote-tailnet')

      // The new session is also in the list every terminal-scoped device reads,
      // so a second client finds it without having been told the id.
      const listed = await call(harness.port, 'POST', TAILNET_MCP_PATH, {
        token: laptop.deviceToken,
        body: rpc(2, 'tools/call', { name: 'terminal.list', arguments: {} }),
      })
      const terminalsListed = (
        listed.body as {
          result: { structuredContent: { terminals: Array<{ sessionId: string }> } }
        }
      ).result.structuredContent.terminals
      assert.equal(
        terminalsListed.some((entry) => entry.sessionId === sessionId),
        true,
      )
    } finally {
      await harness.close()
    }
  }

  async function testEndpointAndPairingUrlFormatting(): Promise<void> {
    assert.equal(formatEndpoint('100.101.102.103', 8471), '100.101.102.103:8471')
    assert.equal(formatEndpoint('fd7a:115c:a1e0::1', 8471), '[fd7a:115c:a1e0::1]:8471')
    const url = pairingUrl('100.101.102.103', 8471, 'mcpair_abc')
    assert.equal(url, 'multicode-tailnet://pair?endpoint=100.101.102.103%3A8471&token=mcpair_abc')
  }

  // ── The stdio bridge in remote mode ────────────────────────────────
  //
  // The bridge is a standalone script, never bundled with the app, so these tests
  // spawn it as a real child process against the real listener above. Anything
  // less would prove nothing about the thing a person actually runs.

  const BRIDGE_SCRIPT = join(process.cwd(), 'resources', 'automation', 'mcp-stdio-bridge.mjs')

  type BridgeRun = { code: number | null; stdout: string; stderr: string }

  /** Run the bridge to completion (the `pair` flow, or a refusal). */
  function runBridge(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<BridgeRun> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [BRIDGE_SCRIPT, ...args], { stdio: 'pipe', env })
      const stdout: string[] = []
      const stderr: string[] = []
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => stdout.push(chunk))
      child.stderr.on('data', (chunk: string) => stderr.push(chunk))
      child.once('error', reject)
      child.once('exit', (code) => resolve({ code, stdout: stdout.join(''), stderr: stderr.join('') }))
    })
  }

  type BridgeSession = {
    child: ChildProcessWithoutNullStreams
    send(payload: Record<string, unknown>): void
    responses: Array<Record<string, unknown>>
    stderr(): string
    exited: Promise<BridgeRun>
  }

  /** Start the bridge as an MCP server on stdio and collect its NDJSON answers. */
  function startBridgeSession(args: string[]): BridgeSession {
    const child = spawn(process.execPath, [BRIDGE_SCRIPT, ...args], { stdio: 'pipe', env: process.env })
    const responses: Array<Record<string, unknown>> = []
    const stderrChunks: string[] = []
    let buffer = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line) responses.push(JSON.parse(line) as Record<string, unknown>)
        newline = buffer.indexOf('\n')
      }
    })
    child.stderr.on('data', (chunk: string) => stderrChunks.push(chunk))
    const exited = new Promise<BridgeRun>((resolve) => {
      child.once('exit', (code) => resolve({ code, stdout: '', stderr: stderrChunks.join('') }))
    })
    return {
      child,
      send: (payload) => child.stdin.write(`${JSON.stringify(payload)}\n`),
      responses,
      stderr: () => stderrChunks.join(''),
      exited,
    }
  }

  /** The command line the OS shows for a pid — what `ps` would leak to any user on the box. */
  function osVisibleCommandLine(pid: number): string | null {
    if (process.platform === 'win32') return null
    try {
      return execFileSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8' })
    } catch {
      return null
    }
  }

  async function pairViaBridge(
    harness: Harness,
    tokenFilePath: string,
  ): Promise<{ run: BridgeRun; deviceToken: string }> {
    const offer = harness.devices.offerPairing({ scopes: [...TAILNET_STRUCTURED_SCOPES] })
    const run = await runBridge([
      'pair',
      '--pairing-url',
      pairingUrl('127.0.0.1', harness.port, offer.token),
      '--token-file',
      tokenFilePath,
      '--device-name',
      'test-laptop',
    ])
    assert.equal(run.code, 0, `bridge pairing exits 0 (stderr: ${run.stderr})`)
    const stored = JSON.parse(readFileSync(tokenFilePath, 'utf8')) as { deviceToken: string; endpoint: string }
    return { run, deviceToken: stored.deviceToken }
  }

  async function testTheBridgePairsThenDrivesTheGatewayFromAnotherMachine(): Promise<void> {
    const harness = await startHarness({ peerNode: 'laptop.tailnet.ts.net' })
    const clientDir = mkdtempSync(join(tmpdir(), 'multicode-bridge-client-'))
    const tokenFilePath = join(clientDir, 'nested', 'mac-mini.json')
    try {
      const { run, deviceToken } = await pairViaBridge(harness, tokenFilePath)

      // Pairing landed on the desktop, and the credential landed on the client
      // with the endpoint it belongs to — so the serve command needs no --remote.
      const devices = harness.devices.listDevices()
      assert.equal(devices.length, 1, 'pairing through the bridge creates exactly one device')
      assert.equal(devices[0].name, 'test-laptop')
      const stored = JSON.parse(readFileSync(tokenFilePath, 'utf8')) as { endpoint: string; scopes: string[] }
      assert.equal(stored.endpoint, `127.0.0.1:${harness.port}`)
      assert.deepEqual(stored.scopes, [...TAILNET_STRUCTURED_SCOPES])
      assert.ok(!run.stdout.includes(deviceToken), 'the pair flow never prints the device token it stored')
      if (process.platform !== 'win32') {
        assert.equal(statSync(tokenFilePath).mode & 0o777, 0o600, 'the stored device token is owner-only')
      }

      const session = startBridgeSession(['--token-file', tokenFilePath])
      try {
        session.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
        session.send(rpc(2, 'tools/list'))
        session.send(rpc(3, 'tools/call', { name: 'backlog.list', arguments: {} }))
        session.send(rpc(4, 'tools/call', { name: 'backlog.update', arguments: { itemId: 'MC-1' } }))
        await waitFor(() => session.responses.length >= 4, 'four bridge responses')

        const byId = new Map(session.responses.map((response) => [response.id, response]))
        const init = byId.get(1) as { result: { serverInfo: { name: string; version: string } } }
        assert.equal(init.result.serverInfo.name, 'sprintengine-studio')
        assert.equal(init.result.serverInfo.version, '9.9.9')
        const listed = byId.get(2) as { result: { tools: Array<{ name: string }> } }
        assert.deepEqual(
          listed.result.tools.map((tool) => tool.name).sort(),
          ['agent.launch', 'backlog.list', 'backlog.update', 'workspace.checkout', 'workspace.list'],
          'the remote client sees the same tool surface a local one does',
        )
        const read = byId.get(3) as { result: { structuredContent: { tool: string } } }
        assert.equal(read.result.structuredContent.tool, 'backlog.list')
        const mutation = byId.get(4) as { result: { structuredContent: { tool: string } } }
        assert.equal(mutation.result.structuredContent.tool, 'backlog.update')

        // The mutation is audited with the transport-proven device identity.
        await waitFor(() => harness.auditRecords().length >= 1, 'the remote mutation to be audited')
        const audited = harness.auditRecords()
        assert.equal(audited.length, 1, 'the read is not audited; the mutation is')
        assert.equal(audited[0].tool, 'backlog.update')
        const connection = audited[0].connection as Record<string, unknown>
        assert.equal(connection.kind, 'remote-tailnet')
        assert.equal(connection.deviceId, devices[0].id)
        assert.equal(connection.deviceName, 'test-laptop')
        assert.equal(connection.peerNode, 'laptop.tailnet.ts.net')

        // The token is a file read, never an argument and never a log line.
        const commandLine = osVisibleCommandLine(session.child.pid ?? 0)
        if (commandLine !== null) {
          assert.ok(commandLine.includes('mcp-stdio-bridge.mjs'), 'ps found the bridge process')
          assert.ok(!commandLine.includes(deviceToken), 'the device token never reaches the OS-visible command line')
        }
        assert.ok(!session.stderr().includes(deviceToken), 'the device token never reaches stderr')
      } finally {
        session.child.stdin.end()
      }
      const exit = await session.exited
      assert.equal(exit.code, 0, `closing stdin ends the remote session cleanly (stderr: ${exit.stderr})`)
    } finally {
      rmSync(clientDir, { recursive: true, force: true })
      await harness.close()
    }
  }

  async function testTheBridgeFailsCleanlyWhenTheDeviceIsRevoked(): Promise<void> {
    const harness = await startHarness()
    const clientDir = mkdtempSync(join(tmpdir(), 'multicode-bridge-revoke-'))
    const tokenFilePath = join(clientDir, 'mac-mini.json')
    try {
      const { deviceToken } = await pairViaBridge(harness, tokenFilePath)
      const deviceId = harness.devices.listDevices()[0].id

      // Revoked mid-session: the live stream must end, with a message that says why.
      const session = startBridgeSession(['--token-file', tokenFilePath])
      session.send(rpc(1, 'tools/call', { name: 'backlog.list', arguments: {} }))
      await waitFor(() => session.responses.length >= 1, 'the first remote answer')
      harness.devices.revokeDevice(deviceId)
      const midSession = await session.exited
      assert.equal(midSession.code, 1, 'a revoked device is a failure, not a clean shutdown')
      assert.match(midSession.stderr, /revoked/i)
      assert.ok(!midSession.stderr.includes(deviceToken), 'the failure message never echoes the token')

      // And a session started with the same now-dead token never opens at all.
      const afterwards = await runBridge(['--token-file', tokenFilePath])
      assert.equal(afterwards.code, 1)
      assert.match(afterwards.stderr, /rejected this device token/)
      assert.match(afterwards.stderr, /pair again/i)
      assert.ok(!afterwards.stderr.includes(deviceToken))
    } finally {
      rmSync(clientDir, { recursive: true, force: true })
      await harness.close()
    }
  }

  async function testTheBridgeRefusesIncompleteOrConflictingRemoteInvocations(): Promise<void> {
    const harness = await startHarness()
    const clientDir = mkdtempSync(join(tmpdir(), 'multicode-bridge-args-'))
    const tokenFilePath = join(clientDir, 'device.json')
    try {
      // An endpoint with no credential: an explicit refusal naming both ways to
      // supply one, never an unauthenticated attempt.
      const noToken = await runBridge(['--remote', `127.0.0.1:${harness.port}`])
      assert.equal(noToken.code, 1)
      assert.match(noToken.stderr, /needs a device token/)
      assert.match(noToken.stderr, /never accepted as a command-line argument/)

      // A token file that was never written.
      const missingFile = await runBridge(['--token-file', tokenFilePath])
      assert.equal(missingFile.code, 1)
      assert.match(missingFile.stderr, /Could not read the device token file/)

      // Local and remote mode are different transports, not a preference order.
      await pairViaBridge(harness, tokenFilePath)
      const conflicting = await runBridge(['--info-path', join(clientDir, 'info.json'), '--token-file', tokenFilePath])
      assert.equal(conflicting.code, 1)
      assert.match(conflicting.stderr, /pass one/)

      // A flag belonging to the other command is refused, never dropped.
      const pairFlagWhileServing = await runBridge(['--token-file', tokenFilePath, '--device-name', 'laptop'])
      assert.equal(pairFlagWhileServing.code, 1)
      assert.match(pairFlagWhileServing.stderr, /--device-name does not apply/)

      // A pairing link that is not one.
      const badUrl = await runBridge([
        'pair',
        '--pairing-url',
        'https://example.invalid/pair',
        '--token-file',
        tokenFilePath,
      ])
      assert.equal(badUrl.code, 1)
      assert.match(badUrl.stderr, /multicode-tailnet:/)
    } finally {
      rmSync(clientDir, { recursive: true, force: true })
      await harness.close()
    }
  }

  // ── The upload route ─────────────────────────────────────────────────────────
  //
  // The pure guard has its own tests above. These drive the ROUTE, which until
  // 2026-09-07 had none — which is how `taken: new Set()` survived: the collision
  // helper was correct and tested, and its only caller could never reach it.

  async function testAPairedDeviceUploadsIntoTheThreadsFolderAndGetsThePathBack(): Promise<void> {
    const projectDir = mkdtempSync(join(tmpdir(), 'multicode-upload-'))
    const harness = await startHarness({ terminalCwd: projectDir })
    try {
      const device = await pairDevice(harness, { scopes: ['terminal:control'], name: 'phone' })
      const bytes = Buffer.from('a screenshot, near enough', 'utf8')
      const answer = await callRaw(harness.port, uploadPath('session_one', 'shot.png'), {
        token: device.deviceToken,
        body: bytes,
      })

      assert.equal(answer.status, 200)
      const body = answer.body as { path: string; bytes: number }
      assert.equal(body.bytes, bytes.length)
      assert.equal(body.path, join(projectDir, '.sprintengine', 'uploads', 'session_one', 'shot.png'))
      assert.deepEqual(readFileSync(body.path), bytes, 'the bytes on disk are the bytes that were sent')

      // The folder ignores itself, so a phone never adds untracked files to
      // someone's `git status`.
      const ignore = join(projectDir, '.sprintengine', 'uploads', 'session_one', '.gitignore')
      assert.equal(readFileSync(ignore, 'utf8'), '*\n')
    } finally {
      await harness.close()
      rmSync(projectDir, { recursive: true, force: true })
    }
  }

  async function testASecondFileOfTheSameNameIsSuffixedRatherThanRefused(): Promise<void> {
    const projectDir = mkdtempSync(join(tmpdir(), 'multicode-upload-'))
    const harness = await startHarness({ terminalCwd: projectDir })
    try {
      const device = await pairDevice(harness, { scopes: ['terminal:control'], name: 'phone' })
      const send = (payload: string) =>
        callRaw(harness.port, uploadPath('session_one', 'shot.png'), {
          token: device.deviceToken,
          body: Buffer.from(payload, 'utf8'),
        })

      const first = await send('one')
      assert.equal(first.status, 200)
      // Two photos from a camera roll carry the same name far more often than
      // not. Before the fix this met the sink's exclusive create and came back
      // as an unexplained 500.
      const second = await send('two')
      assert.equal(second.status, 200, JSON.stringify(second.body))
      const secondPath = (second.body as { path: string }).path
      assert.equal(secondPath, join(projectDir, '.sprintengine', 'uploads', 'session_one', 'shot (2).png'))
      assert.equal(readFileSync((first.body as { path: string }).path, 'utf8'), 'one', 'the first upload survives')
      assert.equal(readFileSync(secondPath, 'utf8'), 'two')

      const third = await send('three')
      assert.equal((third.body as { path: string }).path.endsWith('shot (3).png'), true)
    } finally {
      await harness.close()
      rmSync(projectDir, { recursive: true, force: true })
    }
  }

  async function testAnUploadedNameCannotEscapeTheThreadsFolderOverTheWire(): Promise<void> {
    const projectDir = mkdtempSync(join(tmpdir(), 'multicode-upload-'))
    const harness = await startHarness({ terminalCwd: projectDir })
    try {
      const device = await pairDevice(harness, { scopes: ['terminal:control'], name: 'phone' })
      for (const name of ['../../escaped.txt', '..\\..\\escaped.txt', '/etc/passwd', '..']) {
        const answer = await callRaw(harness.port, uploadPath('session_one', name), {
          token: device.deviceToken,
          body: Buffer.from('nope', 'utf8'),
        })
        assert.equal(answer.status, 200, `${name} was not handled`)
        const written = (answer.body as { path: string }).path
        const inside = join(projectDir, '.sprintengine', 'uploads', 'session_one')
        assert.ok(written.startsWith(`${inside}/`), `${name} landed at ${written}`)
      }
      assert.equal(existsSync(join(projectDir, 'escaped.txt')), false)

      // A forged session id is a path segment like any other, and is sanitised
      // the same way rather than trusted because it came from an authenticated
      // device.
      const forged = await callRaw(harness.port, uploadPath('../../..', 'shot.png'), {
        token: device.deviceToken,
        body: Buffer.from('nope', 'utf8'),
      })
      assert.equal(forged.status, 404, 'no session has that id, so there is nowhere to put it')
    } finally {
      await harness.close()
      rmSync(projectDir, { recursive: true, force: true })
    }
  }

  async function testUploadsSitBehindTheControlScopeAndAKnownSession(): Promise<void> {
    const projectDir = mkdtempSync(join(tmpdir(), 'multicode-upload-'))
    const harness = await startHarness({ terminalCwd: projectDir })
    try {
      const watcher = await pairDevice(harness, { scopes: ['terminal:observe'], name: 'watcher' })
      const refused = await callRaw(harness.port, uploadPath('session_one', 'shot.png'), {
        token: watcher.deviceToken,
        body: Buffer.from('nope', 'utf8'),
      })
      assert.equal(refused.status, 403)
      assert.equal((refused.body as { error: { code: string } }).error.code, 'tailnet_scope_required')

      const stranger = await callRaw(harness.port, uploadPath('session_one', 'shot.png'), {
        body: Buffer.from('nope', 'utf8'),
      })
      assert.equal(stranger.status, 401, 'an unpaired client never reaches the route')

      const device = await pairDevice(harness, { scopes: ['terminal:control'], name: 'phone' })
      const unknown = await callRaw(harness.port, uploadPath('session_missing', 'shot.png'), {
        token: device.deviceToken,
        body: Buffer.from('nope', 'utf8'),
      })
      assert.equal(unknown.status, 404)
      assert.equal((unknown.body as { error: { code: string } }).error.code, 'unknown_terminal')

      const nameless = await callRaw(harness.port, `${TAILNET_UPLOAD_PATH}?sessionId=session_one`, {
        token: device.deviceToken,
        body: Buffer.from('nope', 'utf8'),
      })
      assert.equal(nameless.status, 400)
      assert.equal((nameless.body as { error: { code: string } }).error.code, 'invalid_arguments')

      // A browser must not be able to reach this from a page on a tailnet machine.
      const fromBrowser = await callRaw(harness.port, uploadPath('session_one', 'shot.png'), {
        token: device.deviceToken,
        body: Buffer.from('nope', 'utf8'),
        headers: { Origin: 'http://evil.example' },
      })
      assert.equal(fromBrowser.status, 403)
      assert.equal((fromBrowser.body as { error: { code: string } }).error.code, 'origin_not_allowed')
    } finally {
      await harness.close()
      rmSync(projectDir, { recursive: true, force: true })
    }
  }

  async function testAnOversizedUploadIsCutOffAndLeavesNothingBehind(): Promise<void> {
    const projectDir = mkdtempSync(join(tmpdir(), 'multicode-upload-'))
    const harness = await startHarness({ terminalCwd: projectDir })
    try {
      const device = await pairDevice(harness, { scopes: ['terminal:control'], name: 'phone' })

      // Declared over the cap: refused before a byte is read.
      const declared = await callRaw(harness.port, uploadPath('session_one', 'big.bin'), {
        token: device.deviceToken,
        body: Buffer.alloc(26 * 1024 * 1024),
      })
      assert.equal(declared.status, 413)
      const declaredError = (declared.body as { error: { code: string; message: string } }).error
      assert.equal(declaredError.code, 'too_large')
      assert.match(declaredError.message, /25MB/u, 'the phone can only say the real reason if the server names it')

      // Chunked, so `content-length` says nothing: the ceiling is counted as the
      // bytes arrive, and the part-written file is removed — a truncated
      // screenshot in a folder an agent reads is worse than no screenshot.
      const counted = await callRaw(harness.port, uploadPath('session_one', 'sneaky.bin'), {
        token: device.deviceToken,
        body: Buffer.alloc(26 * 1024 * 1024),
        chunked: true,
      })
      assert.equal(counted.status, 413)
      assert.equal((counted.body as { error: { code: string } }).error.code, 'too_large')
      assert.equal(
        existsSync(join(projectDir, '.sprintengine', 'uploads', 'session_one', 'sneaky.bin')),
        false,
        'nothing partial is left where an agent would read it',
      )
    } finally {
      await harness.close()
      rmSync(projectDir, { recursive: true, force: true })
    }
  }

  /**
   * Widening a pairing from this keyboard (remote-settings-rebuild).
   *
   * The one direction the store never had: scopes could be granted at pairing and
   * refreshed from the far end, but never widened here, so a device paired before
   * the terminal tier existed could only be revoked and paired again. The widen
   * must reach disk — a grant that does not survive a restart silently narrows
   * itself — and an id the store does not hold must be an error rather than a
   * quiet no-op, because a surface acting on a row that is gone has to know.
   */
  async function testWideningADevicesScopesPersistsAndAnUnknownIdThrows(): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'multicode-tailnet-scopes-'))
    try {
      const store = createTailnetDeviceStore({ resolveUserDataDir: () => dir })
      const minted = store.mintDevice({
        name: 'mac-mini',
        scopes: [...TAILNET_STRUCTURED_SCOPES],
        origin: { kind: 'code', by: null },
      })
      assert.deepEqual(minted.device.scopes, [...TAILNET_STRUCTURED_SCOPES])
      assert.equal(minted.device.scopes.includes('terminal:control'), false)

      const widened = store.updateDeviceScopes(minted.device.id, [...TAILNET_SCOPES])
      assert.deepEqual(widened.scopes, [...TAILNET_SCOPES])
      assert.equal(widened.scopes.length, 6)
      assert.deepEqual(store.listDevices()[0]?.scopes, [...TAILNET_SCOPES])

      // A second store over the same directory is what the next launch sees.
      const reloaded = createTailnetDeviceStore({ resolveUserDataDir: () => dir })
      assert.deepEqual(reloaded.listDevices()[0]?.scopes, [...TAILNET_SCOPES])

      // It replaces rather than merges, so the same call takes access away — and
      // normalises, so a duplicate or a scope outside the vocabulary is dropped
      // rather than stored.
      const narrowed = reloaded.updateDeviceScopes(minted.device.id, [
        'workspace:read',
        'workspace:read',
        'not:a:scope',
      ])
      assert.deepEqual(narrowed.scopes, ['workspace:read'])
      assert.deepEqual(createTailnetDeviceStore({ resolveUserDataDir: () => dir }).listDevices()[0]?.scopes, [
        'workspace:read',
      ])

      assert.throws(() => reloaded.updateDeviceScopes('tnd_never_existed', [...TAILNET_SCOPES]), /tnd_never_existed/)
      // And the throw changed nothing.
      assert.equal(reloaded.listDevices().length, 1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  const tests = [
    testBindAddressAllowsOnlyTailnetOrLoopback,
    testDisabledMeansNoListeningTcpSocket,
    testEnabledWithoutATailnetRefusesInsteadOfBindingAnythingElse,
    testUploadDestinationsCannotEscapeTheThreadsFolder,
    testUploadNamesAreLeavesAndNeverOverwrite,
    testTheListenerBindsWhenTailscaleComesUpAfterTheApp,
    testTheListenerStandsDownWhenTailscaleGoesAway,
    testTheInterfaceWatchStopsWhenTheListenerIsTurnedOff,
    testUnpairedClientsGet401AndPairedClientsDriveTheGateway,
    testBrowserOriginatedRequestsAreRefused,
    testOversizedAndMalformedBodiesAreRefusedExplicitly,
    testHealthEndpointLeaksNothingBeyondProductAndProtocol,
    testScopesNarrowWhatADeviceSeesAndMayCall,
    testTailnetConfigurationToolsAreNeverServedOverTheTailnet,
    testTailnetToolsRefuseRatherThanMintACodeThatPointsAtNothing,
    testRemoteMutationsAreAuditedWithDeviceAndPeerIdentity,
    testADeclaredIdentityCannotOverwriteTheProvenDeviceIdentity,
    testTheChangeFeedPushesOncePerBurstAndFollowsRevocation,
    testPeerIdentityIsNullRatherThanInventedWhenWhoisIsUnavailable,
    testWebSocketTicketsAreSingleUseAndTokensNeverRideTheUrl,
    testRevocationLandsOnTheNextRequestAndKillsLiveStreams,
    testWebSocketCodecRefusesWhatItDoesNotImplement,
    testTerminalAttachReplaysThenStreamsToEveryAttachedViewer,
    testObserveScopedAttachCannotInjectInput,
    testTerminalStreamsAreRefusedWithoutAGrantASessionOrARuntime,
    testRevocationClosesAnAttachedTerminalImmediately,
    testTerminalToolsSitBehindTheTerminalScope,
    testAPairedDeviceUploadsIntoTheThreadsFolderAndGetsThePathBack,
    testASecondFileOfTheSameNameIsSuffixedRatherThanRefused,
    testAnUploadedNameCannotEscapeTheThreadsFolderOverTheWire,
    testUploadsSitBehindTheControlScopeAndAKnownSession,
    testAnOversizedUploadIsCutOffAndLeavesNothingBehind,
    testARemoteClientOpensATerminalHereAttachesAndDrivesIt,
    testEndpointAndPairingUrlFormatting,
    testWideningADevicesScopesPersistsAndAnUnknownIdThrows,
    testTheBridgePairsThenDrivesTheGatewayFromAnotherMachine,
    testTheBridgeFailsCleanlyWhenTheDeviceIsRevoked,
    testTheBridgeRefusesIncompleteOrConflictingRemoteInvocations,
  ]

  async function main(): Promise<void> {
    let failures = 0
    for (const test of tests) {
      try {
        await test()
        console.log(`ok - ${test.name}`)
      } catch (error) {
        failures += 1
        console.error(`not ok - ${test.name}`)
        console.error(error)
      }
    }
    if (failures > 0) {
      console.error(`\n${failures} test(s) failed`)
      process.exit(1)
    }
    console.log('tailnet.test.ts: ok')
  }

  const suiteRun = main()

  await suiteRun
})
