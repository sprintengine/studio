import assert from 'node:assert/strict'
import type { IpcMain } from 'electron'

import type { ModuleNotification } from '../../shared/modules/notifications'
import { createMainKernel, type SidecarLifecycle, type SidecarRunState } from './main-host'

function createFakeIpcMain(): IpcMain {
  return { handle: () => undefined } as unknown as IpcMain
}

function trackingLifecycle(log: string[], id: string, overrides: Partial<SidecarLifecycle> = {}): SidecarLifecycle {
  return {
    start: async () => {
      log.push(`start:${id}`)
    },
    stop: async () => {
      log.push(`stop:${id}`)
    },
    ...overrides,
  }
}

// Startup spawns lifecycle sidecars in registration order, composed with the
// modules' other startup hooks; shutdown stops them in reverse order.
async function testStartupAndShutdownOrder(): Promise<void> {
  const kernel = createMainKernel(createFakeIpcMain())
  const log: string[] = []

  const alpha = kernel.hostFor('alpha')
  alpha.onStartup(() => {
    log.push('hook:alpha')
  })
  alpha.registerSidecar({ id: 'alpha-daemon', kind: 'process' }, trackingLifecycle(log, 'alpha-daemon'))
  const beta = kernel.hostFor('beta')
  beta.registerSidecar({ id: 'beta-daemon', kind: 'process' }, trackingLifecycle(log, 'beta-daemon'))

  await kernel.runStartup()
  assert.deepEqual(log, ['hook:alpha', 'start:alpha-daemon', 'start:beta-daemon'])
  assert.deepEqual(
    kernel.sidecarStatuses().map((status) => [status.id, status.moduleId, status.state]),
    [
      ['alpha-daemon', 'alpha', 'running'],
      ['beta-daemon', 'beta', 'running'],
    ]
  )

  log.length = 0
  await kernel.runShutdown()
  assert.deepEqual(log, ['stop:beta-daemon', 'stop:alpha-daemon'], 'shutdown stops in reverse registration order')
  assert.deepEqual(
    kernel.sidecarStatuses().map((status) => status.state),
    ['stopped', 'stopped']
  )
}

// A demand sidecar does not spawn at startup; its owner starts it through the
// kernel handle, and shutdown still stops it.
async function testDemandSidecar(): Promise<void> {
  const kernel = createMainKernel(createFakeIpcMain())
  const log: string[] = []
  const handle = kernel
    .hostFor('sprint-engine')
    .registerSidecar({ id: 'lazy-daemon', kind: 'python-mcp', startOn: 'demand' }, trackingLifecycle(log, 'lazy-daemon'))

  await kernel.runStartup()
  assert.deepEqual(log, [], 'demand sidecars do not spawn at startup')
  assert.equal(handle.status().state, 'stopped')

  await handle.start()
  assert.deepEqual(log, ['start:lazy-daemon'])
  assert.equal(handle.status().state, 'running')
  // A second start while running is a no-op, not a respawn.
  await handle.start()
  assert.deepEqual(log, ['start:lazy-daemon'])

  await kernel.runShutdown()
  assert.deepEqual(log, ['start:lazy-daemon', 'stop:lazy-daemon'])
  assert.equal(handle.status().state, 'stopped')
}

// Spawn failure: queryable 'failed' state with the error recorded, and a
// module-identified error notification — never a fake-running state.
async function testSpawnFailure(): Promise<void> {
  const delivered: ModuleNotification[] = []
  const kernel = createMainKernel(createFakeIpcMain(), {
    deliverNotification: (notification) => {
      delivered.push(notification)
    },
  })
  const handle = kernel.hostFor('sprint-engine').registerSidecar(
    { id: 'broken-daemon', kind: 'process', startOn: 'demand' },
    {
      start: async () => {
        throw new Error('python runtime missing')
      },
      stop: async () => undefined,
    }
  )

  await assert.rejects(() => handle.start(), /python runtime missing/)
  assert.equal(handle.status().state, 'failed')
  assert.equal(handle.status().error, 'python runtime missing')
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0].sourceModuleId, 'sprint-engine')
  assert.equal(delivered[0].severity, 'error')
  assert.match(delivered[0].title, /broken-daemon/)

  // Startup-spawned failures are isolated (runStartup must not throw) but
  // still recorded and notified.
  const startupKernel = createMainKernel(createFakeIpcMain(), {
    deliverNotification: (notification) => {
      delivered.push(notification)
    },
  })
  startupKernel.hostFor('alpha').registerSidecar(
    { id: 'broken-eager', kind: 'process' },
    {
      start: async () => {
        throw new Error('spawn exploded')
      },
      stop: async () => undefined,
    }
  )
  await startupKernel.runStartup()
  assert.deepEqual(
    startupKernel.sidecarStatuses().map((status) => [status.state, status.error]),
    [['failed', 'spawn exploded']]
  )
  assert.equal(delivered.length, 2)
}

// Declarative registrations (no lifecycle) stay 'declared'; the handle cannot
// start them and shutdown ignores them.
async function testDeclarativeSidecar(): Promise<void> {
  const kernel = createMainKernel(createFakeIpcMain())
  const handle = kernel.hostFor('sprint-engine').registerSidecar({ id: 'sprint-engine-core', kind: 'python-on-demand' })

  await kernel.runStartup()
  assert.equal(handle.status().state, 'declared')
  await assert.rejects(() => handle.start(), /without a lifecycle/)
  await kernel.runShutdown()
  assert.equal(handle.status().state, 'declared')
  assert.deepEqual(kernel.sidecars().map((spec) => spec.id), ['sprint-engine-core'])
}

// Status delegation: an externally-triggered daemon's own state is the truth
// source for kernel status queries.
async function testStatusDelegation(): Promise<void> {
  const kernel = createMainKernel(createFakeIpcMain())
  let externalState: SidecarRunState = 'stopped'
  let externalError: string | undefined
  const handle = kernel.hostFor('sprint-engine').registerSidecar(
    { id: 'external-daemon', kind: 'python-mcp', startOn: 'demand' },
    {
      start: async () => {
        externalState = 'running'
      },
      stop: async () => {
        externalState = 'stopped'
      },
      status: () => ({ state: externalState, error: externalError }),
    }
  )

  assert.equal(handle.status().state, 'stopped')
  // The daemon starts outside the kernel handle (demand-driven by usage).
  externalState = 'running'
  assert.equal(handle.status().state, 'running', 'delegated state overrides kernel-observed state')
  externalState = 'failed'
  externalError = 'exited unexpectedly'
  assert.deepEqual([handle.status().state, handle.status().error], ['failed', 'exited unexpectedly'])

  // Shutdown consults the delegated state: not running -> no stop call needed.
  externalState = 'running'
  externalError = undefined
  await kernel.runShutdown()
  assert.equal(externalState, 'stopped', 'shutdown stops a daemon the delegated state reports as running')
}

// Concurrent starts share one spawn — a slow lifecycle is never double-spawned.
async function testConcurrentStartsShareOneSpawn(): Promise<void> {
  const kernel = createMainKernel(createFakeIpcMain())
  let spawnCount = 0
  let releaseSpawn: () => void = () => undefined
  const handle = kernel.hostFor('alpha').registerSidecar(
    { id: 'slow-daemon', kind: 'process', startOn: 'demand' },
    {
      start: () => {
        spawnCount += 1
        return new Promise((resolve) => {
          releaseSpawn = resolve
        })
      },
      stop: async () => undefined,
    }
  )

  const first = handle.start()
  const second = handle.start()
  assert.equal(handle.status().state, 'starting')
  releaseSpawn()
  await Promise.all([first, second])
  assert.equal(spawnCount, 1, 'concurrent starts share one spawn')
  assert.equal(handle.status().state, 'running')
}

function testDuplicateSidecarIdRejected(): void {
  const kernel = createMainKernel(createFakeIpcMain())
  kernel.hostFor('alpha').registerSidecar({ id: 'daemon', kind: 'process' })
  assert.throws(
    () => kernel.hostFor('beta').registerSidecar({ id: 'daemon', kind: 'process' }),
    /already registered by module "alpha"/
  )
}

async function main(): Promise<void> {
  await testStartupAndShutdownOrder()
  await testDemandSidecar()
  await testSpawnFailure()
  await testDeclarativeSidecar()
  await testStatusDelegation()
  await testConcurrentStartsShareOneSpawn()
  testDuplicateSidecarIdRejected()
  console.log('sidecar-lifecycle tests passed')
}

void main()
