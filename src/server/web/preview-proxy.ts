import { randomBytes } from 'node:crypto'
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from 'node:http'
import { connect, type Socket } from 'node:net'
import type { Duplex } from 'node:stream'

import { hashSecret, secretsMatch } from '../../main/automation/tailnet/secret-hash'
import { parseCookies } from './web-http'

// One preview: an agent's dev server on the server's loopback, passed through
// to the browser on an origin of its own (phase 9 spec, 3.6; decision R77).
//
// The preview listens on a loopback port the OS picks, so its origin differs
// from Studio's by port. That is what keeps agent-written code away from
// Studio: its script cannot read Studio's page, and anything it sends Studio
// carries its own `Origin`, which Studio's exact-origin rule refuses. Same
// host and another port is still the same *site*, so cookies are not
// separated by the browser; this listener separates them:
//
// - every cookie named `se_…` (Studio's) is removed from what reaches the dev
//   server, and a `Set-Cookie` of such a name from it is dropped, so the app
//   can neither read nor overwrite Studio's session;
// - the preview is never open without a credential of its own: a one-time
//   entry code (60 seconds, kept as a hash) spent for a `se_pv_<id>` cookie,
//   which every later request and upgrade must carry;
// - a WebSocket upgrade (hot reload) must also come from the preview's own
//   page: no other site, and not Studio's page, can drive the dev server's
//   socket with the person's cookie.
//
// The pass-through changes only what current dev servers need to accept a
// request they believe is their own: `Host` (and an `Origin` naming the
// preview) becomes `localhost:<dev port>`, a redirect to that address comes
// back as the preview's, and the app may be framed by Studio's preview pane
// and no other page. Bodies are piped, never read or rewritten, and nothing is
// injected into the app's pages.

export const PREVIEW_PATH_PREFIX = '/__se_preview/'
export const PREVIEW_ENTER_CODE_TTL_MS = 60 * 1000
const STUDIO_COOKIE = /^(__Host-)?se_/u
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])
const NOT_ALLOWED_PAGE = '<!doctype html><title>Preview</title><p>Open this preview from Studio.</p>\n'

export type PreviewProxyOptions = {
  /** Letters, digits, `-` and `_`: it names the preview's cookie. */
  previewId: string
  /** The dev server's port on the server's loopback. */
  targetPort: number
  /** Studio's own origins: the only pages that may frame the preview. */
  studioOrigins: readonly string[]
  /** The preview is reached over HTTPS (a `tailscale serve` port): its cookie is `Secure`. */
  secure?: boolean
  /** The HTTPS origin a proxy serves this preview under, when it is reached off loopback. */
  publicOrigin?: string | null
  now?: () => number
  log?: (message: string) => void
}

export type PreviewProxy = {
  start(): Promise<{ port: number }>
  /** The bound port, once started. */
  port(): number | null
  /** The origin the browser opens the preview on. */
  origin(): string
  /** A fresh single-use entry code, and the address that spends it. */
  mintEnterCode(): { code: string; enterUrl: string; expiresAt: number }
  /** When the preview last served a request or an upgrade. */
  lastUsedAt(): number
  stop(): Promise<void>
}

function cookieName(previewId: string): string {
  return `se_pv_${previewId}`
}

/** A `Cookie` header with every Studio cookie removed; undefined when nothing is left. */
export function stripStudioCookies(header: string | string[] | undefined): string | undefined {
  const joined = Array.isArray(header) ? header.join('; ') : header
  if (!joined) return undefined
  const kept = joined
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && !STUDIO_COOKIE.test(part.slice(0, Math.max(0, part.indexOf('=')))))
  return kept.length > 0 ? kept.join('; ') : undefined
}

/** A `Set-Cookie` the dev server sent, unless it names one of Studio's cookies. */
function keepSetCookie(value: string): boolean {
  const name = value.slice(0, Math.max(0, value.indexOf('='))).trim()
  return !STUDIO_COOKIE.test(name)
}

/** A CSP whose `frame-ancestors` is Studio's origins, whatever the app said. */
export function replaceFrameAncestors(policy: string, studioOrigins: readonly string[]): string {
  const ancestors = studioOrigins.length > 0 ? studioOrigins.join(' ') : "'none'"
  return policy
    .split(';')
    .map((directive) => (/^\s*frame-ancestors(\s|$)/iu.test(directive) ? ` frame-ancestors ${ancestors}` : directive))
    .join(';')
    .trim()
}

export function createPreviewProxy(options: PreviewProxyOptions): PreviewProxy {
  if (!/^[\w-]{1,64}$/u.test(options.previewId)) throw new Error('A preview id is letters, digits, - and _.')
  if (!Number.isInteger(options.targetPort) || options.targetPort < 1 || options.targetPort > 65535)
    throw new Error('A preview needs a port to pass through to.')
  const now = options.now ?? Date.now
  const name = cookieName(options.previewId)
  const codes: Array<{ hash: string; expiresAt: number }> = []
  const secrets: string[] = []
  const upgraded = new Set<Duplex>()
  let server: Server | null = null
  let boundPort: number | null = null
  let lastUsed = now()
  // Where the dev server answered last: 127.0.0.1 unless only [::1] did.
  let targetHost = '127.0.0.1'

  const loopbackOrigin = () => `http://127.0.0.1:${boundPort ?? 0}`
  const ownOrigins = () => [
    loopbackOrigin(),
    `http://localhost:${boundPort ?? 0}`,
    ...(options.publicOrigin ? [options.publicOrigin] : []),
  ]
  const origin = () => options.publicOrigin ?? loopbackOrigin()

  /** The request names this listener: a page on a hostile name resolving to loopback is not served. */
  function ownHost(request: IncomingMessage): boolean {
    const host = (request.headers.host ?? '').toLowerCase()
    return ownOrigins().some((own) => new URL(own).host === host)
  }

  function hasPreviewCookie(request: IncomingMessage): boolean {
    // Every value is tried: a page on this host can set a same-named cookie on
    // a narrower path, which the browser then sends first.
    const values = parseCookies(request.headers.cookie)
      .filter(([key]) => key === name)
      .map(([, value]) => hashSecret(value))
    return values.some((value) => secrets.some((secret) => secretsMatch(secret, value)))
  }

  /** The request's headers as the dev server should see them. */
  function forwardedHeaders(headers: IncomingHttpHeaders, keepUpgrade: boolean): OutgoingHttpHeaders {
    const named = new Set(
      String(headers.connection ?? '')
        .split(',')
        .map((token) => token.trim().toLowerCase())
        .filter(Boolean),
    )
    const out: OutgoingHttpHeaders = {}
    for (const [key, value] of Object.entries(headers)) {
      if (value === undefined) continue
      const lower = key.toLowerCase()
      if (lower === 'host' || lower === 'cookie' || lower === 'origin') continue
      if (!keepUpgrade && (HOP_BY_HOP.has(lower) || named.has(lower))) continue
      if (lower.startsWith('x-forwarded-') || lower === 'forwarded') continue
      out[key] = value
    }
    out.host = `localhost:${options.targetPort}`
    const cookie = stripStudioCookies(headers.cookie)
    if (cookie) out.cookie = cookie
    const sentOrigin = typeof headers.origin === 'string' ? headers.origin : undefined
    if (sentOrigin !== undefined) {
      out.origin = ownOrigins().includes(sentOrigin) ? `http://localhost:${options.targetPort}` : sentOrigin
    }
    return out
  }

  /** The dev server's response headers as the browser should see them. */
  function returnedHeaders(response: IncomingMessage): OutgoingHttpHeaders {
    const out: OutgoingHttpHeaders = {}
    const location = new RegExp(
      `^https?://(localhost|127\\.0\\.0\\.1|\\[::1\\]):${options.targetPort}(?=/|$|\\?|#)`,
      'iu',
    )
    for (const [key, value] of Object.entries(response.headers)) {
      if (value === undefined) continue
      const lower = key.toLowerCase()
      if (HOP_BY_HOP.has(lower) || lower === 'x-frame-options') continue
      if (lower === 'set-cookie') {
        const kept = (Array.isArray(value) ? value : [value]).filter(keepSetCookie)
        if (kept.length > 0) out[key] = kept
        continue
      }
      if (lower === 'location' && typeof value === 'string') {
        out[key] = value.replace(location, origin())
        continue
      }
      if (lower === 'content-security-policy') {
        const policies = Array.isArray(value) ? value : [value]
        out[key] = policies.map((policy) => replaceFrameAncestors(policy, options.studioOrigins))
        continue
      }
      out[key] = value
    }
    return out
  }

  function refuse(response: ServerResponse, status: number, body: string, type = 'text/html; charset=utf-8'): void {
    response.writeHead(status, {
      'Content-Type': type,
      'Content-Length': String(Buffer.byteLength(body)),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    })
    response.end(body)
  }

  function enter(response: ServerResponse, url: URL): void {
    const presented = url.searchParams.get('code') ?? ''
    const hash = hashSecret(presented)
    const index = codes.findIndex((entry) => secretsMatch(entry.hash, hash))
    const spent = index >= 0 ? codes.splice(index, 1)[0] : null
    if (!spent || spent.expiresAt <= now()) {
      refuse(response, 401, NOT_ALLOWED_PAGE)
      return
    }
    const secret = randomBytes(32).toString('base64url')
    secrets.push(hashSecret(secret))
    response.writeHead(302, {
      Location: '/',
      'Set-Cookie': `${name}=${secret}; Path=/; HttpOnly; SameSite=Strict${options.secure ? '; Secure' : ''}`,
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
      'Content-Length': '0',
    })
    response.end()
  }

  /** Connect to the dev server, on IPv4 loopback first and IPv6 loopback when only it answers. */
  function dial(): Promise<Socket> {
    const attempt = (host: string) =>
      new Promise<Socket>((resolve, reject) => {
        const socket = connect({ host, port: options.targetPort })
        socket.once('connect', () => {
          socket.removeListener('error', reject)
          resolve(socket)
        })
        socket.once('error', reject)
      })
    return attempt(targetHost).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ECONNREFUSED') throw error
      const other = targetHost === '127.0.0.1' ? '::1' : '127.0.0.1'
      return attempt(other).then((socket) => {
        targetHost = other
        return socket
      })
    })
  }

  function forward(request: IncomingMessage, response: ServerResponse): void {
    void dial().then(
      (socket) => {
        const upstream = httpRequest(
          {
            createConnection: () => socket,
            method: request.method,
            path: request.url,
            headers: forwardedHeaders(request.headers, false),
          },
          (answer) => {
            response.writeHead(answer.statusCode ?? 502, answer.statusMessage, returnedHeaders(answer))
            // Server-sent events and streamed pages go out as they arrive.
            response.flushHeaders()
            answer.pipe(response)
          },
        )
        upstream.on('error', (error) => {
          options.log?.(`preview ${options.previewId}: ${error.message}`)
          if (!response.headersSent)
            refuse(response, 502, 'The dev server did not answer.\n', 'text/plain; charset=utf-8')
          else response.destroy()
        })
        response.on('close', () => upstream.destroy())
        request.pipe(upstream)
      },
      () => refuse(response, 502, 'Nothing is listening on the preview’s port.\n', 'text/plain; charset=utf-8'),
    )
  }

  function handle(request: IncomingMessage, response: ServerResponse): void {
    lastUsed = now()
    if (!ownHost(request)) {
      refuse(response, 421, 'Misdirected request.\n', 'text/plain; charset=utf-8')
      return
    }
    const url = new URL(request.url ?? '/', 'http://preview.invalid')
    if (url.pathname.startsWith(PREVIEW_PATH_PREFIX)) {
      // Studio's own paths on this origin are never the app's, and never forwarded.
      if (url.pathname === `${PREVIEW_PATH_PREFIX}enter` && (request.method === 'GET' || request.method === 'HEAD'))
        enter(response, url)
      else refuse(response, 404, 'Not found.\n', 'text/plain; charset=utf-8')
      return
    }
    if (!hasPreviewCookie(request)) {
      refuse(response, 401, NOT_ALLOWED_PAGE)
      return
    }
    forward(request, response)
  }

  function refuseUpgrade(socket: Duplex, status: number, reason: string): void {
    socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  }

  function handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    lastUsed = now()
    socket.on('error', () => undefined)
    if (!ownHost(request)) return refuseUpgrade(socket, 421, 'Misdirected Request')
    const url = new URL(request.url ?? '/', 'http://preview.invalid')
    if (url.pathname.startsWith(PREVIEW_PATH_PREFIX)) return refuseUpgrade(socket, 404, 'Not Found')
    if (!hasPreviewCookie(request)) return refuseUpgrade(socket, 401, 'Unauthorized')
    // Only the preview's own page may open the dev server's socket.
    const sentOrigin = typeof request.headers.origin === 'string' ? request.headers.origin : ''
    if (!ownOrigins().includes(sentOrigin)) return refuseUpgrade(socket, 403, 'Forbidden')
    void dial().then(
      (upstream) => {
        upgraded.add(socket)
        upgraded.add(upstream)
        const headers = forwardedHeaders(request.headers, true)
        const lines = [`${request.method ?? 'GET'} ${request.url ?? '/'} HTTP/1.1`]
        for (const [key, value] of Object.entries(headers)) {
          for (const each of Array.isArray(value) ? value : [value]) lines.push(`${key}: ${String(each)}`)
        }
        upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
        if (head.length > 0) upstream.write(head)
        // Frames are piped, never parsed.
        upstream.pipe(socket)
        socket.pipe(upstream)
        const done = () => {
          upgraded.delete(socket)
          upgraded.delete(upstream)
          socket.destroy()
          upstream.destroy()
        }
        upstream.on('error', done)
        upstream.on('close', done)
        socket.on('close', done)
      },
      () => refuseUpgrade(socket, 502, 'Bad Gateway'),
    )
  }

  return {
    async start() {
      if (server) return { port: boundPort ?? 0 }
      const next = createServer(handle)
      next.on('upgrade', handleUpgrade)
      next.on('clientError', (_error, socket) => socket.destroy())
      await new Promise<void>((resolve, reject) => {
        next.once('error', reject)
        next.listen({ host: '127.0.0.1', port: 0 }, () => {
          next.removeListener('error', reject)
          resolve()
        })
      })
      const address = next.address()
      boundPort = typeof address === 'object' && address ? address.port : null
      server = next
      return { port: boundPort ?? 0 }
    },
    port: () => boundPort,
    origin,
    mintEnterCode() {
      const at = now()
      for (let index = codes.length - 1; index >= 0; index--) if (codes[index].expiresAt <= at) codes.splice(index, 1)
      const code = randomBytes(32).toString('base64url')
      const expiresAt = at + PREVIEW_ENTER_CODE_TTL_MS
      codes.push({ hash: hashSecret(code), expiresAt })
      return { code, enterUrl: `${origin()}${PREVIEW_PATH_PREFIX}enter?code=${code}`, expiresAt }
    },
    lastUsedAt: () => lastUsed,
    async stop() {
      const current = server
      server = null
      for (const socket of upgraded) socket.destroy()
      upgraded.clear()
      if (!current) return
      await new Promise<void>((resolve) => {
        current.close(() => resolve())
        current.closeAllConnections()
      })
    },
  }
}
