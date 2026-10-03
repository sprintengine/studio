import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http'
import { connect } from 'node:net'
import { afterEach, beforeEach, expect, test } from 'vitest'

import { PREVIEW_ENTER_CODE_TTL_MS, createPreviewProxy, type PreviewProxy } from './preview-proxy'

// The preview's controls against a real dev server on an ephemeral port
// (phase 9 spec, 8.1 and 8.6): each a test that fails if the control goes.

const STUDIO = 'http://127.0.0.1:4791'
let dev: Server
let devPort: number
let seen: IncomingHttpHeaders[]
let seenUpgrades: IncomingHttpHeaders[]
let proxy: PreviewProxy
let clock: number
let devSockets: Array<{ destroy(): void }>

beforeEach(async () => {
  seen = []
  seenUpgrades = []
  devSockets = []
  dev = createServer((request, response) => {
    seen.push(request.headers)
    if (request.url === '/redirect') {
      response.writeHead(302, { Location: `http://localhost:${devPort}/next?x=1` })
      response.end()
      return
    }
    response.writeHead(200, {
      'Content-Type': 'text/plain',
      'Set-Cookie': ['se_s_057639145fa0=planted; Path=/', '__Host-se_x=planted; Path=/', 'app=ok; Path=/'],
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'",
    })
    response.end(`hello from ${request.url}`)
  })
  dev.on('upgrade', (request, socket) => {
    seenUpgrades.push(request.headers)
    devSockets.push(socket)
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
    socket.on('data', (chunk: Buffer) => socket.write(chunk))
  })
  await new Promise<void>((resolve) => dev.listen({ host: '127.0.0.1', port: 0 }, () => resolve()))
  devPort = (dev.address() as { port: number }).port
  clock = Date.parse('2026-10-03T00:00:00Z')
  proxy = createPreviewProxy({ previewId: 'pv1', targetPort: devPort, studioOrigins: [STUDIO], now: () => clock })
  await proxy.start()
})

afterEach(async () => {
  await proxy.stop()
  for (const socket of devSockets) socket.destroy()
  dev.closeAllConnections()
  await new Promise<void>((resolve) => dev.close(() => resolve()))
})

type Answer = { status: number; headers: IncomingHttpHeaders; body: string }

function ask(path: string, headers: Record<string, string> = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: proxy.port() ?? 0, path, headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
      )
    })
    req.on('error', reject)
    req.end()
  })
}

async function enter(): Promise<string> {
  const { enterUrl } = proxy.mintEnterCode()
  const answer = await ask(new URL(enterUrl).pathname + new URL(enterUrl).search)
  expect(answer.status).toBe(302)
  return (answer.headers['set-cookie']?.[0] ?? '').split(';')[0]
}

function upgrade(
  headers: Record<string, string>,
): Promise<{ status: number; echo: () => Promise<string>; close: () => void }> {
  return new Promise((resolve, reject) => {
    const socket = connect(proxy.port() ?? 0, '127.0.0.1', () => {
      const lines = [
        'GET /hmr HTTP/1.1',
        `Host: 127.0.0.1:${proxy.port()}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`),
        '',
        '',
      ]
      socket.write(lines.join('\r\n'))
    })
    socket.once('error', reject)
    socket.once('data', (chunk: Buffer) => {
      const status = Number(/^HTTP\/1\.1 (\d+)/u.exec(chunk.toString('latin1'))?.[1] ?? 0)
      resolve({
        status,
        echo: () =>
          new Promise((done) => {
            socket.once('data', (reply: Buffer) => done(reply.toString('utf8')))
            socket.write('ping-frame')
          }),
        close: () => socket.destroy(),
      })
    })
  })
}

test('the entry code is spent once, for an HttpOnly, SameSite=Strict cookie, and redirects with no referrer', async () => {
  const { enterUrl } = proxy.mintEnterCode()
  const path = new URL(enterUrl).pathname + new URL(enterUrl).search
  const first = await ask(path)
  expect(first.status).toBe(302)
  expect(first.headers.location).toBe('/')
  expect(first.headers['referrer-policy']).toBe('no-referrer')
  expect(first.headers['cache-control']).toBe('no-store')
  const cookie = first.headers['set-cookie']?.[0] ?? ''
  expect(cookie).toMatch(/^se_pv_pv1=/u)
  expect(cookie).toContain('HttpOnly')
  expect(cookie).toContain('SameSite=Strict')
  expect((await ask(path)).status).toBe(401)
})

test('an entry code expires after sixty seconds', async () => {
  const { enterUrl } = proxy.mintEnterCode()
  clock += PREVIEW_ENTER_CODE_TTL_MS + 1
  expect((await ask(new URL(enterUrl).pathname + new URL(enterUrl).search)).status).toBe(401)
})

test('without the preview cookie the listener answers 401 and the dev server hears nothing', async () => {
  const answer = await ask('/', { Cookie: 'se_s_057639145fa0=studio-session' })
  expect(answer.status).toBe(401)
  expect(answer.body).toContain('Open this preview from Studio.')
  expect(seen).toHaveLength(0)
})

test('nothing under Studio’s own path is forwarded, cookie or not', async () => {
  const cookie = await enter()
  expect((await ask('/__se_preview/anything', { Cookie: cookie })).status).toBe(404)
  expect(seen).toHaveLength(0)
})

test('every Studio cookie is stripped from what the dev server receives, and the app’s own cookie kept', async () => {
  const cookie = await enter()
  const answer = await ask('/page', { Cookie: `${cookie}; se_s_057639145fa0=studio-session; __Host-se_y=z; app=mine` })
  expect(answer.status).toBe(200)
  expect(answer.body).toBe('hello from /page')
  expect(seen[0].cookie).toBe('app=mine')
})

test('a Studio-named Set-Cookie from the dev server is dropped, and the app’s passes', async () => {
  const cookie = await enter()
  const answer = await ask('/', { Cookie: cookie })
  expect(answer.headers['set-cookie']).toEqual(['app=ok; Path=/'])
})

test('Host and Origin are the dev server’s own, and its redirects come back as the preview’s', async () => {
  const cookie = await enter()
  await ask('/', { Cookie: cookie, Origin: proxy.origin() })
  expect(seen[0].host).toBe(`localhost:${devPort}`)
  expect(seen[0].origin).toBe(`http://localhost:${devPort}`)
  expect(seen[0]['x-forwarded-for']).toBeUndefined()
  const redirected = await ask('/redirect', { Cookie: cookie })
  expect(redirected.headers.location).toBe(`${proxy.origin()}/next?x=1`)
})

test('only Studio may frame the app: X-Frame-Options goes and frame-ancestors is replaced', async () => {
  const cookie = await enter()
  const answer = await ask('/', { Cookie: cookie })
  expect(answer.headers['x-frame-options']).toBeUndefined()
  expect(answer.headers['content-security-policy']).toBe(`default-src 'self'; frame-ancestors ${STUDIO}`)
})

test('a cookie a page planted on a narrower path does not shadow the real one', async () => {
  const cookie = await enter()
  const answer = await ask('/', { Cookie: `se_pv_pv1=planted-by-the-app; ${cookie}` })
  expect(answer.status).toBe(200)
})

test('an upgrade from another origin is refused, Studio’s own page included', async () => {
  const cookie = await enter()
  const other = await upgrade({ Cookie: cookie, Origin: 'http://127.0.0.1:3000' })
  other.close()
  expect(other.status).toBe(403)
  const studio = await upgrade({ Cookie: cookie, Origin: STUDIO })
  studio.close()
  expect(studio.status).toBe(403)
  expect(seenUpgrades).toHaveLength(0)
})

test('an upgrade without the preview cookie is refused', async () => {
  const anonymous = await upgrade({ Origin: proxy.origin() })
  anonymous.close()
  expect(anonymous.status).toBe(401)
})

test('hot reload: an upgrade from the preview’s page passes through, frames piped, cookies stripped', async () => {
  const cookie = await enter()
  const socket = await upgrade({ Cookie: `${cookie}; se_s_057639145fa0=studio`, Origin: proxy.origin() })
  expect(socket.status).toBe(101)
  expect(await socket.echo()).toBe('ping-frame')
  socket.close()
  expect(seenUpgrades[0].host).toBe(`localhost:${devPort}`)
  expect(seenUpgrades[0].origin).toBe(`http://localhost:${devPort}`)
  expect(seenUpgrades[0].cookie).toBeUndefined()
})

test('a request naming another host is not served, even with the preview cookie', async () => {
  const cookie = await enter()
  const answer = await ask('/', { Cookie: cookie, Host: 'rebind.example' })
  expect(answer.status).toBe(421)
  expect(seen).toHaveLength(0)
})
