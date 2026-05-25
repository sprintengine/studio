import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSprintEngineMcpHubService } from './sprintengine-mcp-hub'

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
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
