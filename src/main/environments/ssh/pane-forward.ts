import { randomBytes, timingSafeEqual } from 'node:crypto'
import { connect as connectTcp, createServer, isIP, type Server, type Socket } from 'node:net'
import type { Duplex } from 'node:stream'

import type { SshPaneTraffic } from '../../../shared/ssh-environments'

// The browser pane's way to an SSH machine's network (phase 8 spec, 6.8;
// decisions R75, R76): an HTTP proxy on this computer's loopback that the
// machine's own browser partition is pointed at, and that sends each
// connection through the SSH session's relay as a `tcp` stream, resolved and
// opened on the machine. An agent there that runs a dev server on its
// `localhost:5173` and opens it shows that page in the person's own pane.
//
// Never an unauthenticated port (decision R75, the design's goal 4): every
// request and every CONNECT must carry this forward's own credential, which
// is random per forward and answered for the partition by main through
// Electron's `login` event. Another user of this computer who finds the port
// gets 407 and nothing else. It binds the literal 127.0.0.1 on a port the OS
// picks, and lives only while the machine has a pane tab.
//
// Spoken: CONNECT (HTTPS, and WebSockets, which Chromium tunnels), and
// absolute-form requests for plain HTTP. No SOCKS.

export type PaneForwardDeps = {
  label: string
  /** A TCP connection made on the machine, through the relay. Rejects with `code`. */
  openRemote(host: string, port: number): Promise<Duplex>
  /** Whether the relay is up now. */
  connected(): boolean
  /** Resolves true once the relay is up, false after `ms`. */
  waitConnected(ms: number): Promise<boolean>
  traffic(): SshPaneTraffic
  /** A connection from this computer, for `paneTraffic: 'loopback'`'s other targets. */
  openDirect?(host: string, port: number): Promise<Duplex>
  log?(message: string): void
}

const RECONNECT_WAIT_MS = 10_000
const LOOPBACK_HOST = '127.0.0.1'

/**
 * Whether a target is the machine's own loopback: what `paneTraffic:
 * 'loopback'` sends there. The unspecified address (`0.0.0.0`, `::`) and an
 * IPv4-mapped loopback (`::ffff:127.0.0.1`) count: connecting to either
 * reaches the loopback of whichever computer makes the connection, so sent
 * from here they would reach this computer's own services.
 */
export function isLoopbackTarget(host: string): boolean {
  const bare = host.replace(/^\[(.*)\]$/u, '$1').toLowerCase()
  if (bare === 'localhost' || bare.endsWith('.localhost')) return true
  if (isIP(bare) === 4) return bare.startsWith('127.') || bare.startsWith('0.')
  if (isIP(bare) !== 6) return false
  const words = expandIpv6(bare)
  if (!words) return false
  if (words.slice(0, 7).every((word) => word === 0) && (words[7] === 1 || words[7] === 0)) return true
  // ::ffff:a.b.c.d, which Chromium writes as ::ffff:7f00:1
  const mapped = words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff
  return mapped && (words[6]! >> 8 === 127 || words[6]! >> 8 === 0)
}

/** An IPv6 address as its eight 16-bit words, a dotted IPv4 tail included; null when it is not one. */
function expandIpv6(address: string): number[] | null {
  let text = address.split('%')[0]!
  const dotted = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(text)
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number) as [number, number, number, number]
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const halves = text.split('::')
  if (halves.length > 2) return null
  const parse = (part: string) => (part ? part.split(':').map((word) => Number.parseInt(word, 16)) : [])
  const head = parse(halves[0]!)
  const tail = halves.length === 2 ? parse(halves[1]!) : []
  const fill = 8 - head.length - tail.length
  if (halves.length === 1 ? head.length !== 8 : fill < 0) return null
  const words = [...head, ...Array<number>(halves.length === 2 ? fill : 0).fill(0), ...tail]
  return words.every((word) => Number.isInteger(word) && word >= 0 && word <= 0xffff) ? words : null
}

/** `host:port` from a CONNECT line, IPv6 in brackets; null for anything else. */
export function parseAuthority(authority: string): { host: string; port: number } | null {
  const match = /^(\[[0-9A-Fa-f:.%]+\]|[A-Za-z0-9._-]+):(\d{1,5})$/u.exec(authority)
  if (!match) return null
  const port = Number(match[2])
  if (port < 1 || port > 65_535) return null
  return { host: match[1]!.replace(/^\[(.*)\]$/u, '$1'), port }
}

// A request head is a few kilobytes; one that runs past this is not one.
const MAX_HEAD_BYTES = 64 * 1024
const HEAD_TIMEOUT_MS = 30_000

/** Headers said to the proxy, or about this one connection, never passed on. */
const HOP_BY_HOP = new Set([
  'proxy-authorization',
  'proxy-connection',
  'proxy-authenticate',
  'keep-alive',
  'connection',
])

type RequestHead = { method: string; target: string; version: string; headers: Array<[string, string]>; rest: Buffer }

/** The first request on a connection: its line, its headers, and the bytes after them. */
export function parseRequestHead(buffer: Buffer): RequestHead | 'more' | 'bad' {
  const end = buffer.indexOf('\r\n\r\n')
  if (end === -1) return buffer.length > MAX_HEAD_BYTES ? 'bad' : 'more'
  const lines = buffer.subarray(0, end).toString('latin1').split('\r\n')
  const first = /^([A-Z]+) (\S+) (HTTP\/1\.[01])$/u.exec(lines[0] ?? '')
  if (!first) return 'bad'
  const headers: Array<[string, string]> = []
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(':')
    if (colon <= 0) return 'bad'
    headers.push([line.slice(0, colon).trim(), line.slice(colon + 1).trim()])
  }
  return { method: first[1]!, target: first[2]!, version: first[3]!, headers, rest: buffer.subarray(end + 4) }
}

/** A plain request's body length: its Content-Length, 0 when it has none, null for one framed any other way. */
export function requestBodyLength(head: Pick<RequestHead, 'headers'>): number | null {
  if (head.headers.some(([name]) => name.toLowerCase() === 'transfer-encoding')) return null
  const lengths = head.headers.filter(([name]) => name.toLowerCase() === 'content-length').map(([, value]) => value)
  if (lengths.length === 0) return 0
  if (lengths.length > 1 || !/^\d{1,15}$/u.test(lengths[0]!)) return null
  return Number(lengths[0])
}

const RESPONSE_CONNECTION_HEADERS = new Set(['connection', 'proxy-connection', 'keep-alive'])

/**
 * The first response head in `buffer`, rewritten so Chromium does not keep
 * the connection: its own `Connection` headers dropped, `close` said both
 * ways. A `101` to an upgrade keeps its `Connection: Upgrade`.
 */
export function closingResponseHead(
  buffer: Buffer,
  upgrade: boolean,
): { status: number; head: Buffer; rest: Buffer } | 'more' | 'bad' {
  const end = buffer.indexOf('\r\n\r\n')
  if (end === -1) return buffer.length > MAX_HEAD_BYTES ? 'bad' : 'more'
  const lines = buffer.subarray(0, end).toString('latin1').split('\r\n')
  const status = /^HTTP\/1\.[01] (\d{3})(?: |$)/u.exec(lines[0] ?? '')
  if (!status) return 'bad'
  const code = Number(status[1])
  const keep = code === 101 && upgrade
  const out = [lines[0]!]
  for (const line of lines.slice(1)) {
    const name = line
      .slice(0, Math.max(0, line.indexOf(':')))
      .trim()
      .toLowerCase()
    if (!keep && RESPONSE_CONNECTION_HEADERS.has(name)) continue
    out.push(line)
  }
  if (!keep) out.push('Connection: close', 'Proxy-Connection: close')
  return { status: code, head: Buffer.from(`${out.join('\r\n')}\r\n\r\n`, 'latin1'), rest: buffer.subarray(end + 4) }
}

export class SshPaneForward {
  readonly username = 'studio'
  readonly password = randomBytes(24).toString('base64url')
  private server: Server | null = null
  private boundPort: number | null = null
  private readonly sockets = new Set<Socket | Duplex>()
  private readonly expected: Buffer

  constructor(private readonly deps: PaneForwardDeps) {
    this.expected = Buffer.from(`Basic ${Buffer.from(`${this.username}:${this.password}`).toString('base64')}`)
  }

  get port(): number | null {
    return this.boundPort
  }

  /** Bind 127.0.0.1 on a port the OS picks; the same port for the forward's whole life. */
  async open(): Promise<number> {
    if (this.server && this.boundPort !== null) return this.boundPort
    const server = createServer((socket) => this.accept(socket))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen({ host: LOOPBACK_HOST, port: 0, exclusive: true }, () => {
        server.off('error', reject)
        resolve()
      })
    })
    const address = server.address()
    if (!address || typeof address !== 'object' || address.address !== LOOPBACK_HOST) {
      server.close()
      throw new Error('The pane forward did not bind loopback.')
    }
    this.server = server
    this.boundPort = address.port
    return address.port
  }

  async close(): Promise<void> {
    const server = this.server
    this.server = null
    this.boundPort = null
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  /** Whether a proxy challenge from Chromium is this forward's: the credential is given only for its own port. */
  answers(host: string, port: number): boolean {
    return this.boundPort !== null && host === LOOPBACK_HOST && port === this.boundPort
  }

  private authorized(head: RequestHead): boolean {
    const value = head.headers.find(([name]) => name.toLowerCase() === 'proxy-authorization')?.[1] ?? ''
    const presented = Buffer.from(value)
    return presented.length === this.expected.length && timingSafeEqual(presented, this.expected)
  }

  private realm(): string {
    return `SprintEngine Studio: ${this.deps.label.replace(/["\\\r\n]/gu, '')}`
  }

  /** Where a connection goes: through the machine, or (loopback mode) from here. */
  private async reach(host: string, port: number): Promise<Duplex> {
    const traffic = this.deps.traffic()
    if (traffic === 'off')
      throw Object.assign(new Error(`Browser traffic for ${this.deps.label} is turned off.`), { code: 'refused' })
    if (traffic === 'loopback' && !isLoopbackTarget(host)) {
      const direct = this.deps.openDirect ?? openDirect
      return direct(host, port)
    }
    if (!this.deps.connected() && !(await this.deps.waitConnected(RECONNECT_WAIT_MS)))
      throw Object.assign(new Error(`${this.deps.label} is reconnecting. This tab's network goes through it.`), {
        code: 'reconnecting',
      })
    return this.deps.openRemote(host, port)
  }

  private answer(socket: Socket, status: number, text: string, body = '', extra: string[] = []): void {
    if (socket.destroyed) return
    socket.end(
      [
        `HTTP/1.1 ${status} ${text}`,
        ...extra,
        'Content-Type: text/plain; charset=utf-8',
        `Content-Length: ${Buffer.byteLength(body)}`,
        'Connection: close',
        '',
        body,
      ].join('\r\n'),
    )
  }

  private refuse(socket: Socket, error: unknown): void {
    const code = (error as { code?: unknown } | null)?.code
    const message = error instanceof Error ? error.message : String(error)
    if (code === 'timeout') this.answer(socket, 504, 'Gateway Timeout', message)
    else if (code === 'limit' || code === 'reconnecting') this.answer(socket, 503, 'Service Unavailable', message)
    else this.answer(socket, 502, 'Bad Gateway', message)
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket)
    socket.once('close', () => this.sockets.delete(socket))
    socket.on('error', () => undefined)
    socket.setTimeout(HEAD_TIMEOUT_MS, () => socket.destroy())
    let buffer = Buffer.alloc(0)
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      const head = parseRequestHead(buffer)
      if (head === 'more') return
      socket.off('data', onData)
      socket.pause()
      socket.setTimeout(0)
      if (head === 'bad') {
        this.answer(socket, 400, 'Bad Request', 'That is not an HTTP request.')
        return
      }
      void this.serve(socket, head)
    }
    socket.on('data', onData)
  }

  private async serve(socket: Socket, head: RequestHead): Promise<void> {
    if (!this.authorized(head)) {
      this.answer(socket, 407, 'Proxy Authentication Required', '', [
        `Proxy-Authenticate: Basic realm="${this.realm()}"`,
      ])
      return
    }
    if (head.method === 'CONNECT') {
      const target = parseAuthority(head.target)
      if (!target) {
        this.answer(socket, 400, 'Bad Request', 'Not a host and port.')
        return
      }
      let upstream: Duplex
      try {
        upstream = await this.reach(target.host, target.port)
      } catch (error) {
        this.refuse(socket, error)
        return
      }
      if (socket.destroyed) {
        upstream.destroy()
        return
      }
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.rest.length > 0) upstream.write(head.rest)
      this.pipeBoth(socket, upstream)
      return
    }
    // A plain http:// request in absolute form (and a ws:// upgrade, should
    // one come that way): passed on once, origin-form, without the proxy's
    // headers, on its own connection, which closes after the answer.
    //
    // Once means once. Chromium keeps a proxy connection for its next
    // request to any site, so piping the rest of this one through would hand
    // that next request (its cookies, this forward's credential) to whatever
    // answered this one, and let it answer for another site. So only this
    // request's body is passed on, and every answer tells Chromium the
    // connection closes.
    const upgrade = head.headers.some(([name, value]) => name.toLowerCase() === 'upgrade' && value.length > 0)
    const bodyLength = requestBodyLength(head)
    if (bodyLength === null) {
      this.answer(socket, 501, 'Not Implemented', 'A plain request with a body of unknown length is not passed on.')
      return
    }
    let url: URL
    try {
      url = new URL(head.target)
    } catch {
      this.answer(socket, 400, 'Bad Request', 'A proxied request names its whole URL.')
      return
    }
    if (url.protocol !== 'http:' && url.protocol !== 'ws:') {
      this.answer(socket, 400, 'Bad Request', 'Only http:// goes as a plain request; https:// is tunnelled.')
      return
    }
    let upstream: Duplex
    try {
      upstream = await this.reach(url.hostname, Number(url.port || 80))
    } catch (error) {
      this.refuse(socket, error)
      return
    }
    if (socket.destroyed) {
      upstream.destroy()
      return
    }
    const lines = [`${head.method} ${url.pathname}${url.search} ${head.version}`]
    for (const [name, value] of head.headers) {
      if (HOP_BY_HOP.has(name.toLowerCase())) continue
      lines.push(`${name}: ${value}`)
    }
    lines.push(upgrade ? 'Connection: Upgrade' : 'Connection: close')
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
    this.passOnce(socket, upstream, head.rest, bodyLength, upgrade)
  }

  /**
   * One plain request's body up, and its answer down with every head
   * saying the connection closes. Only a `101` to an upgrade turns the
   * connection into a two-way pipe.
   */
  private passOnce(socket: Socket, upstream: Duplex, rest: Buffer, bodyLength: number, upgrade: boolean): void {
    this.sockets.add(upstream)
    let ended = false
    const end = () => {
      if (ended) return
      ended = true
      socket.destroy()
      upstream.destroy()
      this.sockets.delete(upstream)
    }
    socket.on('close', end)
    upstream.on('close', end)
    upstream.on('error', end)
    let left = bodyLength
    let raw = false
    const up = (chunk: Buffer) => {
      if (raw) {
        upstream.write(chunk)
        return
      }
      if (left <= 0) {
        // Another request on this connection: never sent on to whoever answered the first.
        end()
        return
      }
      const piece = chunk.length > left ? chunk.subarray(0, left) : chunk
      left -= piece.length
      upstream.write(piece)
      if (chunk.length > piece.length) end()
    }
    if (rest.length > 0) up(rest)
    socket.on('data', up)
    let pending: Buffer = Buffer.alloc(0)
    let final = false
    const down = (chunk: Buffer) => {
      if (!socket.write(chunk)) upstream.pause()
    }
    socket.on('drain', () => upstream.resume())
    upstream.on('data', (chunk: Buffer) => {
      if (final) {
        down(chunk)
        return
      }
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk
      for (;;) {
        const rewritten = closingResponseHead(pending, upgrade)
        if (rewritten === 'more') return
        if (rewritten === 'bad') {
          end()
          return
        }
        socket.write(rewritten.head)
        pending = rewritten.rest
        if (rewritten.status === 101 && upgrade) raw = true
        if (rewritten.status >= 200 || rewritten.status === 101) {
          final = true
          if (pending.length > 0) down(pending)
          pending = Buffer.alloc(0)
          return
        }
      }
    })
    upstream.on('end', () => socket.end())
    socket.resume()
  }

  private pipeBoth(socket: Socket, upstream: Duplex): void {
    this.sockets.add(upstream)
    let ended = false
    const end = () => {
      if (ended) return
      ended = true
      socket.destroy()
      upstream.destroy()
      this.sockets.delete(upstream)
    }
    socket.pipe(upstream)
    upstream.pipe(socket)
    socket.on('close', end)
    upstream.on('close', end)
    upstream.on('error', end)
    socket.resume()
  }
}

function openDirect(host: string, port: number): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const socket = connectTcp({ host, port })
    const timer = setTimeout(() => {
      socket.destroy()
      reject(Object.assign(new Error('The connection timed out.'), { code: 'timeout' }))
    }, 10_000)
    socket.once('connect', () => {
      clearTimeout(timer)
      resolve(socket)
    })
    socket.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      reject(Object.assign(error, { code: error.code === 'ECONNREFUSED' ? 'refused' : 'unreachable' }))
    })
  })
}
