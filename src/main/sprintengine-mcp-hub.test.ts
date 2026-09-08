import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir } from 'node:fs/promises'
import { createServer, type IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
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
  const slowProcess = createFakeHubProcess()
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
  await testStatelessSingleRequestToolCall()
  await testKernelOwnedSidecarLifecycle()
}

type RecordedRequest = {
  method: string
  path: string
  headers: IncomingHttpHeaders
  body: unknown
}

// The 2026-07-28 wire contract (item 2141): exactly ONE `POST /mcp` per tool
// call — no initialize, no session DELETE — carrying the declared version in
// both the header and `_meta`, plus the SEP-2243 routing headers. Driven
// against a stub server rather than the real engine because what is pinned
// here is the request COUNT and shape, which a successful call cannot show.
async function testStatelessSingleRequestToolCall(): Promise<void> {
  const requests: RecordedRequest[] = []
  let mcpResponse: { status: number; body: string } = {
    status: 200,
    body: JSON.stringify({ jsonrpc: '2.0', id: 'call', result: { content: [{ type: 'text', text: 'ok' }] } }),
  }
  const stub = createServer((request, response) => {
    let raw = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => {
      raw += chunk
    })
    request.on('end', () => {
      const path = (request.url || '').split('?', 1)[0]
      requests.push({
        method: request.method || '',
        path,
        headers: request.headers,
        body: raw ? JSON.parse(raw) : null,
      })
      if (request.method === 'POST' && path === '/mcp/runs') {
        const body = JSON.stringify({ runId: (JSON.parse(raw) as { runId: string }).runId, runToken: 'stub-run-token' })
        response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) })
        response.end(body)
        return
      }
      if (request.method === 'POST' && path === '/mcp') {
        response.writeHead(mcpResponse.status, {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(mcpResponse.body),
        })
        response.end(mcpResponse.body)
        return
      }
      response.writeHead(404, { 'Content-Length': 0 })
      response.end()
    })
  })
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve))
  const port = (stub.address() as AddressInfo).port

  const child = createFakeHubProcess()
  const service = createSprintEngineMcpHubService({
    runtimeRoot: () => process.cwd(),
    spawnProcess: (() => child) as never,
  })
  try {
    const started = service.ensureStarted()
    child.stderr.emit('data', Buffer.from(`${JSON.stringify({ transport: 'http', host: '127.0.0.1', port, path: '/mcp' })}\n`))
    await started

    const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-mcp-hub-stateless-'))
    const teamDirectory = join(workspaceRoot, '.multi-code', 'sprintengine', 'team')
    await mkdir(teamDirectory, { recursive: true })
    const registration = await service.ensureRunRegistered({
      workspaceRoot,
      statePath: join(teamDirectory, 'run.yaml'),
      allowedRoots: [workspaceRoot],
      registryRoots: [],
      actorId: 'multicode-app',
    })

    requests.length = 0
    const result = await service.callRunTool({
      runId: registration.runId,
      toolName: 'sprintengine.help',
      arguments: { topic: 'agent_workflow' },
    }) as { content?: Array<{ text?: string }> }
    assert.equal(result.content?.[0]?.text, 'ok', 'the single response body is unwrapped to its JSON-RPC result')

    // Drain before counting: the session DELETE this replaced was fire-and-forget
    // (`void deleteMcpSession(...)` in a finally), so it would have landed AFTER
    // the call resolved. Counting immediately would not have caught it coming back.
    await new Promise((resolve) => setTimeout(resolve, 25))
    assert.equal(requests.length, 1, `a tool call is exactly one HTTP request, got ${JSON.stringify(requests.map((entry) => `${entry.method} ${entry.path}`))}`)
    const [call] = requests
    assert.equal(call.method, 'POST')
    assert.equal(call.path, '/mcp')
    assert.equal(call.headers.authorization, 'Bearer stub-run-token')
    assert.equal(call.headers['mcp-protocol-version'], '2026-07-28')
    assert.equal(call.headers['mcp-method'], 'tools/call')
    assert.equal(call.headers['mcp-name'], 'sprintengine.help')
    assert.equal(call.headers['mcp-session-id'], undefined, 'a stateless call carries no session header')
    assert.deepEqual(call.body, {
      jsonrpc: '2.0',
      id: (call.body as { id: string }).id,
      method: 'tools/call',
      params: {
        name: 'sprintengine.help',
        arguments: { topic: 'agent_workflow' },
        _meta: {
          protocolVersion: '2026-07-28',
          clientInfo: { name: 'multicode-main', version: '1' },
        },
      },
    })
    assert.match((call.body as { id: string }).id, /^call-\d+$/)

    // A JSON-RPC error body arrives on a 200 and must still throw: the tool
    // failed, and returning the envelope would read as a success upstream.
    requests.length = 0
    mcpResponse = {
      status: 200,
      body: JSON.stringify({ jsonrpc: '2.0', id: 'call', error: { code: 'tool_not_permitted_for_role', message: 'nope' } }),
    }
    await assert.rejects(
      () => service.callRunTool({ runId: registration.runId, toolName: 'sprintengine.help' }),
      /sprintengine\.help failed: tool_not_permitted_for_role: nope/
    )
    assert.equal(requests.length, 1, 'a failing call is still one request')

    requests.length = 0
    mcpResponse = { status: 400, body: JSON.stringify({ error: 'unsupported_protocol_version', message: 'no' }) }
    await assert.rejects(
      () => service.callRunTool({ runId: registration.runId, toolName: 'sprintengine.help' }),
      /Sprint Engine MCP JSON-RPC call failed with HTTP 400 \(unsupported_protocol_version: no\)/
    )
    assert.equal(requests.length, 1, 'a non-200 call is still one request')
  } finally {
    await service.stop()
    await new Promise<void>((resolve, reject) => stub.close((error) => (error ? reject(error) : resolve())))
  }
}

type FakeHubProcess = EventEmitter & {
  stderr: EventEmitter
  killed: boolean
  pid: number
  kill(): boolean
}

function createFakeHubProcess(): FakeHubProcess {
  const child = new EventEmitter() as FakeHubProcess
  child.stderr = new EventEmitter()
  child.killed = false
  child.pid = 4242
  child.kill = () => {
    child.killed = true
    setTimeout(() => child.emit('exit', 0), 0)
    return true
  }
  return child
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
  const kernel = createMainKernel({ handle: () => undefined } as unknown as Parameters<typeof createMainKernel>[0])
  const notifications = kernel.recentNotifications()
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
