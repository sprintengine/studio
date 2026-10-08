import assert from 'node:assert/strict'
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import { connect, createServer, type AddressInfo, type Server } from 'node:net'
import type { Duplex } from 'node:stream'
import { afterAll, beforeAll, test } from 'vitest'

import {
  closingResponseHead,
  isLoopbackTarget,
  openDirect,
  parseAuthority,
  requestBodyLength,
  SshPaneForward,
} from './pane-forward'

// The pane's forward with the relay played by local sockets: the proxy is
// real (Node's HTTP server on loopback), and so are the client's requests,
// written the way Chromium writes them through an HTTP proxy.

let echo: Server
let echoPort = 0
let site: HttpServer
let sitePort = 0
let seenHeaders: Record<string, unknown> = {}

beforeAll(async () => {
  echo = createServer((socket) => socket.pipe(socket))
  await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', resolve))
  echoPort = (echo.address() as AddressInfo).port
  site = createHttpServer((req, res) => {
    seenHeaders = req.headers
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(`build-box dev page ${req.url}`)
  })
  await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve))
  sitePort = (site.address() as AddressInfo).port
})
afterAll(() => {
  echo.close()
  site.close()
})

/** The relay's tcp streams, played by connecting here; records what it was asked for. */
function forward(options: { connected?: boolean; refuse?: string; traffic?: 'all' | 'loopback' | 'off' } = {}) {
  const asked: Array<[string, number]> = []
  const direct: Array<[string, number]> = []
  const open = (host: string, port: number, into: Array<[string, number]>) =>
    new Promise<Duplex>((resolve, reject) => {
      into.push([host, port])
      if (options.refuse) {
        reject(Object.assign(new Error('Nothing is listening there.'), { code: options.refuse }))
        return
      }
      const socket = connect({ host: '127.0.0.1', port })
      socket.once('connect', () => resolve(socket))
      socket.once('error', reject)
    })
  const proxy = new SshPaneForward({
    label: 'build-box',
    openRemote: (host, port) => open(host, port, asked),
    openDirect: (host, port) => open(host, port, direct),
    connected: () => options.connected ?? true,
    waitConnected: async () => options.connected ?? true,
    traffic: () => options.traffic ?? 'all',
  })
  return { proxy, asked, direct }
}

function raw(port: number, text: string, after?: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port })
    let out = ''
    let wrote = false
    socket.on('data', (chunk) => {
      out += chunk.toString('utf8')
      if (after && !wrote && out.includes('200 Connection Established')) {
        wrote = true
        socket.write(after)
        setTimeout(() => socket.end(), 200)
      }
    })
    socket.on('close', () => resolve(out))
    socket.write(text)
    if (!after) setTimeout(() => socket.end(), 500)
  })
}

const auth = (proxy: SshPaneForward) =>
  `Proxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')}\r\n`

test('without its credential, nothing goes through: 407, for CONNECT and plain requests', async () => {
  const { proxy, asked } = forward()
  const port = await proxy.open()
  try {
    const connectAnswer = await raw(
      port,
      `CONNECT localhost:${echoPort} HTTP/1.1\r\nHost: localhost:${echoPort}\r\n\r\n`,
    )
    assert.match(connectAnswer, /^HTTP\/1\.1 407 /u)
    assert.match(connectAnswer, /Proxy-Authenticate: Basic realm="SprintEngine Studio: build-box"/u)
    const wrong = await raw(
      port,
      `GET http://localhost:${sitePort}/ HTTP/1.1\r\nHost: localhost\r\nProxy-Authorization: Basic ${Buffer.from('studio:guess').toString('base64')}\r\n\r\n`,
    )
    assert.match(wrong, /^HTTP\/1\.1 407 /u)
    assert.deepEqual(asked, [], 'the relay was never asked')
  } finally {
    await proxy.close()
  }
})

test("with it, CONNECT tunnels to the machine's localhost, and a plain request reaches its page", async () => {
  const { proxy, asked } = forward()
  const port = await proxy.open()
  assert.ok(proxy.answers('127.0.0.1', port))
  assert.ok(!proxy.answers('127.0.0.1', port + 1))
  try {
    const tunnelled = await raw(
      port,
      `CONNECT localhost:${echoPort} HTTP/1.1\r\nHost: localhost:${echoPort}\r\n${auth(proxy)}\r\n`,
      'ping through the relay',
    )
    assert.match(tunnelled, /^HTTP\/1\.1 200 Connection Established\r\n\r\nping through the relay$/u)
    const page = await raw(
      port,
      `GET http://localhost:${sitePort}/index.html?x=1 HTTP/1.1\r\nHost: localhost:${sitePort}\r\n${auth(proxy)}Proxy-Connection: keep-alive\r\nConnection: close\r\n\r\n`,
    )
    assert.match(page, /^HTTP\/1\.1 200 /u)
    assert.match(page, /build-box dev page \/index\.html\?x=1/u)
    assert.equal(seenHeaders['proxy-authorization'], undefined, 'the credential stays with the proxy')
    assert.deepEqual(asked, [
      ['localhost', echoPort],
      ['localhost', sitePort],
    ])
  } finally {
    await proxy.close()
  }
  assert.equal(proxy.port, null)
})

test("refusals and a reconnecting machine are said in words; 'loopback' sends only loopback through", async () => {
  const refused = forward({ refuse: 'refused' })
  const port = await refused.proxy.open()
  const answer = await raw(port, `CONNECT localhost:9 HTTP/1.1\r\nHost: localhost:9\r\n${auth(refused.proxy)}\r\n`)
  assert.match(answer, /^HTTP\/1\.1 502 Bad Gateway[\s\S]*Nothing is listening there\./u)
  await refused.proxy.close()

  const down = forward({ connected: false })
  const downPort = await down.proxy.open()
  const waiting = await raw(downPort, `CONNECT localhost:${echoPort} HTTP/1.1\r\nHost: x\r\n${auth(down.proxy)}\r\n`)
  assert.match(waiting, /^HTTP\/1\.1 503 [\s\S]*build-box is reconnecting\. This tab's network goes through it\./u)
  assert.deepEqual(down.asked, [])
  await down.proxy.close()

  const loopback = forward({ traffic: 'loopback' })
  const loopPort = await loopback.proxy.open()
  await raw(loopPort, `CONNECT 127.0.0.1:${echoPort} HTTP/1.1\r\nHost: x\r\n${auth(loopback.proxy)}\r\n`, 'a')
  await raw(loopPort, `CONNECT example.test:${echoPort} HTTP/1.1\r\nHost: x\r\n${auth(loopback.proxy)}\r\n`, 'b')
  assert.deepEqual(loopback.asked, [['127.0.0.1', echoPort]])
  assert.deepEqual(loopback.direct, [['example.test', echoPort]])
  await loopback.proxy.close()
})

test('what counts as loopback, and what a CONNECT may name', () => {
  for (const host of [
    'localhost',
    'app.localhost',
    '127.0.0.1',
    '127.1.2.3',
    '::1',
    '[::1]',
    // Each reaches the loopback of whichever computer connects.
    '0.0.0.0',
    '::',
    '[::ffff:127.0.0.1]',
    '::ffff:7f00:1',
    '0:0:0:0:0:0:0:1',
  ])
    assert.equal(isLoopbackTarget(host), true, host)
  for (const host of ['example.test', '10.0.0.1', 'localhost.example.test', '::2', '::ffff:a00:1', 'fe80::1'])
    assert.equal(isLoopbackTarget(host), false, host)
  assert.deepEqual(parseAuthority('localhost:5173'), { host: 'localhost', port: 5173 })
  assert.deepEqual(parseAuthority('[::1]:443'), { host: '::1', port: 443 })
  for (const bad of ['localhost', 'a b:80', 'host:0', 'host:70000', 'http://x:80'])
    assert.equal(parseAuthority(bad), null, bad)
})

test('a plain request is passed on once: a second one on the connection never reaches whoever answered the first', async () => {
  // A site that answers with keep-alive, sends an early hint first, and
  // writes down every byte it is sent after its answer.
  const after: string[] = []
  const hostile = createServer((socket) => {
    let seen = ''
    let answered = false
    socket.on('data', (chunk) => {
      seen += chunk.toString('latin1')
      if (answered) {
        after.push(chunk.toString('latin1'))
        socket.destroy()
        return
      }
      if (!seen.includes('\r\n\r\n')) return
      answered = true
      socket.write(
        'HTTP/1.1 103 Early Hints\r\nConnection: keep-alive\r\n\r\n' +
          'HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: keep-alive\r\nKeep-Alive: timeout=60\r\n\r\nhello',
      )
    })
  })
  await new Promise<void>((resolve) => hostile.listen(0, '127.0.0.1', resolve))
  const hostilePort = (hostile.address() as AddressInfo).port
  const { proxy } = forward()
  const port = await proxy.open()
  try {
    const answer = await new Promise<string>((resolve) => {
      const socket = connect({ host: '127.0.0.1', port })
      let out = ''
      socket.on('data', (chunk) => {
        out += chunk.toString('latin1')
        if (out.endsWith('hello'))
          // Chromium's next request, to another site, on the kept connection.
          socket.write(
            `GET http://localhost:${sitePort}/secret HTTP/1.1\r\nHost: localhost:${sitePort}\r\n${auth(proxy)}Cookie: session=abc\r\n\r\n`,
          )
      })
      socket.on('close', () => resolve(out))
      socket.write(
        `POST http://localhost:${hostilePort}/form HTTP/1.1\r\nHost: x\r\n${auth(proxy)}Content-Length: 3\r\n\r\nabc`,
      )
    })
    const heads = answer.split('\r\n\r\n')
    assert.match(heads[0]!, /^HTTP\/1\.1 103 /u)
    assert.match(heads[0]!, /Connection: close/u)
    assert.doesNotMatch(heads[0]!, /keep-alive/iu)
    assert.match(heads[1]!, /^HTTP\/1\.1 200 OK[\s\S]*Connection: close\r\nProxy-Connection: close$/u)
    assert.doesNotMatch(heads[1]!, /keep-alive/iu)
    assert.equal(heads[2], 'hello')
    assert.deepEqual(after, [], 'nothing after the first request reached the site')
  } finally {
    await proxy.close()
    hostile.close()
  }
})

test('a plain request body is framed by its Content-Length, or not passed on', () => {
  assert.equal(requestBodyLength({ headers: [] }), 0)
  assert.equal(requestBodyLength({ headers: [['Content-Length', '12']] }), 12)
  assert.equal(requestBodyLength({ headers: [['Transfer-Encoding', 'chunked']] }), null)
  assert.equal(
    requestBodyLength({
      headers: [
        ['Content-Length', '1'],
        ['content-length', '2'],
      ],
    }),
    null,
  )
  assert.equal(requestBodyLength({ headers: [['Content-Length', '-1']] }), null)
  const upgraded = closingResponseHead(
    Buffer.from('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\nframes'),
    true,
  )
  assert.ok(typeof upgraded === 'object')
  assert.match(upgraded.head.toString(), /Connection: Upgrade/u)
  assert.equal(upgraded.rest.toString(), 'frames')
  assert.equal(closingResponseHead(Buffer.from('HTTP/1.1 200 OK\r\n'), false), 'more')
  assert.equal(closingResponseHead(Buffer.from('nonsense\r\n\r\n'), false), 'bad')
})

test("loopback mode's direct connections refuse a name that resolves to this computer's loopback or a link-local address", async () => {
  const server: Server = createServer((socket) => socket.end())
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  try {
    const answers: Record<string, Array<{ address: string; family: number }>> = {
      'rebound.example': [{ address: '127.0.0.1', family: 4 }],
      'range.example': [{ address: '127.0.0.2', family: 4 }],
      'mixed.example': [
        { address: '192.0.2.10', family: 4 },
        { address: '::1', family: 6 },
      ],
      'metadata.example': [{ address: '169.254.169.254', family: 4 }],
      'link-local.example': [{ address: 'fe80::1', family: 6 }],
      'six-to-four.example': [{ address: '2002:7f00:1::', family: 6 }],
    }
    const resolveHost = async (host: string) => answers[host] ?? []
    for (const host of Object.keys(answers))
      await assert.rejects(openDirect(host, port, resolveHost), { code: 'refused' })
    await assert.rejects(
      openDirect('gone.example', port, () => Promise.reject(new Error('ENOTFOUND'))),
      { code: 'unreachable' },
    )
  } finally {
    server.close()
  }
})
