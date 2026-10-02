import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { test } from 'vitest'

import { createMessageHub, type ServerControlChannel } from './control-channel'
import { SERVER_EXIT, type ServerBootstrapEnvelope } from './envelope'
import { parentPortChannel, type ParentPortLike } from './parent-port'
import { runShutdownLegs, serveOnChannel, type RunningServer, type ServerStart } from './serve'
import { stdioChannel } from './stdio'

const ENVELOPE: ServerBootstrapEnvelope = {
  v: 1,
  role: 'headless',
  dataDir: '/Users/dev/.local/share/sprintengine-studio/data',
  logsDir: '/Users/dev/.local/state/sprintengine-studio/logs',
  runDir: '/Users/dev/.local/share/sprintengine-studio/data/run',
  tempDir: '/tmp',
  paths: { resourcesDir: null, appPath: '/Users/dev/studio', isPackaged: false, appExecPath: '/usr/bin/node' },
  app: { version: '0.4.0', buildStamp: 'aaaaaaa', channel: 'nightly' },
  owner: {},
  listeners: { gateway: false, tailnet: 'off' },
  secrets: { kind: 'key-file' },
  flags: {},
}

/** A channel whose far end is the test: what it sends is recorded, and the test posts to it. */
function fakeChannel(options: { carriesPorts?: boolean } = {}) {
  const hub = createMessageHub()
  const sent: Array<Record<string, any>> = []
  const waiters: Array<{
    match: (frame: Record<string, any>) => boolean
    resolve: (frame: Record<string, any>) => void
  }> = []
  const closeListeners: Array<() => void> = []
  const channel: ServerControlChannel = {
    carriesPorts: options.carriesPorts ?? true,
    send(frame) {
      const recorded = frame as Record<string, any>
      sent.push(recorded)
      for (const waiter of waiters.splice(0)) {
        if (waiter.match(recorded)) waiter.resolve(recorded)
        else waiters.push(waiter)
      }
    },
    onMessage: (listener) => hub.add(listener),
    onClose(listener) {
      closeListeners.push(listener)
      return () => undefined
    },
  }
  return {
    channel,
    sent,
    post: (message: unknown, ports: unknown[] = []) => hub.dispatch(message, ports),
    close: () => closeListeners.forEach((listener) => listener()),
    /** The first frame sent, now or later, that matches. */
    frame(t: string, match: (frame: Record<string, any>) => boolean = () => true): Promise<Record<string, any>> {
      const already = sent.find((frame) => frame.t === t && match(frame))
      if (already) return Promise.resolve(already)
      return new Promise((resolve) => waiters.push({ match: (frame) => frame.t === t && match(frame), resolve }))
    },
  }
}

function fakeServer(overrides: Partial<RunningServer> = {}): RunningServer & { stops: Array<{ drain: boolean }> } {
  const stops: Array<{ drain: boolean }> = []
  return {
    environmentId: '00000000-0000-4000-8000-000000000000',
    gatewaySocket: '/Users/dev/.local/share/sprintengine-studio/data/automation.sock',
    tailnetBound: null,
    stops,
    async stop({ drain, onLeg }) {
      stops.push({ drain })
      await runShutdownLegs(
        [
          ['gateway', () => undefined],
          ['core', () => undefined],
        ],
        onLeg,
      )
    },
    ...overrides,
  }
}

const silent = () => undefined

test('an envelope, a start, then ready with what the server is', async () => {
  const fake = fakeChannel()
  const server = fakeServer()
  const exit = serveOnChannel(fake.channel, {
    starters: { headless: async () => server },
    unwrapEnvelope: true,
    buildStamp: 'aaaaaaa',
    log: silent,
  })
  fake.post({ t: 'envelope', envelope: ENVELOPE })
  const ready = await fake.frame('ready')
  assert.equal(ready.pid, process.pid)
  assert.equal(ready.environmentId, server.environmentId)
  assert.equal(ready.gateway.socketPath, server.gatewaySocket)
  assert.equal(ready.version, '0.4.0')
  assert.equal(typeof ready.bootMs, 'number')

  fake.post({ t: 'ping', seq: 7 })
  const pong = await fake.frame('pong')
  assert.equal(pong.seq, 7)
  assert.ok(pong.rssMb > 0)
  assert.ok(pong.loopLagMs >= 0)

  fake.post({ t: 'shutdown', drain: true, budgetMs: 5_000 })
  assert.equal(await exit, SERVER_EXIT.ok)
  assert.deepEqual(server.stops, [{ drain: true }])
  const progress = fake.sent.filter((frame) => frame.t === 'shutdown-progress')
  assert.deepEqual(
    progress.map((frame) => [frame.leg, frame.done, frame.total, frame.failed]),
    [
      ['gateway', 1, 2, false],
      ['core', 2, 2, false],
    ],
  )
})

test('a malformed envelope exits 64 and says why', async () => {
  const fake = fakeChannel()
  const exit = serveOnChannel(fake.channel, { starters: {}, unwrapEnvelope: true, buildStamp: null, log: silent })
  fake.post({ t: 'envelope', envelope: { ...ENVELOPE, dataDir: 'relative' } })
  assert.equal(await exit, SERVER_EXIT.usage)
  const fatal = await fake.frame('fatal')
  assert.equal(fatal.code, SERVER_EXIT.usage)
  assert.match(fatal.message, /dataDir/)
})

test('an envelope that never comes exits 64', async () => {
  const fake = fakeChannel()
  const exit = serveOnChannel(fake.channel, {
    starters: {},
    unwrapEnvelope: true,
    buildStamp: null,
    log: silent,
    envelopeTimeoutMs: 10,
  })
  assert.equal(await exit, SERVER_EXIT.usage)
})

test('a role this bundle cannot be is refused', async () => {
  const fake = fakeChannel()
  const exit = serveOnChannel(fake.channel, {
    starters: { headless: async () => fakeServer() },
    unwrapEnvelope: true,
    buildStamp: null,
    log: silent,
  })
  fake.post({
    t: 'envelope',
    envelope: { ...ENVELOPE, role: 'desktop-local', secrets: { kind: 'shell', available: true } },
  })
  assert.equal(await exit, SERVER_EXIT.usage)
  assert.match((await fake.frame('fatal')).message, /desktop-local/)
})

test('a shell and server from different commits exit 67, and the same commit or an unknown one starts', async () => {
  const mismatched = fakeChannel()
  const exit = serveOnChannel(mismatched.channel, {
    starters: { headless: async () => fakeServer() },
    unwrapEnvelope: true,
    buildStamp: 'bbbbbbb',
    log: silent,
  })
  mismatched.post({ t: 'envelope', envelope: ENVELOPE })
  assert.equal(await exit, SERVER_EXIT.mismatch)

  const unknown = fakeChannel()
  void serveOnChannel(unknown.channel, {
    starters: { headless: async () => fakeServer() },
    unwrapEnvelope: true,
    buildStamp: null,
    log: silent,
  })
  unknown.post({ t: 'envelope', envelope: ENVELOPE })
  await unknown.frame('ready')
  unknown.post({ t: 'shutdown', drain: false, budgetMs: 1_000 })
})

test('a start that fails names its exit code, and an untyped failure is 70', async () => {
  for (const [error, code] of [
    [Object.assign(new Error('The data directory is held by pid 4242.'), { exitCode: SERVER_EXIT.dataDirBusy }), 66],
    [new Error('something nobody expected'), 70],
  ] as const) {
    const fake = fakeChannel()
    const exit = serveOnChannel(fake.channel, {
      starters: {
        headless: async () => {
          throw error
        },
      },
      unwrapEnvelope: true,
      buildStamp: null,
      log: silent,
    })
    fake.post({ t: 'envelope', envelope: ENVELOPE })
    assert.equal(await exit, code)
    assert.equal((await fake.frame('fatal')).code, code)
  }
})

test('a shutdown sent while the server starts is carried out once it has', async () => {
  const fake = fakeChannel()
  const server = fakeServer()
  let release: () => void = () => undefined
  const started = new Promise<void>((resolve) => {
    release = resolve
  })
  const exit = serveOnChannel(fake.channel, {
    starters: {
      headless: async () => {
        await started
        return server
      },
    },
    unwrapEnvelope: true,
    buildStamp: null,
    log: silent,
  })
  fake.post({ t: 'envelope', envelope: ENVELOPE })
  fake.post({ t: 'shutdown', drain: false, budgetMs: 2_000 })
  release()
  assert.equal(await exit, SERVER_EXIT.ok)
  assert.deepEqual(server.stops, [{ drain: false }])
  // It still said ready: the supervisor learns its pid and socket either way.
  assert.ok(fake.sent.some((frame) => frame.t === 'ready'))
})

test('a client attached before the server is ready reaches it once it is, with its port', async () => {
  const fake = fakeChannel()
  const attached: Array<[string, unknown]> = []
  const detached: string[] = []
  const exit = serveOnChannel(fake.channel, {
    starters: {
      headless: async () =>
        fakeServer({
          attachClient: (attach, port) => attached.push([attach.clientId, port]),
          detachClient: (clientId) => detached.push(clientId),
        }),
    },
    unwrapEnvelope: true,
    buildStamp: null,
    log: silent,
  })
  const port = { name: 'window port' }
  fake.post({ t: 'envelope', envelope: ENVELOPE })
  fake.post({ t: 'attach-client', clientId: 'w1', windowId: 'main', kind: 'desktop-window' }, [port])
  await fake.frame('ready')
  assert.deepEqual(attached, [['w1', port]])
  fake.post({ t: 'detach-client', clientId: 'w1' })
  fake.post({ t: 'shutdown', drain: true, budgetMs: 1_000 })
  await exit
  assert.deepEqual(detached, ['w1'])
})

test('a server that has to leave on its own stops and exits with its reason', async () => {
  const fake = fakeChannel()
  const server = fakeServer()
  let leave: (code: 66, reason: string) => void = () => undefined
  const start: ServerStart = async ({ requestExit }) => {
    leave = requestExit
    return server
  }
  const exit = serveOnChannel(fake.channel, {
    starters: { headless: start },
    unwrapEnvelope: true,
    buildStamp: null,
    log: silent,
  })
  fake.post({ t: 'envelope', envelope: ENVELOPE })
  await fake.frame('ready')
  leave(66, 'SprintEngine Studio opened this data directory.')
  assert.equal(await exit, SERVER_EXIT.dataDirBusy)
  assert.deepEqual(server.stops, [{ drain: true }])
})

test('a lost parent stops the server without a drain', async () => {
  const fake = fakeChannel()
  const server = fakeServer()
  const exit = serveOnChannel(fake.channel, {
    starters: { headless: async () => server },
    unwrapEnvelope: true,
    buildStamp: null,
    log: silent,
  })
  fake.post({ t: 'envelope', envelope: ENVELOPE })
  await fake.frame('ready')
  fake.close()
  assert.equal(await exit, SERVER_EXIT.ok)
  assert.deepEqual(server.stops, [{ drain: false }])
})

test('a stop that overruns its budget leaves anyway', async () => {
  const fake = fakeChannel()
  const exit = serveOnChannel(fake.channel, {
    starters: { headless: async () => fakeServer({ stop: () => new Promise(() => undefined) }) },
    unwrapEnvelope: true,
    buildStamp: null,
    log: silent,
  })
  fake.post({ t: 'envelope', envelope: ENVELOPE })
  await fake.frame('ready')
  fake.post({ t: 'shutdown', drain: true, budgetMs: 20 })
  assert.equal(await exit, SERVER_EXIT.ok)
})

test('the control RPC rides the same channel, either way', async () => {
  const fake = fakeChannel()
  const exit = serveOnChannel(fake.channel, {
    starters: {
      headless: async ({ rpc }) => {
        rpc.handle('server.version', () => '0.4.0')
        return fakeServer()
      },
    },
    unwrapEnvelope: true,
    buildStamp: null,
    log: silent,
  })
  fake.post({ t: 'envelope', envelope: ENVELOPE })
  await fake.frame('ready')
  fake.post({ t: 'req', id: 1, method: 'server.version', params: {} })
  const answer = await fake.frame('res')
  assert.deepEqual(answer, { t: 'res', id: 1, ok: true, value: '0.4.0' })
  fake.post({ t: 'shutdown', drain: true, budgetMs: 1_000 })
  await exit
})

test('a leg that throws is reported failed and the next still runs', async () => {
  const progress: Array<[string, boolean]> = []
  await runShutdownLegs(
    [
      ['transcripts', () => Promise.reject(new Error('disk full'))],
      ['lock', () => undefined],
    ],
    ({ leg, failed }) => progress.push([leg, failed]),
  )
  assert.deepEqual(progress, [
    ['transcripts', true],
    ['lock', false],
  ])
})

test('the stdio carrier reads the bare envelope, then frames, and writes one line per frame', async () => {
  const input = new PassThrough()
  const output = new PassThrough()
  const written: string[] = []
  output.on('data', (chunk: Buffer) => written.push(...chunk.toString('utf8').split('\n').filter(Boolean)))
  const exit = serveOnChannel(stdioChannel(input, output), {
    starters: { headless: async () => fakeServer() },
    unwrapEnvelope: false,
    buildStamp: null,
    log: silent,
  })
  input.write(`${JSON.stringify(ENVELOPE)}\n`)
  input.write('not json\n')
  await waitFor(() => written.some((line) => JSON.parse(line).t === 'ready'))
  input.write(`${JSON.stringify({ t: 'ping', seq: 1 })}\n`)
  await waitFor(() => written.some((line) => JSON.parse(line).t === 'pong'))
  // stdin ending is the parent gone.
  input.end()
  assert.equal(await exit, SERVER_EXIT.ok)
})

test('the parent-port carrier unwraps the envelope and hands ports through', async () => {
  let deliver: (event: { data: unknown; ports?: readonly unknown[] }) => void = () => undefined
  const posted: unknown[] = []
  const port: ParentPortLike = {
    on: (_event, listener) => {
      deliver = listener
    },
    postMessage: (message) => posted.push(message),
  }
  const attached: unknown[] = []
  const exit = serveOnChannel(parentPortChannel(port), {
    starters: {
      headless: async () => fakeServer({ attachClient: (_attach, windowPort) => attached.push(windowPort) }),
    },
    unwrapEnvelope: true,
    buildStamp: null,
    log: silent,
  })
  deliver({ data: { t: 'envelope', envelope: ENVELOPE } })
  const windowPort = { kind: 'MessagePortMain' }
  deliver({ data: { t: 'attach-client', clientId: 'w', windowId: null, kind: 'desktop-window' }, ports: [windowPort] })
  await waitFor(() => posted.some((message) => (message as { t?: string }).t === 'ready'))
  assert.deepEqual(attached, [windowPort])
  deliver({ data: { t: 'shutdown', drain: true, budgetMs: 1_000 } })
  assert.equal(await exit, SERVER_EXIT.ok)
})

async function waitFor(condition: () => boolean): Promise<void> {
  for (let tries = 0; tries < 500; tries++) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  throw new Error('condition not met')
}
