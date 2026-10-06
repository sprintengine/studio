import assert from 'node:assert/strict'
import { afterEach, beforeEach, test, vi } from 'vitest'

import type { ServerBootstrapEnvelope, ServerReady, SupervisorToServer } from '../../server/bootstrap/envelope'
import {
  createServerSupervisor,
  type ServerChild,
  type ServerExit,
  type SupervisorDeps,
  type SupervisorState,
} from './supervisor'

// The supervisor's state machine (phase 6 spec, 7.1) against a fake child and
// fake timers: every transition, the backoff, the limits, quit in each state,
// one child at a time, the watchdog across sleep, and the kill at the budget.

const ENVELOPE = { v: 1 } as unknown as ServerBootstrapEnvelope

type FakeChild = ServerChild & {
  sent: SupervisorToServer[]
  say(message: unknown): void
  exit(exit?: Partial<ServerExit>): void
  killed: boolean
  alive: boolean
}

function fakeChildren() {
  const children: FakeChild[] = []
  let nextPid = 100
  const fork = (): ServerChild => {
    // The one-child rule, checked where it matters: no fork while one lives.
    assert.equal(
      children.some((child) => child.alive),
      false,
      'forked while the previous server was still alive',
    )
    const messageListeners: Array<(message: unknown) => void> = []
    const exitListeners: Array<(exit: ServerExit) => void> = []
    const child: FakeChild = {
      pid: nextPid++,
      sent: [],
      killed: false,
      alive: true,
      postMessage(message) {
        child.sent.push(message)
      },
      onMessage: (listener) => messageListeners.push(listener),
      onExit: (listener) => exitListeners.push(listener),
      kill() {
        child.killed = true
        // A killed process says so on the next turn, as a real one does.
        queueMicrotask(() => child.exit({ code: null, signal: 'SIGKILL' }))
      },
      say(message) {
        for (const listener of messageListeners) listener(message)
      },
      exit(exit = {}) {
        if (!child.alive) return
        child.alive = false
        for (const listener of exitListeners) listener({ code: exit.code ?? null, signal: exit.signal ?? null })
      },
    }
    children.push(child)
    return child
  }
  return { children, fork, latest: () => children[children.length - 1] }
}

function ready(child: FakeChild): ServerReady {
  const frame: ServerReady = {
    t: 'ready',
    pid: child.pid ?? 0,
    environmentId: 'env',
    version: '0.4.0',
    buildStamp: 'abc',
    gateway: { socketPath: '/Users/dev/Library/Application Support/SprintEngine Studio/automation.sock' },
    tailnet: { bound: null },
    bootMs: 40,
  }
  child.say(frame)
  return frame
}

/** The current state, read through a call so a test's earlier assertions do not narrow it. */
function stateOf(supervisor: { readonly state: SupervisorState }): SupervisorState {
  return supervisor.state
}

function setup(overrides: Partial<SupervisorDeps> = {}) {
  const fake = fakeChildren()
  const logged: string[] = []
  const supervisor = createServerSupervisor({
    fork: fake.fork,
    envelope: () => ENVELOPE,
    now: () => Date.now(),
    log: (line) => logged.push(line),
    ...overrides,
  })
  const states: string[] = []
  supervisor.onState((state) => states.push(state.kind))
  return { supervisor, fake, states, logged }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

test('a start forks once, hands over the envelope, and is ready when the server says so', async () => {
  const { supervisor, fake, states } = setup()
  const readyHeard: ServerReady[] = []
  supervisor.onReady((frame) => readyHeard.push(frame))
  const waited = supervisor.whenReady(10_000)
  supervisor.start()
  supervisor.start()
  assert.equal(fake.children.length, 1)
  assert.deepEqual(fake.latest().sent[0], { t: 'envelope', envelope: ENVELOPE })
  const frame = ready(fake.latest())
  assert.equal(await waited, 'ready')
  assert.deepEqual(states, ['starting', 'ready'])
  assert.deepEqual(readyHeard, [frame])
  assert.equal(supervisor.health.pid, frame.pid)
  assert.equal(supervisor.health.restarts, 0)
})

test('whenReady gives up at its budget without changing anything', async () => {
  const { supervisor } = setup()
  supervisor.start()
  const waited = supervisor.whenReady(4_000)
  await vi.advanceTimersByTimeAsync(4_000)
  assert.equal(await waited, 'timeout')
  assert.equal(supervisor.state.kind, 'starting')
})

test('a crash restarts with backoff: 0.5, 1, 2, 4 s', async () => {
  const { supervisor, fake } = setup({ timing: { crashesInWindow: 99 } })
  supervisor.start()
  ready(fake.latest())
  const delays: number[] = []
  supervisor.onState((state) => {
    if (state.kind === 'backoff') delays.push(state.delayMs)
  })
  for (let i = 0; i < 4; i++) {
    fake.latest().exit({ code: 70 })
    assert.equal(supervisor.state.kind, 'backoff')
    const forked = fake.children.length
    await vi.advanceTimersByTimeAsync(delays[i] - 1)
    assert.equal(fake.children.length, forked, 'nothing forks before the delay')
    await vi.advanceTimersByTimeAsync(1)
    assert.equal(fake.children.length, forked + 1)
    ready(fake.latest())
  }
  assert.deepEqual(delays, [500, 1_000, 2_000, 4_000])
  assert.equal(supervisor.health.restarts, 4)
  assert.equal(supervisor.health.lastExit?.code, 70)
})

test('a minute up resets the backoff', async () => {
  const { supervisor, fake } = setup()
  supervisor.start()
  ready(fake.latest())
  fake.latest().exit({ code: 70 })
  await vi.advanceTimersByTimeAsync(500)
  ready(fake.latest())
  fake.latest().exit({ code: 70 })
  assert.equal(supervisor.state.kind === 'backoff' && supervisor.state.delayMs, 1_000)
  await vi.advanceTimersByTimeAsync(1_000)
  ready(fake.latest())
  // Quiet on pings for the minute: this test is about the backoff, not the watchdog.
  supervisor.power('suspend')
  await vi.advanceTimersByTimeAsync(60_000)
  assert.equal(supervisor.state.kind, 'ready')
  fake.latest().exit({ code: 70 })
  const after = stateOf(supervisor)
  assert.equal(after.kind === 'backoff' && after.delayMs, 500)
})

test('an exit that says the directory, envelope or build is wrong is not retried', async () => {
  for (const code of [64, 65, 66, 67]) {
    const { supervisor, fake } = setup()
    supervisor.start()
    fake.latest().say({ t: 'fatal', code, message: `refused with ${code}` })
    fake.latest().exit({ code })
    assert.equal(supervisor.state.kind, 'failed', `code ${code}`)
    assert.equal(supervisor.state.kind === 'failed' && supervisor.state.reason, `refused with ${code}`)
    assert.equal(supervisor.state.kind === 'failed' && supervisor.state.neverReady, true)
    await vi.advanceTimersByTimeAsync(60_000)
    assert.equal(fake.children.length, 1, 'never forked again')
  }
})

test('three failed boots give up, and say the session never had a server', async () => {
  const { supervisor, fake } = setup()
  supervisor.start()
  fake.latest().exit({ code: 70 })
  await vi.advanceTimersByTimeAsync(500)
  fake.latest().exit({ code: 75 })
  await vi.advanceTimersByTimeAsync(1_000)
  fake.latest().exit({ code: 70 })
  assert.equal(supervisor.state.kind, 'failed')
  assert.equal(supervisor.state.kind === 'failed' && supervisor.state.neverReady, true)
  assert.match(supervisor.state.kind === 'failed' ? supervisor.state.reason : '', /failed to start 3 times/)
})

test('a boot that never says ready is killed at the budget and counts as a failed boot', async () => {
  const { supervisor, fake } = setup()
  supervisor.start()
  await vi.advanceTimersByTimeAsync(15_000)
  assert.equal(fake.latest().killed, true)
  await vi.advanceTimersByTimeAsync(0)
  assert.equal(supervisor.state.kind, 'backoff')
})

test('five crashes in two minutes give up even when each boot succeeded', async () => {
  const { supervisor, fake } = setup()
  supervisor.start()
  for (let i = 0; i < 5; i++) {
    ready(fake.latest())
    fake.latest().exit({ code: null, signal: 'SIGSEGV' })
    if (supervisor.state.kind === 'backoff') await vi.advanceTimersByTimeAsync(supervisor.state.delayMs)
  }
  assert.equal(supervisor.state.kind, 'failed')
  assert.equal(supervisor.state.kind === 'failed' && supervisor.state.neverReady, false)
  assert.match(supervisor.state.kind === 'failed' ? supervisor.state.reason : '', /5 times in two minutes/)
})

test('retry leaves FAILED with the counters reset', async () => {
  const { supervisor, fake } = setup()
  supervisor.start()
  fake.latest().exit({ code: 65 })
  assert.equal(supervisor.state.kind, 'failed')
  supervisor.retry()
  assert.equal(stateOf(supervisor).kind, 'starting')
  ready(fake.latest())
  assert.equal(stateOf(supervisor).kind, 'ready')
})

test('three unanswered pings mean a hung server: it is killed, then restarted', async () => {
  const { supervisor, fake } = setup()
  supervisor.start()
  const hung = fake.latest()
  ready(hung)
  // Answered pings keep it alive.
  for (let i = 0; i < 3; i++) {
    await vi.advanceTimersByTimeAsync(5_000)
    const ping = hung.sent.at(-1) as { t: string; seq: number }
    assert.equal(ping.t, 'ping')
    hung.say({ t: 'pong', seq: ping.seq, loopLagMs: 3, rssMb: 70 })
  }
  assert.equal(supervisor.health.rssMb, 70)
  // Then silence.
  await vi.advanceTimersByTimeAsync(20_000)
  assert.equal(hung.killed, true)
  await vi.advanceTimersByTimeAsync(0)
  assert.equal(supervisor.state.kind, 'backoff')
  await vi.advanceTimersByTimeAsync(500)
  assert.equal(fake.children.length, 2)
})

test('the watchdog does not count while the machine sleeps, nor for a while after it wakes', async () => {
  const { supervisor, fake } = setup()
  supervisor.start()
  const child = fake.latest()
  ready(child)
  supervisor.power('suspend')
  await vi.advanceTimersByTimeAsync(120_000)
  assert.equal(child.killed, false)
  supervisor.power('resume')
  await vi.advanceTimersByTimeAsync(9_000)
  assert.equal(child.killed, false)
  // Awake and answering again.
  await vi.advanceTimersByTimeAsync(5_000)
  const ping = child.sent.at(-1) as { t: string; seq: number }
  child.say({ t: 'pong', seq: ping.seq, loopLagMs: 1, rssMb: 70 })
  await vi.advanceTimersByTimeAsync(5_000)
  assert.equal(child.killed, false)
})

test('a server that exits during the wake grace leaves the watchdog on for the next one', async () => {
  const { supervisor, fake } = setup()
  supervisor.start()
  ready(fake.latest())
  supervisor.power('suspend')
  supervisor.power('resume')
  // It crashes before the grace is over; the next one comes up and hangs.
  fake.latest().exit({ code: 1 })
  await vi.advanceTimersByTimeAsync(1_000)
  assert.equal(fake.children.length, 2)
  const hung = fake.latest()
  ready(hung)
  await vi.advanceTimersByTimeAsync(40_000)
  assert.equal(hung.killed, true)
})

test('a quit while ready drains within the budget and reports each leg', async () => {
  const { supervisor, fake } = setup()
  supervisor.start()
  const child = fake.latest()
  ready(child)
  const legs: string[] = []
  const stopped = supervisor.shutdown({
    drain: true,
    budgetMs: 8_000,
    onProgress: (progress) => legs.push(progress.leg),
  })
  assert.equal(supervisor.state.kind, 'stopping')
  assert.deepEqual(child.sent.at(-1), { t: 'shutdown', drain: true, budgetMs: 7_750 })
  child.say({ t: 'shutdown-progress', leg: 'transcripts', done: 1, total: 2, durationMs: 4, failed: false })
  child.say({ t: 'shutdown-progress', leg: 'gateway', done: 2, total: 2, durationMs: 2, failed: false })
  child.exit({ code: 0 })
  assert.equal(await stopped, 'exited')
  assert.deepEqual(legs, ['transcripts', 'gateway'])
  assert.equal(supervisor.state.kind, 'stopped')
  assert.equal(supervisor.shutdown({ drain: true, budgetMs: 1 }), supervisor.shutdown({ drain: true, budgetMs: 1 }))
})

test('a drain that overruns the budget is killed: the update hand-over never waits on it', async () => {
  const { supervisor, fake } = setup()
  supervisor.start()
  ready(fake.latest())
  const stopped = supervisor.shutdown({ drain: true, budgetMs: 10_000 })
  await vi.advanceTimersByTimeAsync(10_000)
  assert.equal(fake.latest().killed, true)
  assert.equal(await stopped, 'killed')
  await vi.advanceTimersByTimeAsync(60_000)
  assert.equal(fake.children.length, 1, 'a server stopped for quit is not restarted')
})

test('a quit while starting asks without a drain, and kills after two seconds', async () => {
  const { supervisor, fake } = setup()
  supervisor.start()
  const stopped = supervisor.shutdown({ drain: true, budgetMs: 8_000 })
  assert.deepEqual(fake.latest().sent.at(-1), { t: 'shutdown', drain: false, budgetMs: 1_750 })
  await vi.advanceTimersByTimeAsync(2_000)
  assert.equal(await stopped, 'killed')
})

test('a quit during backoff cancels the restart and forks nothing', async () => {
  const { supervisor, fake } = setup()
  supervisor.start()
  ready(fake.latest())
  fake.latest().exit({ code: 70 })
  assert.equal(supervisor.state.kind, 'backoff')
  assert.equal(await supervisor.shutdown({ drain: true, budgetMs: 8_000 }), 'exited')
  await vi.advanceTimersByTimeAsync(60_000)
  assert.equal(fake.children.length, 1)
  assert.equal(supervisor.state.kind, 'stopped')
})

test('a quit after giving up has nothing to stop', async () => {
  const { supervisor, fake } = setup()
  supervisor.start()
  fake.latest().exit({ code: 66 })
  assert.equal(await supervisor.shutdown({ drain: true, budgetMs: 8_000 }), 'exited')
})

test('a restart drains the serving server and forks the next once it has exited', async () => {
  const { supervisor, fake } = setup()
  supervisor.start()
  const first = fake.latest()
  ready(first)
  supervisor.restart('Diagnostics: Restart server')
  // Asked, not killed: a turn in flight is flushed and ends as interrupted.
  assert.equal(first.killed, false)
  assert.deepEqual(first.sent.at(-1), { t: 'shutdown', drain: true, budgetMs: 4_750 })
  supervisor.restart('asked twice')
  assert.equal(first.sent.filter((frame) => frame.t === 'shutdown').length, 1)
  await vi.advanceTimersByTimeAsync(1_000)
  assert.equal(fake.children.length, 1, 'the new one waits for the exit')
  first.exit({ code: 0 })
  assert.equal(fake.children.length, 2)
  assert.equal(supervisor.state.kind, 'starting')
})

test('a restart whose drain overruns kills the old server, then forks the next', async () => {
  const { supervisor, fake } = setup()
  supervisor.start()
  const first = fake.latest()
  ready(first)
  supervisor.restart('Diagnostics: Restart server')
  await vi.advanceTimersByTimeAsync(5_000)
  assert.equal(first.killed, true)
  assert.equal(fake.children.length, 2)
  assert.equal(supervisor.state.kind, 'starting')
})

test('a restart while starting kills at once: there is nothing to drain', async () => {
  const { supervisor, fake } = setup()
  supervisor.start()
  const first = fake.latest()
  supervisor.restart('dev rebuild')
  assert.equal(first.killed, true)
  await vi.advanceTimersByTimeAsync(0)
  assert.equal(fake.children.length, 2)
})

test('a quit whose kill is never reported still finishes after a grace', async () => {
  const { supervisor, fake } = setup()
  supervisor.start()
  const child = fake.latest()
  ready(child)
  child.kill = () => {
    child.killed = true
  }
  const stopped = supervisor.shutdown({ drain: true, budgetMs: 1_000 })
  await vi.advanceTimersByTimeAsync(1_000)
  assert.equal(child.killed, true)
  await vi.advanceTimersByTimeAsync(2_000)
  assert.equal(await stopped, 'killed')
  assert.equal(supervisor.state.kind, 'stopped')
  // The exit arriving late changes nothing and forks nothing.
  child.exit({ code: null, signal: 'SIGKILL' })
  await vi.advanceTimersByTimeAsync(60_000)
  assert.equal(fake.children.length, 1)
  assert.equal(supervisor.state.kind, 'stopped')
})

test('a fork that throws is a failed boot, retried with backoff', async () => {
  let throwOnce = true
  const fake = fakeChildren()
  const { supervisor } = setup({
    fork: () => {
      if (throwOnce) {
        throwOnce = false
        throw new Error('spawn EAGAIN')
      }
      return fake.fork()
    },
  })
  supervisor.start()
  assert.equal(supervisor.state.kind, 'backoff')
  await vi.advanceTimersByTimeAsync(500)
  assert.equal(supervisor.state.kind, 'starting')
})

test('control requests reach the server that is running, and fail while none is', async () => {
  const { supervisor, fake } = setup()
  supervisor.start()
  const child = fake.latest()
  ready(child)
  const asked = supervisor.call<string>('workspaces.prepareAtBoot', {})
  const request = child.sent.at(-1) as unknown as { t: string; id: number; method: string }
  assert.equal(request.method, 'workspaces.prepareAtBoot')
  child.say({ t: 'res', id: request.id, ok: true, value: 'prepared' })
  assert.equal(await asked, 'prepared')

  const outstanding = supervisor.call('slow')
  child.exit({ code: 70 })
  await assert.rejects(outstanding, /stopped/)
  await assert.rejects(supervisor.call('during backoff'), /stopped/)
  await vi.advanceTimersByTimeAsync(500)
  const next = fake.latest()
  ready(next)
  const again = supervisor.call<number>('server.info')
  const second = next.sent.at(-1) as unknown as { id: number }
  next.say({ t: 'res', id: second.id, ok: true, value: 7 })
  assert.equal(await again, 7)
})

test('a frame posted with a port goes only to a server that is ready', () => {
  const { supervisor, fake } = setup()
  supervisor.start()
  const attach = { t: 'attach-client', clientId: 'w1', windowId: 'primary', kind: 'desktop-window' } as const
  assert.equal(supervisor.post(attach, [{}]), false)
  ready(fake.latest())
  assert.equal(supervisor.post(attach, [{}]), true)
  assert.deepEqual(fake.latest().sent.at(-1), attach)
})
