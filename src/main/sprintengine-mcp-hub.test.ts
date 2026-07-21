import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMainKernel } from './module-host/main-host'
import { createGatedSprintEngineMcpHub, createSprintEngineMcpHubService } from './sprintengine-mcp-hub'

async function main(): Promise<void> {
  const diagnostics: Array<{ scope: string; event: string; payload: Record<string, unknown> }> = []
  const service = createSprintEngineMcpHubService({
    runtimeRoot: () => process.cwd(),
    logMainPerfEvent: (scope, event, payload) => {
      diagnostics.push({ scope, event, payload })
    },
  })

  const first = await service.ensureStarted()
  const second = await service.ensureStarted()

  assert.equal(first.url, second.url)
  assert.equal(first.adminToken, second.adminToken)
  assert.equal(process.env.MULTICODE_TEST_SPRINTENGINE_MCP_TOKEN, undefined)
  assert.match(first.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
  const readyStatus = service.status()
  assert.equal(readyStatus.state, 'ready')
  assert.equal(readyStatus.port, Number(new URL(first.url).port))
  assert.equal(readyStatus.activeRunCount, 0)
  assert.equal('adminToken' in readyStatus, false)
  assert.equal(JSON.stringify(readyStatus).includes(first.adminToken), false)

  const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-mcp-hub-'))
  const teamDirectory = join(workspaceRoot, '.multi-code', 'sprintengine', 'team')
  await mkdir(teamDirectory, { recursive: true })
  const registration = await service.ensureRunRegistered({
    workspaceRoot,
    statePath: join(teamDirectory, 'run.yaml'),
    allowedRoots: [workspaceRoot],
    registryRoots: [],
    actorId: 'multicode-app',
  })
  const duplicateRegistration = await service.ensureRunRegistered({
    workspaceRoot,
    statePath: join(teamDirectory, 'run.yaml'),
    allowedRoots: [workspaceRoot],
    registryRoots: [],
    actorId: 'multicode-app',
  })
  assert.equal(registration.runId, duplicateRegistration.runId)
  assert.equal(registration.runToken, duplicateRegistration.runToken)
  assert.equal(duplicateRegistration.reused, true)
  assert.ok(registration.runToken)
  assert.equal(service.status().activeRunCount, 1)
  const proxiedHelp = await service.callRunTool({
    runId: registration.runId,
    toolName: 'sprintengine.help',
    arguments: { role: 'architect', agentId: 'architect', topic: 'agent_workflow' },
  }) as { content?: Array<{ type?: string; text?: string }>; isError?: boolean }
  assert.notEqual(proxiedHelp.isError, true, 'the main-process run proxy preserves a successful MCP result')
  assert.equal(proxiedHelp.content?.[0]?.type, 'text')
  assert.match(proxiedHelp.content?.[0]?.text ?? '', /sprintengine\.agent\.join/)

  const concurrentWorkspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-mcp-hub-concurrent-'))
  const concurrentTeamDirectory = join(concurrentWorkspaceRoot, '.multi-code', 'sprintengine', 'team')
  await mkdir(concurrentTeamDirectory, { recursive: true })
  const concurrentInput = {
    workspaceRoot: concurrentWorkspaceRoot,
    statePath: join(concurrentTeamDirectory, 'run.yaml'),
    allowedRoots: [concurrentWorkspaceRoot],
    registryRoots: [],
    actorId: 'multicode-app',
  }
  const [concurrentFirst, concurrentSecond] = await Promise.all([
    service.ensureRunRegistered(concurrentInput),
    service.ensureRunRegistered(concurrentInput),
  ])
  assert.equal(concurrentFirst.runId, concurrentSecond.runId)
  assert.equal(concurrentFirst.runToken, concurrentSecond.runToken)
  assert.equal(concurrentSecond.reused, true)
  assert.equal(service.status().activeRunCount, 2)
  await service.unregisterRun(concurrentFirst.runId)
  assert.equal(service.status().activeRunCount, 1)

  await service.unregisterRun(registration.runId)
  assert.equal(service.status().activeRunCount, 0)

  await service.stop()

  assert.equal(service.status().state, 'stopped')
  assert.equal(
    diagnostics.some((entry) => entry.scope === 'SprintEngineMcpHub' && entry.event === 'ready' && entry.payload.port === readyStatus.port),
    true,
    `expected sanitized ready diagnostic, got ${JSON.stringify(diagnostics)}`
  )
  assert.equal(JSON.stringify(diagnostics).includes(first.adminToken), false, 'hub diagnostics must not leak the admin token')
  assert.equal(JSON.stringify(diagnostics).includes(registration.runToken), false, 'hub diagnostics must not leak run tokens')

  const failedService = createSprintEngineMcpHubService({
    runtimeRoot: () => null,
    logMainPerfEvent: (scope, event, payload) => {
      diagnostics.push({ scope, event, payload })
    },
  })
  await assert.rejects(
    () => failedService.ensureStarted(),
    /Bundled Sprint Engine MCP runtime was not found/
  )
  assert.equal(failedService.status().state, 'failed')
  assert.equal(failedService.status().activeRunCount, 0)
  assert.match(failedService.status().lastError ?? '', /Bundled Sprint Engine MCP runtime was not found/)

  const slowDiagnostics: Array<{ event: string; payload: Record<string, unknown> }> = []
  const slowProcess = new EventEmitter() as EventEmitter & {
    stderr: EventEmitter
    killed: boolean
    pid: number
    kill(): boolean
  }
  slowProcess.stderr = new EventEmitter()
  slowProcess.killed = false
  slowProcess.pid = 12345
  slowProcess.kill = () => {
    slowProcess.killed = true
    setTimeout(() => slowProcess.emit('exit', 0), 0)
    return true
  }
  const slowService = createSprintEngineMcpHubService({
    runtimeRoot: () => process.cwd(),
    spawnProcess: (() => slowProcess) as never,
    logMainPerfEvent: (_scope, event, payload) => {
      slowDiagnostics.push({ event, payload })
    },
  })
  const pendingStart = slowService.ensureStarted().then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error })
  )
  await new Promise((resolve) => setTimeout(resolve, 0))
  await slowService.stop()
  const stoppedStart = await pendingStart
  assert.equal(stoppedStart.ok, false)
  assert.match(stoppedStart.ok ? '' : String((stoppedStart.error as Error).message), /startup was stopped/)
  assert.equal(slowService.status().state, 'stopped')
  assert.equal(slowService.status().lastError, undefined)
  assert.equal(
    slowDiagnostics.some((entry) => entry.event === 'start-failed'),
    false,
    `intentional stop during startup must not log start-failed: ${JSON.stringify(slowDiagnostics)}`
  )

  await testGatedHubOwnership()
  await testKernelOwnedSidecarLifecycle()
}

// The spawn-ownership gate: until the Sprint Engine module claims the hub
// (i.e. while the module is disabled), spawn paths fail explicitly; spawn
// failures after claiming are reported to the owning module.
async function testGatedHubOwnership(): Promise<void> {
  const unclaimed = createGatedSprintEngineMcpHub(
    createSprintEngineMcpHubService({ runtimeRoot: () => process.cwd() })
  )
  await assert.rejects(() => unclaimed.ensureStarted(), /Sprint Engine module is disabled/)
  await assert.rejects(
    () =>
      unclaimed.ensureRunRegistered({
        workspaceRoot: process.cwd(),
        statePath: join(process.cwd(), 'run.yaml'),
        allowedRoots: [process.cwd()],
        registryRoots: [],
        actorId: 'multicode-app',
      }),
    /Sprint Engine module is disabled/
  )
  assert.equal(unclaimed.status().state, 'stopped', 'an unclaimed hub never spawned')
  await unclaimed.stop()

  const spawnFailures: string[] = []
  const failing = createGatedSprintEngineMcpHub(createSprintEngineMcpHubService({ runtimeRoot: () => null }))
  failing.claimOwnership({ onSpawnFailure: (message) => spawnFailures.push(message) })
  await assert.rejects(() => failing.ensureStarted(), /Bundled Sprint Engine MCP runtime was not found/)
  assert.deepEqual(spawnFailures, ['Bundled Sprint Engine MCP runtime was not found.'])
  assert.equal(failing.status().state, 'failed')
  await failing.setModuleEnabled(false)
  assert.equal(failing.status().state, 'stopped', 'disabling the module stops its Python hub')
  await assert.rejects(() => failing.ensureStarted(), /Sprint Engine module is disabled/)
  await failing.setModuleEnabled(true)
  await assert.rejects(() => failing.ensureStarted(), /Bundled Sprint Engine MCP runtime was not found/)
}

// The migrated first-party path end to end: the sprint-engine module registers
// the hub as a demand sidecar through the kernel; a real hub spawns, a real
// MCP run registration succeeds, and kernel shutdown stops the process.
async function testKernelOwnedSidecarLifecycle(): Promise<void> {
  const notifications: Array<{ sourceModuleId: string; title: string }> = []
  const kernel = createMainKernel({ handle: () => undefined } as unknown as Parameters<typeof createMainKernel>[0], {
    deliverNotification: (notification) => {
      notifications.push({ sourceModuleId: notification.sourceModuleId, title: notification.title })
    },
  })
  const hub = createGatedSprintEngineMcpHub(
    createSprintEngineMcpHubService({ runtimeRoot: () => process.cwd() })
  )
  const host = kernel.hostFor('sprint-engine')
  hub.claimOwnership({
    onSpawnFailure: (message) =>
      host.notify({ severity: 'error', title: 'Sprint Engine MCP hub failed to start', body: message }),
  })
  const handle = host.registerSidecar(
    { id: 'sprintengine-mcp', kind: 'python-mcp', module: 'sprintengine_mcp', startOn: 'demand' },
    {
      start: async () => {
        await hub.ensureStarted()
      },
      stop: () => hub.stop(),
      status: () => {
        const current = hub.status()
        const state = current.state === 'ready' ? 'running' : current.state
        return { state, error: current.lastError }
      },
    }
  )

  await kernel.runStartup()
  assert.equal(handle.status().state, 'stopped', 'demand sidecar does not spawn at app startup')

  // Demand trigger: a managed run registration spawns the hub and performs a
  // real MCP run registration over HTTP.
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-mcp-hub-sidecar-'))
  const teamDirectory = join(workspaceRoot, '.multi-code', 'sprintengine', 'team')
  await mkdir(teamDirectory, { recursive: true })
  const registration = await hub.ensureRunRegistered({
    workspaceRoot,
    statePath: join(teamDirectory, 'run.yaml'),
    allowedRoots: [workspaceRoot],
    registryRoots: [],
    actorId: 'multicode-app',
  })
  assert.ok(registration.runToken, 'a real run registration returns a run token')
  assert.equal(handle.status().state, 'running', 'kernel status reflects the demand-spawned hub')
  assert.equal(kernel.sidecarStatuses()[0].moduleId, 'sprint-engine')

  const beforeDisable = await hub.callRunTool({
    runId: registration.runId,
    toolName: 'sprintengine.help',
    arguments: { role: 'architect', agentId: 'architect', topic: 'agent_workflow' },
  }) as { isError?: boolean }
  assert.notEqual(beforeDisable.isError, true)
  await hub.setModuleEnabled(false)
  assert.equal(hub.status().state, 'stopped', 'live module disable stops the Python process')
  await assert.rejects(
    () => hub.callRunTool({ runId: registration.runId, toolName: 'sprintengine.help' }),
    /Sprint Engine module is disabled/
  )
  await hub.setModuleEnabled(true)
  const afterReenable = await hub.callRunTool({
    runId: registration.runId,
    toolName: 'sprintengine.help',
    arguments: { role: 'architect', agentId: 'architect', topic: 'agent_workflow' },
  }) as { isError?: boolean }
  assert.notEqual(afterReenable.isError, true, 'an existing sprint connection restores its run after live re-enable')
  assert.equal(hub.status().activeRunCount, 1)

  await kernel.runShutdown()
  assert.equal(handle.status().state, 'stopped', 'kernel shutdown stops the hub process')
  assert.equal(hub.status().state, 'stopped')
  assert.deepEqual(notifications, [], 'a healthy lifecycle emits no failure notifications')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
