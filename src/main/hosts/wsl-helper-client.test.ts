// Main's side of a WSL helper, against a scripted stand-in for the `wsl.exe`
// process: the handshake, a launch that waits on start, installs, a protocol
// mismatch, transient and fatal failures, the idle stop, crash backoff, and
// the MCP channel.

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Duplex, PassThrough } from 'node:stream'
import { test } from 'vitest'

import { STUB_HELPER_INFO } from '../../../tests/wsl-helper-stub'
import {
  classifyWslFailure,
  createWslHelperClient,
  WSL_HELPER_PROTOCOL,
  type HelperProcess,
  type WslHelperClientDeps,
} from './wsl-helper-client'
import type { NeedReport } from './wsl-install'

type Frame = Record<string, unknown>

// One scripted `wsl.exe`: `behave` decides what it does when the launch script
// arrives, and `onFrame` answers the frames main writes after that.
class FakeProcess extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  written: string[] = []
  script = ''
  killed = false
  closed = false
  private buffer = ''

  constructor(
    private readonly behave: (fake: FakeProcess) => void,
    private readonly onFrame: (fake: FakeProcess, frame: Frame) => void,
  ) {
    super()
    this.stdin.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      if (!this.script) {
        this.script = text
        setImmediate(() => this.behave(this))
        return
      }
      this.buffer += text
      let newline = this.buffer.indexOf('\n')
      while (newline >= 0) {
        const line = this.buffer.slice(0, newline)
        this.buffer = this.buffer.slice(newline + 1)
        this.written.push(line)
        this.onFrame(this, JSON.parse(line) as Frame)
        newline = this.buffer.indexOf('\n')
      }
    })
    this.stdin.on('finish', () => this.close(0))
  }

  send(frame: Frame): void {
    this.stdout.write(`${JSON.stringify(frame)}\n`)
  }

  close(code: number | null): void {
    if (this.closed) return
    this.closed = true
    setImmediate(() => this.emit('close', code, null))
  }

  kill(): void {
    this.killed = true
    this.close(null)
  }
}

function boot(fake: FakeProcess, protocol = WSL_HELPER_PROTOCOL): void {
  fake.send({ t: 'boot', protocol, pid: 4242 })
}

function helperAnswers(handlers: Record<string, (params: unknown) => unknown> = {}) {
  return (fake: FakeProcess, frame: Frame): void => {
    if (frame.t === 'hello') fake.send({ t: 'hello', ok: true, protocol: WSL_HELPER_PROTOCOL, info: STUB_HELPER_INFO })
    else if (frame.t === 'req') {
      const handler = handlers[frame.method as string]
      if (!handler) return
      Promise.resolve(handler(frame.params)).then(
        (result) => fake.send({ t: 'res', id: frame.id as number, result }),
        (error: Error) => fake.send({ t: 'res', id: frame.id as number, error: { message: error.message } }),
      )
    } else if (frame.t === 'shutdown') fake.close(0)
  }
}

function harness(
  processes: Array<() => FakeProcess>,
  overrides: Partial<WslHelperClientDeps> = {},
): {
  deps: WslHelperClientDeps
  spawned: FakeProcess[]
  installs: NeedReport[]
  prewarms: number
  unready: Array<{ node: boolean; app: boolean }>
  sleeps: number[]
} {
  const state = {
    spawned: [] as FakeProcess[],
    installs: [] as NeedReport[],
    prewarms: 0,
    unready: [] as Array<{ node: boolean; app: boolean }>,
    sleeps: [] as number[],
  }
  let next = 0
  const deps: WslHelperClientDeps = {
    distro: 'Ubuntu',
    appVersion: '0.4.0',
    profile: 'abc123def456',
    spawnShell: () => {
      const make = processes[Math.min(next, processes.length - 1)]
      next += 1
      const fake = make()
      state.spawned.push(fake)
      return fake as unknown as HelperProcess
    },
    launchScript: async () => 'exec node helper.mjs',
    install: async (report) => {
      state.installs.push(report)
    },
    prewarm: async () => {
      state.prewarms += 1
    },
    unready: async (what) => {
      state.unready.push(what)
    },
    onEvent: () => undefined,
    connectAutomation: () => new PassThrough(),
    sleep: async (ms) => {
      state.sleeps.push(ms)
    },
    ...overrides,
  }
  return Object.assign(state, { deps })
}

const healthy = (handlers?: Record<string, (params: unknown) => unknown>) => () =>
  new FakeProcess((fake) => boot(fake), helperAnswers(handlers))

test('the hello goes out only after the helper booted, and carries the protocol, version and profile', async () => {
  const h = harness([healthy()])
  const client = createWslHelperClient(h.deps)
  const info = await client.start()
  assert.deepEqual(info, STUB_HELPER_INFO)
  const fake = h.spawned[0]
  assert.equal(fake.script, 'exec node helper.mjs\n', 'the script is written first, and alone')
  assert.deepEqual(JSON.parse(fake.written[0]), {
    t: 'hello',
    protocol: WSL_HELPER_PROTOCOL,
    appVersion: '0.4.0',
    profile: 'abc123def456',
  })
  assert.equal(client.state(), 'ready')
  await client.shutdown()
})

test('a request made while the helper is stopped waits for it to start, and concurrent starts share one', async () => {
  const h = harness([healthy({ ping: () => ({ pong: true }) })])
  const client = createWslHelperClient(h.deps)
  const [first, second] = await Promise.all([client.request('ping'), client.request('ping')])
  assert.deepEqual(first, { pong: true })
  assert.deepEqual(second, { pong: true })
  assert.equal(h.spawned.length, 1)
  await client.shutdown()
})

test('a distribution missing the helper is installed into, then started', async () => {
  const needs = () =>
    new FakeProcess(
      (fake) => {
        fake.stdout.write('@@SPRINTENGINE_NEED node app arch=x86_64 xz=1\n')
        fake.close(3)
      },
      () => undefined,
    )
  const h = harness([needs, healthy()])
  const client = createWslHelperClient(h.deps)
  await client.start()
  assert.deepEqual(h.installs, [{ node: true, app: true, arch: 'x86_64', xz: true }])
  assert.equal(h.spawned.length, 2)
  await client.shutdown()
})

test('an install that does not take is a named, fatal error rather than a loop', async () => {
  const needs = () =>
    new FakeProcess(
      (fake) => {
        fake.stdout.write('@@SPRINTENGINE_NEED app arch=x86_64 xz=0\n')
        fake.close(3)
      },
      () => undefined,
    )
  const h = harness([needs])
  const client = createWslHelperClient(h.deps)
  await assert.rejects(client.start(), /installed into Ubuntu but is still reported missing/u)
  assert.equal(h.installs.length, 1)
})

test('a helper speaking another protocol is killed, reinstalled and started again', async () => {
  const stale = () =>
    new FakeProcess(
      (fake) => boot(fake, WSL_HELPER_PROTOCOL + 1),
      () => undefined,
    )
  const h = harness([stale, healthy()])
  const client = createWslHelperClient(h.deps)
  await client.start()
  assert.equal(h.spawned[0].killed, true, 'never negotiated with')
  assert.deepEqual(h.unready, [{ node: false, app: true }])
  assert.equal(h.spawned.length, 2)
  await client.shutdown()
})

test('a cold VM is pre-warmed and retried; a missing distribution fails at once and is not retried for a while', async () => {
  const booting = () =>
    new FakeProcess(
      (fake) => {
        fake.stderr.write('The Windows Subsystem for Linux instance has terminated.\n')
        fake.close(1)
      },
      () => undefined,
    )
  const h = harness([booting, healthy()])
  const client = createWslHelperClient(h.deps)
  await client.start()
  assert.equal(h.prewarms, 1)
  assert.deepEqual(h.sleeps, [1_000])
  await client.shutdown()

  let now = 0
  const missing = () =>
    new FakeProcess(
      (fake) => {
        fake.stdout.write(Buffer.from('There is no distribution with the supplied name.\r\n', 'utf16le'))
        fake.close(4294967295)
      },
      () => undefined,
    )
  const m = harness([missing], { now: () => now })
  const gone = createWslHelperClient(m.deps)
  await assert.rejects(gone.start(), /this distribution is not installed/u)
  await assert.rejects(gone.start(), /this distribution is not installed/u)
  assert.equal(m.spawned.length, 1, 'the fatal answer stands without asking again')
  assert.equal(m.prewarms, 0, 'nothing to warm up')
  now += 31_000
  await assert.rejects(gone.start())
  assert.equal(m.spawned.length, 2, 'and is asked again later')
})

test('a Node that cannot run drops its marker so the next start installs it again', async () => {
  const noGlibc = () =>
    new FakeProcess(
      (fake) => {
        fake.stderr.write("node: /lib/x86_64-linux-gnu/libc.so.6: version `GLIBC_2.28' not found\n")
        fake.close(1)
      },
      () => undefined,
    )
  const h = harness([noGlibc])
  const client = createWslHelperClient(h.deps)
  await assert.rejects(client.start(), /Node\.js does not run in this distribution/u)
  assert.deepEqual(h.unready, [{ node: true, app: false }])
})

test('the helper stops a while after the last session and request, and not before', async () => {
  const h = harness([healthy({ ping: () => ({}) })], { idleMs: 30 })
  const client = createWslHelperClient(h.deps)
  await client.start()
  client.retain('sid-1#1')
  client.retain('sid-2#2')
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(client.state(), 'ready', 'held while a session lives')
  client.release('sid-1#1')
  client.release('sid-1#1')
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(client.state(), 'ready', 'a double release does not drop the other hold')
  client.release('sid-2#2')
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(client.state(), 'stopped')
  const fake = h.spawned[0]
  assert.ok(
    fake.written.some((line) => (JSON.parse(line) as Frame).t === 'shutdown'),
    'an explicit shutdown before anything is killed',
  )
  assert.equal(fake.killed, false, 'it went on its own')
})

test('a helper that dies is started again on the next need, after a backoff that grows', async () => {
  let current: FakeProcess | null = null
  const crashy = () => {
    current = new FakeProcess((fake) => boot(fake), helperAnswers({ ping: () => ({}) }))
    return current
  }
  const h = harness([crashy], { now: () => 1_000 })
  const client = createWslHelperClient(h.deps)
  await client.request('ping')
  const inFlight = client.request('never-answered')
  ;(current as unknown as FakeProcess).close(1)
  await assert.rejects(inFlight, /stopped/u, 'what was in flight fails rather than hanging')
  assert.equal(client.state(), 'stopped')
  await client.request('ping')
  assert.equal(h.spawned.length, 2)
  ;(current as unknown as FakeProcess).close(1)
  await new Promise((resolve) => setImmediate(resolve))
  await client.request('ping')
  assert.deepEqual(h.sleeps, [1_000, 2_000])
  await client.shutdown()
})

test('a helper that dies while sessions still run there is started again without being asked', async () => {
  const h = harness([healthy()], { now: () => 5_000 })
  const client = createWslHelperClient(h.deps)
  await client.start()
  client.retain('sid-1#1')
  h.spawned[0].close(1)
  await new Promise((resolve) => setTimeout(resolve, 1_300))
  assert.equal(h.spawned.length, 2, 'restarted after the backoff, so live hooks find the sockets again')
  assert.equal(client.state(), 'ready')
  client.release('sid-1#1')
  await client.shutdown()
})

test('an MCP channel reaches only the automation server, both ways, and closes with either end', async () => {
  const toServer: string[] = []
  const serverEnd = new PassThrough()
  const automation = new Duplex({
    read() {},
    write(chunk: Buffer, _encoding, callback) {
      toServer.push(chunk.toString('utf8'))
      callback()
    },
  })
  serverEnd.on('data', (chunk: Buffer) => automation.push(chunk))
  let connects = 0
  const h = harness([healthy()], {
    connectAutomation: () => {
      connects += 1
      return automation
    },
  })
  const client = createWslHelperClient(h.deps)
  await client.start()
  const fake = h.spawned[0]
  fake.send({ t: 'ch', ch: 1, op: 'open' })
  fake.send({ t: 'ch', ch: 1, op: 'data', b64: Buffer.from('{"jsonrpc":"2.0","id":1}\n').toString('base64') })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(connects, 1)
  assert.deepEqual(toServer, ['{"jsonrpc":"2.0","id":1}\n'])
  serverEnd.write('{"id":1,"result":{}}\n')
  await new Promise((resolve) => setTimeout(resolve, 20))
  const reply = fake.written.map((line) => JSON.parse(line) as Frame).find((frame) => frame.op === 'data')
  assert.equal(Buffer.from(String(reply?.b64), 'base64').toString('utf8'), '{"id":1,"result":{}}\n')
  automation.destroy()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.ok(
    fake.written.some((line) => {
      const frame = JSON.parse(line) as Frame
      return frame.t === 'ch' && frame.op === 'close' && frame.ch === 1
    }),
  )
  await client.shutdown()
})

test("wsl.exe's own failures are sorted into transient and fatal", () => {
  assert.equal(classifyWslFailure('WSL_E_DISTRO_NOT_FOUND', 1).code, 'distro-missing')
  assert.equal(classifyWslFailure('Windows Subsystem for Linux has no installed distributions.', 1).fatal, true)
  assert.equal(classifyWslFailure('WSL_E_WSL_OPTIONAL_COMPONENT_REQUIRED', 1).code, 'wsl-missing')
  assert.equal(classifyWslFailure('exec: node: not found', 127).code, 'node-run')
  const cold = classifyWslFailure('Catastrophic failure Error code: Wsl/Service/E_UNEXPECTED', 1)
  assert.equal(cold.fatal, false)
})
