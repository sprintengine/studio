import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readAutomationSettings, writeAutomationSettings } from './automation-settings'
import { createMcpSocketServer, type McpToolRegistration } from './mcp-socket-server'
import { createAutomationTools, type AutomationBackends } from './automation-tools'
import type { WorkspaceSyncSnapshot } from '../../shared/workspace-sync'
import type { TerminalSessionSnapshot } from '../../shared/electron-api'
import type { AutomationRendererRequest, AutomationRendererResponse } from '../../shared/automation'
import type { Workspace } from '../../renderer/src/types/workspace'

function testWorkspace(id: string, overrides: Partial<Workspace> = {}): Workspace {
  return {
    id,
    name: `Workspace ${id}`,
    mode: 'standard',
    folderPath: null,
    templateId: 'solo',
    layoutModel: { global: {}, borders: [], layout: { type: 'row', children: [] } },
    agents: {},
    worktreeState: { containerPath: null, entries: {}, updatedAt: null },
    memory: { relativeRoot: null },
    editorState: { openFiles: [], activeFilePath: null },
    sprintEngineState: null,
    sprintEngineAutoState: {
      desiredMode: 'manual',
      runtimeState: 'idle',
      cliPermissionPreset: 'default',
      maxConcurrentAgents: 0,
      pendingSpawns: [],
      deliveredAgentNotificationEventKeys: [],
    },
    multiloopAutoState: {
      enabled: false,
      cliPermissionPreset: 'default',
      maxConcurrentAgents: 0,
      pendingSpawns: [],
    },
    createdAt: 1,
    ...overrides,
  }
}

function snapshotOf(workspaces: Workspace[]): WorkspaceSyncSnapshot {
  return {
    sequence: 1,
    state: {
      workspaces,
      activeWorkspaceId: workspaces[0]?.id ?? null,
      primaryWorkspaceWindowId: 'primary',
      workspaceWindows: [
        {
          id: 'primary',
          kind: 'primary',
          workspaceIds: workspaces.map((workspace) => workspace.id),
          activeWorkspaceId: workspaces[0]?.id ?? null,
          bounds: null,
          isMaximized: false,
          displayId: null,
          createdAt: 0,
          lastFocusedAt: 0,
        },
      ],
    },
  }
}

type BackendsOverrides = {
  workspaces?: Workspace[]
  sessions?: TerminalSessionSnapshot[]
  delegate?: (request: AutomationRendererRequest) => Promise<AutomationRendererResponse>
}

function backendsOf(overrides: BackendsOverrides = {}): AutomationBackends {
  return {
    getWorkspaceSyncSnapshot: () => snapshotOf(overrides.workspaces ?? []),
    listTerminalSessions: () => overrides.sessions ?? [],
    delegateToRenderer:
      overrides.delegate
      ?? (async () => ({ ok: false, code: 'no_primary_window', message: 'no window in test' })),
    // Confirmation polling is exercised against static snapshots; collapse the
    // wait so timeout paths run instantly.
    sleep: async () => {},
    now: (() => {
      let tick = 0
      return () => (tick += 30_000)
    })(),
  }
}

function tool(tools: McpToolRegistration[], name: string): McpToolRegistration {
  const found = tools.find((candidate) => candidate.name === name)
  assert.ok(found, `tool ${name} is registered`)
  return found
}

async function testSettingsDefaultOffAndRoundTrip(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'multicode-automation-settings-'))
  try {
    const missing = readAutomationSettings(dir)
    assert.equal(missing.settings.enabled, false, 'missing settings file means disabled')
    assert.equal(missing.error, null)

    writeAutomationSettings(dir, { enabled: true })
    const enabled = readAutomationSettings(dir)
    assert.equal(enabled.settings.enabled, true)

    writeFileSync(join(dir, 'automation-settings.json'), 'not json')
    const malformed = readAutomationSettings(dir)
    assert.equal(malformed.settings.enabled, false, 'malformed settings fail closed (disabled)')
    assert.match(malformed.error ?? '', /not valid JSON/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function testToolListNamesTheV1Surface(): Promise<void> {
  const tools = createAutomationTools(backendsOf())
  assert.deepEqual(
    tools.map((registration) => registration.name).sort(),
    ['agent.launch', 'agent.status', 'workspace.create', 'workspace.list', 'workspace.status']
  )
}

async function testReadToolsAnswerFromSnapshot(): Promise<void> {
  const workspace = testWorkspace('ws-1')
  workspace.agents['agent-a'] = {
    id: 'agent-a',
    name: 'Scout',
    status: 'idle',
    execution: { mode: 'current_workspace', worktreeId: null, cwd: null },
    messages: [],
    streamBuffer: '',
    runtimeKind: 'terminal',
    cli: 'claude-code',
    cliSessionId: 'session-1',
    cliStartRequested: true,
    cliHasLaunched: true,
  } as Workspace['agents'][string]
  const placeholder = testWorkspace('ws-old', { templateId: 'workspace-sync-routing-placeholder' })
  const sessions: TerminalSessionSnapshot[] = [
    {
      sessionId: 'session-1',
      processAlive: true,
      kind: 'agent',
      workspaceId: 'ws-1',
      agentId: 'agent-a',
      visible: true,
      startedAt: 10,
      lastOutputAt: 20,
      lastInputAt: null,
      lastVisibleAt: null,
      activity: { kind: 'idle', since: 20 },
    } as unknown as TerminalSessionSnapshot,
  ]
  const tools = createAutomationTools(backendsOf({ workspaces: [workspace, placeholder], sessions }))

  const list = await tool(tools, 'workspace.list').handler({})
  assert.equal(list.isError, undefined)
  const listed = list.structuredContent as { workspaces: Array<{ id: string; detail: string }> }
  assert.equal(listed.workspaces.length, 2)
  assert.equal(listed.workspaces.find((entry) => entry.id === 'ws-old')?.detail, 'routing-only')
  assert.equal(listed.workspaces.find((entry) => entry.id === 'ws-1')?.detail, 'full')

  const status = await tool(tools, 'agent.status').handler({ workspaceId: 'ws-1', agentId: 'agent-a' })
  assert.equal(status.isError, undefined)
  const agent = (status.structuredContent as { agent: { terminal: { processAlive: boolean } | null; cli: string } }).agent
  assert.equal(agent.cli, 'claude-code')
  assert.equal(agent.terminal?.processAlive, true)
}

async function testInvalidRequestsReturnExplicitErrors(): Promise<void> {
  const tools = createAutomationTools(backendsOf({ workspaces: [testWorkspace('ws-1')] }))

  const unknownWorkspace = await tool(tools, 'workspace.status').handler({ workspaceId: 'nope' })
  assert.equal(unknownWorkspace.isError, true)
  assert.match(JSON.stringify(unknownWorkspace.structuredContent), /unknown_workspace/)

  const malformed = await tool(tools, 'workspace.status').handler({ workspaceId: 42 })
  assert.equal(malformed.isError, true)
  assert.match(JSON.stringify(malformed.structuredContent), /invalid_arguments/)

  const unknownAgent = await tool(tools, 'agent.status').handler({ workspaceId: 'ws-1', agentId: 'ghost' })
  assert.equal(unknownAgent.isError, true)
  assert.match(JSON.stringify(unknownAgent.structuredContent), /unknown_agent/)

  const badLaunchArg = await tool(tools, 'agent.launch').handler({ workspaceId: 'ws-1', cli: 7 })
  assert.equal(badLaunchArg.isError, true)

  const launchUnknownWorkspace = await tool(tools, 'agent.launch').handler({ workspaceId: 'missing' })
  assert.equal(launchUnknownWorkspace.isError, true)
  assert.match(JSON.stringify(launchUnknownWorkspace.structuredContent), /unknown_workspace/)
}

async function testCreateDelegatesAndConfirmsOnTheBus(): Promise<void> {
  // The delegate "creates" the workspace by inserting it into the snapshot the
  // backends serve — modeling the renderer dispatching workspace.created.
  const workspaces: Workspace[] = []
  const requests: AutomationRendererRequest[] = []
  const backends: AutomationBackends = {
    ...backendsOf({ workspaces }),
    getWorkspaceSyncSnapshot: () => snapshotOf(workspaces),
    delegateToRenderer: async (request) => {
      requests.push(request)
      workspaces.push(testWorkspace('ws-new', { name: 'Created via automation' }))
      return { ok: true, workspaceId: 'ws-new' }
    },
  }
  const tools = createAutomationTools(backends)
  const created = await tool(tools, 'workspace.create').handler({ name: 'Created via automation' })
  assert.equal(created.isError, undefined, 'create succeeds once the bus shows the workspace')
  assert.equal((created.structuredContent as { workspace: { id: string } }).workspace.id, 'ws-new')
  assert.deepEqual(requests, [{ kind: 'workspace.create', name: 'Created via automation', folderPath: undefined, templateId: undefined }])
}

async function testCreateNeverFakesSuccessWithoutBusConfirmation(): Promise<void> {
  const backends = backendsOf({
    delegate: async () => ({ ok: true, workspaceId: 'ws-ghost' }),
  })
  const tools = createAutomationTools(backends)
  const created = await tool(tools, 'workspace.create').handler({})
  assert.equal(created.isError, true, 'renderer ok without bus confirmation is an explicit error')
  assert.match(JSON.stringify(created.structuredContent), /bus_confirmation_timeout/)
}

async function testDelegateFailurePassesThrough(): Promise<void> {
  const backends = backendsOf({
    delegate: async () => ({ ok: false, code: 'no_primary_window', message: 'closed' }),
  })
  const tools = createAutomationTools(backends)
  const created = await tool(tools, 'workspace.create').handler({})
  assert.equal(created.isError, true)
  assert.match(JSON.stringify(created.structuredContent), /no_primary_window/)
}

async function testSocketServerSpeaksMcpAndOnlyWhenStarted(): Promise<void> {
  const socketPath = join(mkdtempSync(join(tmpdir(), 'multicode-automation-sock-')), 'automation.sock')
  const echoTool: McpToolRegistration = {
    name: 'workspace.list',
    description: 'test tool',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => ({ content: [{ type: 'text', text: '{}' }], structuredContent: { workspaces: [] } }),
  }
  const server = createMcpSocketServer({
    socketPath,
    serverName: 'multicode-automation',
    serverVersion: '0.0.0-test',
    tools: [echoTool],
  })

  // Not started → nothing listens.
  await assert.rejects(
    () =>
      new Promise<void>((resolve, reject) => {
        const probe = connect(socketPath)
        probe.once('connect', () => {
          probe.destroy()
          resolve()
        })
        probe.once('error', reject)
      }),
    /ENOENT|ECONNREFUSED/,
    'no listener before start'
  )

  await server.start()
  try {
    const socket = connect(socketPath)
    socket.setEncoding('utf8')
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve())
      socket.once('error', reject)
    })

    const responses: Array<Record<string, unknown>> = []
    let buffer = ''
    socket.on('data', (chunk: string) => {
      buffer += chunk
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line) responses.push(JSON.parse(line))
        newline = buffer.indexOf('\n')
      }
    })
    const waitForResponses = async (count: number): Promise<void> => {
      const deadline = Date.now() + 5_000
      while (responses.length < count) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${count} responses (got ${responses.length})`)
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    }

    socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } })}\n`)
    socket.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
    socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`)
    socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'workspace.list', arguments: {} } })}\n`)
    socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'bogus.tool' } })}\n`)
    socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'no/such/method' })}\n`)
    socket.write('this is not json\n')
    await waitForResponses(6)

    const byId = new Map(responses.map((response) => [response.id, response]))
    const init = byId.get(1) as { result: { protocolVersion: string; serverInfo: { name: string }; capabilities: { tools: object } } }
    assert.equal(init.result.protocolVersion, '2025-03-26')
    assert.equal(init.result.serverInfo.name, 'multicode-automation')
    assert.ok(init.result.capabilities.tools)

    const tools = byId.get(2) as { result: { tools: Array<{ name: string }> } }
    assert.deepEqual(tools.result.tools.map((entry) => entry.name), ['workspace.list'])

    const call = byId.get(3) as { result: { structuredContent: { workspaces: unknown[] } } }
    assert.deepEqual(call.result.structuredContent.workspaces, [])

    const unknownTool = byId.get(4) as { error: { code: number; message: string } }
    assert.equal(unknownTool.error.code, -32602)
    assert.match(unknownTool.error.message, /Unknown tool/)

    const unknownMethod = byId.get(5) as { error: { code: number } }
    assert.equal(unknownMethod.error.code, -32601)

    const parseError = byId.get(null) as { error: { code: number } }
    assert.equal(parseError.error.code, -32700)

    socket.destroy()
  } finally {
    await server.stop()
  }

  // Stopped → the socket file is gone and nothing listens again.
  await assert.rejects(
    () =>
      new Promise<void>((resolve, reject) => {
        const probe = connect(socketPath)
        probe.once('connect', () => {
          probe.destroy()
          resolve()
        })
        probe.once('error', reject)
      }),
    /ENOENT|ECONNREFUSED/,
    'no listener after stop'
  )
}

async function testStaleSocketFileIsReplacedOnStart(): Promise<void> {
  if (process.platform === 'win32') return
  const dir = mkdtempSync(join(tmpdir(), 'multicode-automation-stale-'))
  const socketPath = join(dir, 'automation.sock')
  writeFileSync(socketPath, '')
  const server = createMcpSocketServer({
    socketPath,
    serverName: 'multicode-automation',
    serverVersion: '0.0.0-test',
    tools: [],
  })
  await server.start()
  assert.equal(server.isRunning(), true, 'stale socket file does not block startup')
  await server.stop()
  rmSync(dir, { recursive: true, force: true })
}

const tests = [
  testSettingsDefaultOffAndRoundTrip,
  testToolListNamesTheV1Surface,
  testReadToolsAnswerFromSnapshot,
  testInvalidRequestsReturnExplicitErrors,
  testCreateDelegatesAndConfirmsOnTheBus,
  testCreateNeverFakesSuccessWithoutBusConfirmation,
  testDelegateFailurePassesThrough,
  testSocketServerSpeaksMcpAndOnlyWhenStarted,
  testStaleSocketFileIsReplacedOnStart,
]

async function main(): Promise<void> {
  let failures = 0
  for (const test of tests) {
    try {
      await test()
      console.log(`ok - ${test.name}`)
    } catch (error) {
      failures += 1
      console.error(`not ok - ${test.name}`)
      console.error(error)
    }
  }
  if (failures > 0) {
    console.error(`\n${failures} test(s) failed`)
    process.exit(1)
  }
  console.log('automation.test.ts: ok')
}

void main()
