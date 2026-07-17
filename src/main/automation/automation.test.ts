import assert from 'node:assert/strict'
import type { BrowserWindow } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readAutomationSettings, writeAutomationSettings } from './automation-settings'
import { createMcpSocketServer, type McpToolRegistration } from './mcp-socket-server'
import { createAutomationTools, type AutomationBackends } from './automation-tools'
import { createRendererAutomationDelegate } from './renderer-delegate'
import type { WorkspaceSyncSnapshot } from '../../shared/workspace-sync'
import type {
  SprintEngineTaskCommentInput,
  SprintEngineTaskCreateInput,
  SprintEngineTaskResolveInput,
  SprintEngineTaskStatusSetInput,
  SprintEngineTaskUpdateInput,
  TerminalSessionSnapshot,
} from '../../shared/electron-api'
import type { SprintEngineArtifactReviewPayload } from '../ipc/sprintengine-ipc'
import type { AutomationRendererRequest, AutomationRendererResponse } from '../../shared/automation'
import type { LoadedPlugin } from '../../shared/plugin-manifest'
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
  listBacklogItems?: AutomationBackends['listBacklogItems']
  readBacklogItem?: AutomationBackends['readBacklogItem']
  listAutomationDefinitions?: AutomationBackends['listAutomationDefinitions']
  listAutomationRuns?: AutomationBackends['listAutomationRuns']
  backlogWrite?: Partial<AutomationBackends['backlogWrite']>
  getAutomationsFrontDoor?: AutomationBackends['getAutomationsFrontDoor']
  listSprintRunStatePaths?: AutomationBackends['listSprintRunStatePaths']
  readSprintEngineProjection?: AutomationBackends['readSprintEngineProjection']
  readSprintAutomationMode?: AutomationBackends['readSprintAutomationMode']
  setSprintAutomationMode?: AutomationBackends['setSprintAutomationMode']
  resumeSprintRun?: AutomationBackends['resumeSprintRun']
  cancelSprintRun?: AutomationBackends['cancelSprintRun']
  reviewSprintArtifact?: AutomationBackends['reviewSprintArtifact']
  commentSprintTask?: AutomationBackends['commentSprintTask']
  resolveSprintTaskInput?: AutomationBackends['resolveSprintTaskInput']
  setSprintTaskStatus?: AutomationBackends['setSprintTaskStatus']
  createSprintTask?: AutomationBackends['createSprintTask']
  updateSprintTask?: AutomationBackends['updateSprintTask']
  createSprintPullRequest?: AutomationBackends['createSprintPullRequest']
  refreshSprintPullRequestStatus?: AutomationBackends['refreshSprintPullRequestStatus']
  readSprintTokenUsage?: AutomationBackends['readSprintTokenUsage']
  createAgentWorktree?: AutomationBackends['createAgentWorktree']
  listPlugins?: AutomationBackends['listPlugins']
  ensureBuiltinSkillInstalled?: AutomationBackends['ensureBuiltinSkillInstalled']
}

function unexpectedCall(name: string): () => never {
  return () => {
    throw new Error(`unexpected backlogWrite.${name} call`)
  }
}

function backendsOf(overrides: BackendsOverrides = {}): AutomationBackends {
  return {
    getWorkspaceSyncSnapshot: () => snapshotOf(overrides.workspaces ?? []),
    listTerminalSessions: () => overrides.sessions ?? [],
    delegateToRenderer:
      overrides.delegate
      ?? (async () => ({ ok: false, code: 'no_primary_window', message: 'no window in test' })),
    listBacklogItems: overrides.listBacklogItems ?? (async () => ({ ok: true, key: null, items: [] })),
    readBacklogItem:
      overrides.readBacklogItem ?? (async (_root, relativePath) => ({ ok: false, message: `no item ${relativePath}` })),
    listAutomationDefinitions: overrides.listAutomationDefinitions ?? (async () => ({ ok: true, values: [] })),
    listAutomationRuns: overrides.listAutomationRuns ?? (async () => ({ ok: true, values: [] })),
    backlogWrite: {
      createItem: unexpectedCall('createItem'),
      createEpic: unexpectedCall('createEpic'),
      updateStatus: unexpectedCall('updateStatus'),
      updateType: unexpectedCall('updateType'),
      updateTriage: unexpectedCall('updateTriage'),
      updateEpic: unexpectedCall('updateEpic'),
      addOrUpdateLink: unexpectedCall('addOrUpdateLink'),
      ...overrides.backlogWrite,
    },
    getAutomationsFrontDoor: overrides.getAutomationsFrontDoor ?? (() => null),
    listSprintRunStatePaths: overrides.listSprintRunStatePaths ?? (async () => []),
    readSprintEngineProjection:
      overrides.readSprintEngineProjection ?? (async () => ({ ok: false, message: 'no projection in test' })),
    readSprintAutomationMode: overrides.readSprintAutomationMode ?? (async () => ({ ok: true, record: null })),
    setSprintAutomationMode:
      overrides.setSprintAutomationMode
      ?? (async () => {
        throw new Error('unexpected setSprintAutomationMode call')
      }),
    resumeSprintRun:
      overrides.resumeSprintRun
      ?? (() => {
        throw new Error('unexpected resumeSprintRun call')
      }),
    cancelSprintRun:
      overrides.cancelSprintRun
      ?? (async () => {
        throw new Error('unexpected cancelSprintRun call')
      }),
    reviewSprintArtifact:
      overrides.reviewSprintArtifact
      ?? (async () => {
        throw new Error('unexpected reviewSprintArtifact call')
      }),
    commentSprintTask:
      overrides.commentSprintTask
      ?? (async () => {
        throw new Error('unexpected commentSprintTask call')
      }),
    resolveSprintTaskInput:
      overrides.resolveSprintTaskInput
      ?? (async () => {
        throw new Error('unexpected resolveSprintTaskInput call')
      }),
    setSprintTaskStatus:
      overrides.setSprintTaskStatus
      ?? (async () => {
        throw new Error('unexpected setSprintTaskStatus call')
      }),
    createSprintTask:
      overrides.createSprintTask
      ?? (async () => {
        throw new Error('unexpected createSprintTask call')
      }),
    updateSprintTask:
      overrides.updateSprintTask
      ?? (async () => {
        throw new Error('unexpected updateSprintTask call')
      }),
    createSprintPullRequest:
      overrides.createSprintPullRequest
      ?? (async () => {
        throw new Error('unexpected createSprintPullRequest call')
      }),
    refreshSprintPullRequestStatus:
      overrides.refreshSprintPullRequestStatus
      ?? (async () => {
        throw new Error('unexpected refreshSprintPullRequestStatus call')
      }),
    readSprintTokenUsage:
      overrides.readSprintTokenUsage
      ?? (async () => {
        throw new Error('unexpected readSprintTokenUsage call')
      }),
    createAgentWorktree:
      overrides.createAgentWorktree
      ?? (async ({ workspaceRoot, name }) => ({
        worktreePath: `${workspaceRoot}/.multicode-worktrees/${name}`,
        branch: `agent/${name}`,
      })),
    listPlugins: overrides.listPlugins ?? (() => []),
    ensureBuiltinSkillInstalled: overrides.ensureBuiltinSkillInstalled ?? (async () => true),
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

async function testToolListNamesTheToolSurface(): Promise<void> {
  const tools = createAutomationTools(backendsOf())
  assert.deepEqual(
    tools.map((registration) => registration.name).sort(),
    [
      'agent.launch',
      'agent.status',
      'automation.create',
      'automation.list',
      'automation.run',
      'automation.runs',
      'backlog.assign',
      'backlog.create',
      'backlog.list',
      'backlog.read',
      'backlog.update',
      'backlog.work',
      'sprint.artifact.approve',
      'sprint.artifact.request_changes',
      'sprint.cancel',
      'sprint.create',
      'sprint.list',
      'sprint.pr.create',
      'sprint.pr.status',
      'sprint.resume',
      'sprint.set_mode',
      'sprint.status',
      'sprint.task.comment',
      'sprint.task.create',
      'sprint.task.resolve_input',
      'sprint.task.set_status',
      'sprint.task.update',
      'sprint.token_usage',
      'workspace.create',
      'workspace.list',
      'workspace.status',
    ]
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

// Wires a workspace + delegate that simulate a confirmed launch: the delegate
// records the request, inserts the agent into the (mutated) workspace, and
// registers a live terminal session so the handler's bus-confirmation probe
// passes. Returns the request log and the worktree-creation call log.
function launchHarness(overrides: BackendsOverrides = {}): {
  tools: ReturnType<typeof createAutomationTools>
  requests: AutomationRendererRequest[]
  worktreeCalls: Array<{ workspaceRoot: string; name: string }>
} {
  const workspace = testWorkspace('ws-1', { folderPath: '/tmp/project-a' })
  const sessions: TerminalSessionSnapshot[] = []
  const requests: AutomationRendererRequest[] = []
  const worktreeCalls: Array<{ workspaceRoot: string; name: string }> = []
  const backends: AutomationBackends = {
    ...backendsOf({ workspaces: [workspace], sessions, ...overrides }),
    getWorkspaceSyncSnapshot: () => snapshotOf([workspace]),
    listTerminalSessions: () => sessions,
    createAgentWorktree:
      overrides.createAgentWorktree
      ?? (async (input) => {
        worktreeCalls.push(input)
        return { worktreePath: `${input.workspaceRoot}/.multicode-worktrees/${input.name}`, branch: `agent/${input.name}` }
      }),
    delegateToRenderer:
      overrides.delegate
      ?? (async (request) => {
        requests.push(request)
        const agentId = 'agent-claude-abc'
        workspace.agents[agentId] = { id: agentId, name: 'Scout', cli: 'claude-code', cliSessionId: 'sess-1' } as never
        sessions.push({
          sessionId: 'sess-1',
          kind: 'agent',
          workspaceId: 'ws-1',
          agentId,
          processAlive: true,
          startedAt: 1,
          lastOutputAt: 1,
        } as never)
        return { ok: true, workspaceId: (request as { workspaceId: string }).workspaceId, agentId }
      }),
  }
  return { tools: createAutomationTools(backends), requests, worktreeCalls }
}

async function testAgentLaunchWidensConfigAndIsolation(): Promise<void> {
  // bypass_all is refused at the boundary with its own code — never delegated.
  const bypass = launchHarness()
  const refused = await tool(bypass.tools, 'agent.launch').handler({
    workspaceId: 'ws-1',
    permissionPreset: 'bypass_all',
  })
  assert.equal(refused.isError, true)
  assert.equal(
    (refused.structuredContent as { error: { code: string } }).error.code,
    'permission_preset_not_allowed'
  )
  assert.equal(bypass.requests.length, 0, 'a refused preset never reaches the renderer')

  // An out-of-vocabulary preset is a plain invalid_arguments failure.
  const badPreset = await tool(launchHarness().tools, 'agent.launch').handler({
    workspaceId: 'ws-1',
    permissionPreset: 'root',
  })
  assert.equal((badPreset.structuredContent as { error: { code: string } }).error.code, 'invalid_arguments')

  // The full config is forwarded verbatim; no worktree requested ⇒ no creation.
  const configured = launchHarness()
  const okConfig = await tool(configured.tools, 'agent.launch').handler({
    workspaceId: 'ws-1',
    cli: 'claude-code',
    name: 'Scout',
    prompt: 'go',
    cliModel: 'opus',
    permissionPreset: 'auto_workspace',
    specialistId: 'security-reviewer',
  })
  assert.equal(okConfig.isError, undefined, JSON.stringify(okConfig.structuredContent))
  assert.equal(configured.worktreeCalls.length, 0, 'no worktree requested ⇒ createAgentWorktree not called')
  const req = configured.requests[0] as Extract<AutomationRendererRequest, { kind: 'agent.launch' }>
  assert.equal(req.cliModel, 'opus')
  assert.equal(req.permissionPreset, 'auto_workspace')
  assert.equal(req.specialistId, 'security-reviewer')
  assert.equal(req.worktreePath, undefined)
  assert.equal((okConfig.structuredContent as { worktreePath?: string }).worktreePath, undefined)

  // worktree:{} creates an agent/<name> worktree and threads its path through the
  // delegate request and the success payload.
  const isolated = launchHarness()
  const okWorktree = await tool(isolated.tools, 'agent.launch').handler({
    workspaceId: 'ws-1',
    name: 'Scout',
    worktree: {},
  })
  assert.equal(okWorktree.isError, undefined, JSON.stringify(okWorktree.structuredContent))
  assert.deepEqual(isolated.worktreeCalls, [{ workspaceRoot: '/tmp/project-a', name: 'Scout' }])
  const worktreeReq = isolated.requests[0] as Extract<AutomationRendererRequest, { kind: 'agent.launch' }>
  assert.equal(worktreeReq.worktreePath, '/tmp/project-a/.multicode-worktrees/Scout')
  assert.equal(
    (okWorktree.structuredContent as { worktreePath?: string }).worktreePath,
    '/tmp/project-a/.multicode-worktrees/Scout'
  )

  // A connector forces a worktree even without an explicit worktree request.
  const connector = launchHarness()
  const okConnector = await tool(connector.tools, 'agent.launch').handler({
    workspaceId: 'ws-1',
    name: 'Scout',
    connectorId: 'railway',
  })
  assert.equal(okConnector.isError, undefined, JSON.stringify(okConnector.structuredContent))
  assert.deepEqual(connector.worktreeCalls, [{ workspaceRoot: '/tmp/project-a', name: 'Scout' }])
  const connectorReq = connector.requests[0] as Extract<AutomationRendererRequest, { kind: 'agent.launch' }>
  assert.equal(connectorReq.connectorId, 'railway')
  assert.equal(connectorReq.worktreePath, '/tmp/project-a/.multicode-worktrees/Scout')

  // A worktree-creation failure is fatal isolation — worktree_unavailable, and
  // the launch is never delegated.
  const failed = launchHarness({ createAgentWorktree: async () => ({ error: 'not a git repository' }) })
  const denied = await tool(failed.tools, 'agent.launch').handler({ workspaceId: 'ws-1', worktree: { name: 'x' } })
  assert.equal(denied.isError, true)
  assert.equal((denied.structuredContent as { error: { code: string } }).error.code, 'worktree_unavailable')
  assert.equal(failed.requests.length, 0, 'a failed worktree never reaches the renderer')

  // A bare-string worktree (not an object) is rejected — no raw cwd surface.
  const badWorktree = await tool(launchHarness().tools, 'agent.launch').handler({
    workspaceId: 'ws-1',
    worktree: '/etc',
  })
  assert.equal((badWorktree.structuredContent as { error: { code: string } }).error.code, 'invalid_arguments')
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

async function testDelegatePreservesWorkspaceModeOnSuccess(): Promise<void> {
  // The delegate's response normalizer must pass workspaceMode through: it is
  // the renderer registry's authoritative mode, and without it the mode
  // assertion after workspace.create falls back to the sync snapshot's
  // restart-restored 'standard' placeholder, failing every automation run
  // that reuses a pre-existing Automations host.
  const sentRequestIds: string[] = []
  const findPrimaryWindow = () => ({
    webContents: {
      send: (_channel: string, requestId: string) => {
        sentRequestIds.push(requestId)
      },
    },
  }) as unknown as Pick<BrowserWindow, 'webContents'>
  const delegate = createRendererAutomationDelegate(findPrimaryWindow)

  const pending = delegate.request({ kind: 'workspace.create', folderPath: '/repo/a', mode: 'automations-host' })
  assert.equal(sentRequestIds.length, 1, 'the delegate sends the request to the primary window')
  delegate.handleResponse(sentRequestIds[0], { ok: true, workspaceId: 'ws-host', workspaceMode: 'automations-host' })
  assert.deepEqual(await pending, { ok: true, workspaceId: 'ws-host', workspaceMode: 'automations-host' })

  // A malformed workspaceMode is dropped, never forwarded.
  const malformed = delegate.request({ kind: 'workspace.create', folderPath: '/repo/a' })
  delegate.handleResponse(sentRequestIds[1], { ok: true, workspaceId: 'ws-host', workspaceMode: 42 })
  assert.deepEqual(await malformed, { ok: true, workspaceId: 'ws-host' })
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

// The stdio bridge is a standalone script (never bundled with the app), so
// these tests spawn it as a real child process. Tests run from the repo root
// via the npm script, so cwd-relative resolution is stable.
const BRIDGE_SCRIPT = join(process.cwd(), 'resources', 'automation', 'mcp-stdio-bridge.mjs')

type BridgeExit = { code: number | null; stdoutLines: Array<Record<string, unknown>>; stderr: string }

function spawnBridge(infoPath: string): {
  child: ChildProcessWithoutNullStreams
  stdoutLines: Array<Record<string, unknown>>
  stderrChunks: string[]
  exited: Promise<BridgeExit>
} {
  const child = spawn(process.execPath, [BRIDGE_SCRIPT, '--info-path', infoPath], { stdio: 'pipe' })
  const stdoutLines: Array<Record<string, unknown>> = []
  const stderrChunks: string[] = []
  let buffer = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk
    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line) stdoutLines.push(JSON.parse(line))
      newline = buffer.indexOf('\n')
    }
  })
  child.stderr.on('data', (chunk: string) => stderrChunks.push(chunk))
  const exited = new Promise<BridgeExit>((resolve) => {
    child.once('exit', (code) => resolve({ code, stdoutLines, stderr: stderrChunks.join('') }))
  })
  return { child, stdoutLines, stderrChunks, exited }
}

async function waitUntil(what: string, probe: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function testBridgePipesStdioToSocketAndExitsOnServerStop(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'multicode-automation-bridge-'))
  const socketPath = join(dir, 'automation.sock')
  const infoPath = join(dir, 'automation-server-info.json')
  const server = createMcpSocketServer({
    socketPath,
    serverName: 'multicode-automation',
    serverVersion: '0.0.0-test',
    tools: [
      {
        name: 'workspace.list',
        description: 'test tool',
        inputSchema: { type: 'object', properties: {} },
        handler: async () => ({ content: [{ type: 'text', text: '{}' }], structuredContent: { workspaces: [] } }),
      },
    ],
  })
  await server.start()
  writeFileSync(infoPath, JSON.stringify({ socketPath, protocol: 'mcp-jsonrpc-ndjson', pid: process.pid }))
  const bridge = spawnBridge(infoPath)
  try {
    bridge.child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } })}\n`
    )
    bridge.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`)
    await waitUntil('bridge responses', () => bridge.stdoutLines.length >= 2)

    const byId = new Map(bridge.stdoutLines.map((response) => [response.id, response]))
    const init = byId.get(1) as { result: { serverInfo: { name: string } } }
    assert.equal(init.result.serverInfo.name, 'multicode-automation')
    const tools = byId.get(2) as { result: { tools: Array<{ name: string }> } }
    assert.deepEqual(tools.result.tools.map((entry) => entry.name), ['workspace.list'])
  } finally {
    // Server stop closes the socket; the bridge must exit cleanly, the way MCP
    // clients expect a server shutdown to look.
    await server.stop()
  }
  const exit = await bridge.exited
  assert.equal(exit.code, 0, `bridge exits 0 on server stop (stderr: ${exit.stderr})`)
  rmSync(dir, { recursive: true, force: true })
}

async function testBridgeFailsClearlyWithoutDiscoveryFile(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'multicode-automation-bridge-off-'))
  const bridge = spawnBridge(join(dir, 'automation-server-info.json'))
  const exit = await bridge.exited
  assert.equal(exit.code, 1, 'missing discovery file is a hard failure')
  assert.match(exit.stderr, /not running|disabled/i)
  rmSync(dir, { recursive: true, force: true })
}

async function testBridgeReportsStaleDiscoveryFile(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'multicode-automation-bridge-stale-'))
  // A freshly-exited child gives a pid that is certainly not alive.
  const dead = spawn(process.execPath, ['-e', ''])
  await new Promise<void>((resolve) => dead.once('exit', () => resolve()))
  writeFileSync(
    join(dir, 'automation-server-info.json'),
    JSON.stringify({ socketPath: join(dir, 'gone.sock'), pid: dead.pid })
  )
  const bridge = spawnBridge(join(dir, 'automation-server-info.json'))
  const exit = await bridge.exited
  assert.equal(exit.code, 1)
  assert.match(exit.stderr, /stale/i)
  rmSync(dir, { recursive: true, force: true })
}

async function testReadToolsResolveWorkspaceRootThroughSnapshot(): Promise<void> {
  const seenRoots: string[] = []
  const tools = createAutomationTools(
    backendsOf({
      workspaces: [
        testWorkspace('ws-1', { folderPath: '/tmp/project-a' }),
        testWorkspace('ws-routing', { templateId: 'workspace-sync-routing-placeholder', folderPath: '/tmp/stale' }),
        testWorkspace('ws-folderless', { folderPath: null }),
      ],
      listBacklogItems: async (root) => {
        seenRoots.push(root)
        return {
          ok: true,
          key: 'MC',
          items: [
            {
              relativePath: 'backlog/2026-07-08-example.md',
              title: 'Example',
              id: 7,
              isEpic: false,
              status: 'ready',
            },
          ],
        }
      },
      listAutomationDefinitions: async (root) => {
        seenRoots.push(root)
        return { ok: true, values: [] }
      },
    })
  )

  const listed = await tool(tools, 'backlog.list').handler({ workspaceId: 'ws-1' })
  assert.equal(listed.isError, undefined)
  assert.deepEqual(listed.structuredContent, {
    workspaceKey: 'MC',
    items: [
      { relativePath: 'backlog/2026-07-08-example.md', title: 'Example', id: 7, isEpic: false, status: 'ready' },
    ],
  })

  const automations = await tool(tools, 'automation.list').handler({ workspaceId: 'ws-1' })
  assert.deepEqual(automations.structuredContent, { automations: [] })
  assert.deepEqual(seenRoots, ['/tmp/project-a', '/tmp/project-a'], 'both tools resolve the snapshot folderPath')

  const unknown = await tool(tools, 'backlog.list').handler({ workspaceId: 'nope' })
  assert.equal(unknown.isError, true)
  assert.equal((unknown.structuredContent as { error: { code: string } }).error.code, 'unknown_workspace')

  const routing = await tool(tools, 'backlog.list').handler({ workspaceId: 'ws-routing' })
  assert.equal((routing.structuredContent as { error: { code: string } }).error.code, 'workspace_without_folder')

  const folderless = await tool(tools, 'automation.list').handler({ workspaceId: 'ws-folderless' })
  assert.equal((folderless.structuredContent as { error: { code: string } }).error.code, 'workspace_without_folder')
}

async function testBacklogCreateRoutesItemsAndEpics(): Promise<void> {
  const createdItems: Array<Record<string, unknown>> = []
  const createdEpics: Array<Record<string, unknown>> = []
  const tools = createAutomationTools(
    backendsOf({
      workspaces: [testWorkspace('ws-1', { folderPath: '/tmp/project-a' })],
      backlogWrite: {
        createItem: async (input) => {
          createdItems.push(input)
          return { ok: true, id: 'backlog_x', relativePath: 'backlog/2026-07-08-new-thing.md', store: { schemaVersion: 1, items: [] } }
        },
        createEpic: async (input) => {
          createdEpics.push(input)
          return { ok: true, slug: 'new-epic', relativePath: 'backlog/epics/new-epic.md' }
        },
      },
    })
  )
  const create = tool(tools, 'backlog.create')

  const item = await create.handler({
    workspaceId: 'ws-1',
    title: 'New thing',
    description: 'Body.',
    type: 'feature',
    difficulty: 'm',
    risk: 'low',
    epic: 'things',
  })
  assert.equal(item.isError, undefined)
  assert.deepEqual(item.structuredContent, { item: { relativePath: 'backlog/2026-07-08-new-thing.md' } })
  assert.deepEqual(createdItems, [
    {
      workspaceRoot: '/tmp/project-a',
      title: 'New thing',
      description: 'Body.',
      type: 'feature',
      difficulty: 'm',
      criticality: undefined,
      risk: 'low',
      epic: 'things',
    },
  ])

  const epic = await create.handler({ workspaceId: 'ws-1', title: 'New epic', type: 'epic' })
  assert.deepEqual(epic.structuredContent, { epic: { slug: 'new-epic', relativePath: 'backlog/epics/new-epic.md' } })
  assert.deepEqual(createdEpics, [{ workspaceRoot: '/tmp/project-a', title: 'New epic' }])

  const epicWithTriage = await create.handler({ workspaceId: 'ws-1', title: 'Bad epic', type: 'epic', risk: 'low' })
  assert.equal(epicWithTriage.isError, true)
  assert.equal((epicWithTriage.structuredContent as { error: { code: string } }).error.code, 'invalid_arguments')

  const badVocabulary = await create.handler({ workspaceId: 'ws-1', title: 'Bad', difficulty: 'huge' })
  assert.equal(badVocabulary.isError, true)
  assert.match((badVocabulary.structuredContent as { error: { message: string } }).error.message, /must be one of/)
}

async function testBacklogUpdateAppliesInOrderAndStopsOnFailure(): Promise<void> {
  const calls: string[] = []
  const tools = createAutomationTools(
    backendsOf({
      workspaces: [testWorkspace('ws-1', { folderPath: '/tmp/project-a' })],
      backlogWrite: {
        updateStatus: async (input) => {
          calls.push(`status:${input.status}`)
          return { ok: true, store: { schemaVersion: 1, items: [] } }
        },
        updateType: async () => {
          calls.push('type')
          return { ok: false, message: 'Enter a valid Backlog item type.' }
        },
        updateEpic: async () => {
          calls.push('epic')
          return { ok: true, store: { schemaVersion: 1, items: [] } }
        },
      },
    })
  )
  const update = tool(tools, 'backlog.update')

  const failed = await update.handler({
    workspaceId: 'ws-1',
    path: 'backlog/example.md',
    status: 'in_progress',
    type: 'feature',
    epic: null,
  })
  assert.equal(failed.isError, true)
  assert.equal((failed.structuredContent as { error: { code: string } }).error.code, 'backlog_update_failed')
  assert.deepEqual(calls, ['status:in_progress', 'type'], 'stops at the first failing write; epic never runs')

  const empty = await update.handler({ workspaceId: 'ws-1', path: 'backlog/example.md' })
  assert.equal((empty.structuredContent as { error: { code: string } }).error.code, 'invalid_arguments')

  const nullStatus = await update.handler({ workspaceId: 'ws-1', path: 'backlog/example.md', status: null })
  assert.equal((nullStatus.structuredContent as { error: { code: string } }).error.code, 'invalid_arguments')
}

async function testBacklogAssignBuildsTheCanonicalLink(): Promise<void> {
  const linked: Array<Record<string, unknown>> = []
  const workspace = testWorkspace('ws-1', {
    folderPath: '/tmp/project-a',
    agents: {
      'agent-7': { name: 'Paddy', cli: 'claude-code' } as never,
    },
  })
  const tools = createAutomationTools(
    backendsOf({
      workspaces: [workspace],
      backlogWrite: {
        addOrUpdateLink: async (input) => {
          linked.push(input as unknown as Record<string, unknown>)
          return { ok: true, store: { schemaVersion: 1, items: [] } }
        },
      },
    })
  )
  const assign = tool(tools, 'backlog.assign')

  const assigned = await assign.handler({ workspaceId: 'ws-1', path: 'backlog/example.md', agentId: 'agent-7' })
  assert.equal(assigned.isError, undefined)
  assert.equal(linked.length, 1)
  const input = linked[0] as {
    workspaceRoot: string
    relativePath: string
    status?: unknown
    link: { id: string; moduleId: string; type: string; label: string; target: { kind: string; id: string } }
  }
  assert.equal(input.workspaceRoot, '/tmp/project-a')
  assert.equal(input.relativePath, 'backlog/example.md')
  assert.equal(input.status, undefined, 'assignment is lifecycle-neutral; it must never move item status')
  assert.equal(input.link.id, 'agent-runtime:working-agent')
  assert.equal(input.link.moduleId, 'agent-runtime')
  assert.equal(input.link.type, 'agent')
  assert.equal(input.link.label, 'Agent: Paddy')
  assert.deepEqual(
    { kind: input.link.target.kind, id: input.link.target.id },
    { kind: 'agent.terminal', id: 'ws-1/agent-7' }
  )

  const unknownAgent = await assign.handler({ workspaceId: 'ws-1', path: 'backlog/example.md', agentId: 'nope' })
  assert.equal((unknownAgent.structuredContent as { error: { code: string } }).error.code, 'unknown_agent')
}

// A minimal LoadedPlugin whose manifest carries just the id + optional
// skillIntegration backlog.work reads. `template` undefined models a CLI with no
// skill integration (the fallback path).
function fakeCliPlugin(id: string, template?: string): LoadedPlugin {
  return {
    manifest: {
      id,
      ...(template
        ? { skillIntegration: { support: 'native', harnessId: id, invocation: { fileDropTemplate: template } } }
        : {}),
    },
    source: 'bundled',
    manifestPath: `/plugins/${id}/plugin.json`,
    pluginRoot: `/plugins/${id}`,
  } as unknown as LoadedPlugin
}

async function testBacklogWorkHandsItemToAgent(): Promise<void> {
  const links: Array<Record<string, unknown>> = []
  const ensured: Array<{ workspaceRoot: string; skillId: string }> = []
  const harness = launchHarness({
    listPlugins: () => [fakeCliPlugin('claude-code', '/{{skillId}} {{path}}')],
    readBacklogItem: async (_root, relativePath) => ({
      ok: true,
      item: { relativePath, title: 'Thing', isEpic: false, status: 'ready' },
      body: 'body',
    }),
    ensureBuiltinSkillInstalled: async (workspaceRoot, skillId) => {
      ensured.push({ workspaceRoot, skillId })
      return true
    },
    backlogWrite: {
      addOrUpdateLink: async (input) => {
        links.push(input as unknown as Record<string, unknown>)
        return { ok: true, store: { schemaVersion: 1, items: [] } }
      },
    },
  })

  const worked = await tool(harness.tools, 'backlog.work').handler({
    workspaceId: 'ws-1',
    path: 'backlog/example.md',
    cli: 'claude-code',
    name: 'Scout',
    instructions: 'Focus on the failing test first.',
  })
  assert.equal(worked.isError, undefined, JSON.stringify(worked.structuredContent))
  const result = (worked.structuredContent as {
    worked: { invocation: string; skillEnsured: boolean; assigned: boolean; agentId: string; relativePath: string; warning?: string }
  }).worked
  assert.equal(result.invocation, '/backlog backlog/example.md', 'Claude plugin renders /backlog <path>')
  assert.equal(result.skillEnsured, true)
  assert.equal(result.assigned, true)
  assert.equal(result.warning, undefined)
  assert.equal(result.relativePath, 'backlog/example.md')
  assert.equal(result.agentId, 'agent-claude-abc')

  // The delegated startup prompt is the invocation with instructions appended.
  const req = harness.requests[0] as Extract<AutomationRendererRequest, { kind: 'agent.launch' }>
  assert.equal(req.prompt, '/backlog backlog/example.md\n\nFocus on the failing test first.')
  assert.equal(req.cli, 'claude-code')

  // The backlog skill is ensured before launch; the working-agent link is
  // written to the item and never carries a status change.
  assert.deepEqual(ensured, [{ workspaceRoot: '/tmp/project-a', skillId: 'backlog' }])
  assert.equal(links.length, 1)
  const link = links[0] as { relativePath: string; status?: unknown; link: { type: string; label: string } }
  assert.equal(link.relativePath, 'backlog/example.md')
  assert.equal(link.status, undefined, 'backlog.work never moves item status (skill contract owns lifecycle)')
  assert.equal(link.link.type, 'agent')
  assert.equal(link.link.label, 'Agent: Scout')
}

async function testBacklogWorkFallsBackAndRefusesFinishedItems(): Promise<void> {
  // A CLI without skillIntegration ⇒ plain-language fallback naming the path and
  // the lifecycle contract; with no instructions the prompt IS the fallback.
  const fallback = launchHarness({
    listPlugins: () => [fakeCliPlugin('mystery-cli')],
    readBacklogItem: async (_root, relativePath) => ({
      ok: true,
      item: { relativePath, title: 'T', isEpic: false, status: 'in_progress' },
      body: '',
    }),
    backlogWrite: { addOrUpdateLink: async () => ({ ok: true, store: { schemaVersion: 1, items: [] } }) },
  })
  const worked = await tool(fallback.tools, 'backlog.work').handler({
    workspaceId: 'ws-1',
    path: 'backlog/example.md',
    cli: 'mystery-cli',
  })
  assert.equal(worked.isError, undefined, JSON.stringify(worked.structuredContent))
  const invocation = (worked.structuredContent as { worked: { invocation: string } }).worked.invocation
  assert.match(invocation, /Work the Backlog item at backlog\/example\.md/)
  assert.match(invocation, /in_progress/)
  assert.match(invocation, /completed/)
  const req = fallback.requests[0] as Extract<AutomationRendererRequest, { kind: 'agent.launch' }>
  assert.equal(req.prompt, invocation, 'no instructions ⇒ prompt is exactly the fallback invocation')

  // completed and archived items are refused and never launched.
  for (const [item, path] of [
    [{ relativePath: 'backlog/done.md', title: 'D', isEpic: false, status: 'completed' as const }, 'backlog/done.md'],
    [{ relativePath: 'backlog/archived/old.md', title: 'O', isEpic: false, status: 'ready' as const }, 'backlog/archived/old.md'],
  ] as const) {
    const refuse = launchHarness({ readBacklogItem: async () => ({ ok: true, item, body: '' }) })
    const refused = await tool(refuse.tools, 'backlog.work').handler({ workspaceId: 'ws-1', path })
    assert.equal((refused.structuredContent as { error: { code: string } }).error.code, 'backlog_item_not_workable')
    assert.equal(refuse.requests.length, 0, 'a non-workable item is never launched')
  }

  // A missing/invalid path is not_found (and never launched).
  const missing = launchHarness({ readBacklogItem: async () => ({ ok: false, message: 'no such item' }) })
  const notFound = await tool(missing.tools, 'backlog.work').handler({ workspaceId: 'ws-1', path: 'backlog/gone.md' })
  assert.equal((notFound.structuredContent as { error: { code: string } }).error.code, 'backlog_item_not_found')
  assert.equal(missing.requests.length, 0)
}

async function testBacklogWorkPresetGuardAndPostLaunchLinkFailure(): Promise<void> {
  // bypass_all is refused at the boundary — before any read or launch.
  const bypass = launchHarness({
    readBacklogItem: async (_root, relativePath) => ({
      ok: true,
      item: { relativePath, title: 'T', isEpic: false, status: 'ready' },
      body: '',
    }),
  })
  const refused = await tool(bypass.tools, 'backlog.work').handler({
    workspaceId: 'ws-1',
    path: 'backlog/example.md',
    permissionPreset: 'bypass_all',
  })
  assert.equal((refused.structuredContent as { error: { code: string } }).error.code, 'permission_preset_not_allowed')
  assert.equal(bypass.requests.length, 0, 'a refused preset never launches')

  // A link-write failure AFTER a confirmed launch is not overall failure: the
  // agent is already running, so the tool returns ok + assigned:false + warning.
  // A non-fatal skill-ensure failure rides skillEnsured:false in the same call.
  const linkFail = launchHarness({
    listPlugins: () => [fakeCliPlugin('claude-code', '/{{skillId}} {{path}}')],
    ensureBuiltinSkillInstalled: async () => false,
    readBacklogItem: async (_root, relativePath) => ({
      ok: true,
      item: { relativePath, title: 'T', isEpic: false, status: 'ready' },
      body: '',
    }),
    backlogWrite: { addOrUpdateLink: async () => ({ ok: false, message: 'items.json is read-only' }) },
  })
  const worked = await tool(linkFail.tools, 'backlog.work').handler({
    workspaceId: 'ws-1',
    path: 'backlog/example.md',
    cli: 'claude-code',
  })
  assert.equal(worked.isError, undefined, 'a post-launch link failure is not overall failure')
  const result = (worked.structuredContent as {
    worked: { assigned: boolean; warning?: string; skillEnsured: boolean; agentId: string }
  }).worked
  assert.equal(result.assigned, false)
  assert.equal(result.skillEnsured, false, 'a non-fatal skill-ensure failure rides skillEnsured')
  assert.match(result.warning ?? '', /read-only/)
  assert.equal(result.agentId, 'agent-claude-abc', 'the launched agent id is still reported')
  assert.equal(linkFail.requests.length, 1, 'the agent was launched exactly once')
}

async function testAutomationMutationToolsGateOnPresetAndModule(): Promise<void> {
  const created: unknown[] = []
  const ran: unknown[] = []
  const withFrontDoor = createAutomationTools(
    backendsOf({
      workspaces: [testWorkspace('ws-1', { folderPath: '/tmp/project-a' })],
      getAutomationsFrontDoor: () => ({
        createDefinition: async (input) => {
          created.push(input)
          return { ok: true, value: { id: 'auto-1', name: 'Nightly' } as never }
        },
        runNow: async (input) => {
          ran.push(input)
          return { ok: true, value: { definition: { id: 'auto-1' }, run: { runId: 'run-1' } } as never }
        },
      }),
    })
  )

  const definition = {
    name: 'Nightly',
    trigger: { kind: 'schedule', config: { cadence: 'daily' } },
    action: { kind: 'spawn-agent', config: { prompt: 'do it', permissionPreset: 'auto_workspace' } },
  }
  const ok = await tool(withFrontDoor, 'automation.create').handler({ workspaceId: 'ws-1', definition })
  assert.equal(ok.isError, undefined)
  assert.deepEqual(created, [{ workspaceRoot: '/tmp/project-a', definition }])
  assert.deepEqual(ok.structuredContent, { automation: { id: 'auto-1', name: 'Nightly' } })

  const okRun = await tool(withFrontDoor, 'automation.run').handler({ workspaceId: 'ws-1', automationId: 'auto-1' })
  assert.deepEqual(ran, [{ workspaceRoot: '/tmp/project-a', automationId: 'auto-1' }])
  assert.deepEqual(okRun.structuredContent, { definition: { id: 'auto-1' }, run: { runId: 'run-1' } })

  // bypass_all is refused before the front door ever sees the draft.
  const bypass = await tool(withFrontDoor, 'automation.create').handler({
    workspaceId: 'ws-1',
    definition: {
      ...definition,
      action: { kind: 'spawn-agent', config: { prompt: 'do it', permissionPreset: 'bypass_all' } },
    },
  })
  assert.equal(bypass.isError, true)
  assert.equal(
    (bypass.structuredContent as { error: { code: string } }).error.code,
    'permission_preset_not_allowed'
  )
  assert.equal(created.length, 1, 'the refused draft never reached the front door')

  // Module disabled/not loaded ⇒ explicit failure, never buffering.
  const withoutModule = createAutomationTools(
    backendsOf({ workspaces: [testWorkspace('ws-1', { folderPath: '/tmp/project-a' })] })
  )
  for (const [name, args] of [
    ['automation.create', { workspaceId: 'ws-1', definition }],
    ['automation.run', { workspaceId: 'ws-1', automationId: 'auto-1' }],
  ] as const) {
    const result = await tool(withoutModule, name).handler(args as Record<string, unknown>)
    assert.equal(result.isError, true)
    assert.equal(
      (result.structuredContent as { error: { code: string } }).error.code,
      'automations_module_unavailable'
    )
  }
}

async function testAutomationMutationToolsPassPipelineFailuresThrough(): Promise<void> {
  const tools = createAutomationTools(
    backendsOf({
      workspaces: [testWorkspace('ws-1', { folderPath: '/tmp/project-a' })],
      getAutomationsFrontDoor: () => ({
        createDefinition: async () => ({ ok: false, code: 'workspace_root_untrusted', message: 'Folder is not an open workspace.' }),
        runNow: async () => ({ ok: false, code: 'unsupported_trigger', message: 'Run now needs a schedule trigger.' }),
      }),
    })
  )
  const created = await tool(tools, 'automation.create').handler({
    workspaceId: 'ws-1',
    definition: { name: 'X', trigger: { kind: 'schedule', config: {} }, action: { kind: 'spawn-agent', config: {} } },
  })
  assert.equal((created.structuredContent as { error: { code: string } }).error.code, 'workspace_root_untrusted')

  const ran = await tool(tools, 'automation.run').handler({ workspaceId: 'ws-1', automationId: 'auto-1' })
  assert.equal((ran.structuredContent as { error: { code: string } }).error.code, 'unsupported_trigger')
}

async function testSprintReadToolsAnswerFromDisk(): Promise<void> {
  const tools = createAutomationTools(
    backendsOf({
      workspaces: [testWorkspace('ws-1', { folderPath: '/tmp/project-a' })],
      listSprintRunStatePaths: async (root) => [
        `${root}/.multi-code/sprintengine/checkout-flow/run.yaml`,
        `${root}/.multi-code/sprintengine/older-run/run.yaml`,
      ],
      readSprintEngineProjection: async (statePath) =>
        statePath === '/tmp/project-a/.multi-code/sprintengine/checkout-flow/run.yaml'
          ? { ok: true, data: { goal: 'Ship checkout', tasks: [] }, token: '123:456' }
          : { ok: false, message: `no projection at ${statePath}` },
      // sprint.status now discloses the main-owned automation mode; a run with a
      // sidecar record reports its desiredMode.
      readSprintAutomationMode: async (input) =>
        input.statePath === '/tmp/project-a/.multi-code/sprintengine/checkout-flow/run.yaml'
          ? {
              ok: true,
              record: {
                schemaVersion: 1,
                revision: 3,
                desiredMode: 'run_agents',
                changedAt: 10,
                lastWrite: { actor: 'automation', deviceId: null, at: '' },
              },
            }
          : { ok: true, record: null },
    })
  )

  const listed = await tool(tools, 'sprint.list').handler({ workspaceId: 'ws-1' })
  assert.deepEqual(listed.structuredContent, {
    runs: [
      { slug: 'checkout-flow', statePath: '.multi-code/sprintengine/checkout-flow/run.yaml' },
      { slug: 'older-run', statePath: '.multi-code/sprintengine/older-run/run.yaml' },
    ],
  })

  const status = await tool(tools, 'sprint.status').handler({ workspaceId: 'ws-1', slug: 'checkout-flow' })
  assert.deepEqual(status.structuredContent, {
    slug: 'checkout-flow',
    projection: { goal: 'Ship checkout', tasks: [] },
    changeToken: '123:456',
    automationMode: 'run_agents',
  })

  const missing = await tool(tools, 'sprint.status').handler({ workspaceId: 'ws-1', slug: 'gone' })
  assert.equal(missing.isError, true)
  assert.equal((missing.structuredContent as { error: { code: string } }).error.code, 'sprint_status_failed')

  for (const slug of ['..', 'a/b', 'a\\b', '.']) {
    const denied = await tool(tools, 'sprint.status').handler({ workspaceId: 'ws-1', slug })
    assert.equal(denied.isError, true, `slug "${slug}" is rejected`)
    assert.equal((denied.structuredContent as { error: { code: string } }).error.code, 'invalid_arguments')
  }
}

async function testSprintCreateDelegatesAndConfirms(): Promise<void> {
  const requests: AutomationRendererRequest[] = []
  let workspaceVisible = false
  let architectAlive = false
  // What the next delegate call sets the live-session flag to — lets the
  // timeout path model a run whose architect never comes up.
  let nextArchitectAlive = true
  const workspace = testWorkspace('ws-sprint', { folderPath: '/tmp/project-a', mode: 'sprintengine' as never })
  const session: TerminalSessionSnapshot = {
    sessionId: 'pty-1',
    kind: 'agent',
    workspaceId: 'ws-sprint',
    agentId: 'agent-architect',
    processAlive: true,
    startedAt: 1,
    lastOutputAt: 1,
  } as never
  const tools = createAutomationTools({
    ...backendsOf(),
    getWorkspaceSyncSnapshot: () => snapshotOf(workspaceVisible ? [workspace] : []),
    listTerminalSessions: () => (architectAlive ? [session] : []),
    delegateToRenderer: async (request) => {
      requests.push(request)
      workspaceVisible = true
      architectAlive = nextArchitectAlive
      return { ok: true, workspaceId: 'ws-sprint' }
    },
  })

  const started = await tool(tools, 'sprint.create').handler({
    folderPath: '/tmp/project-a',
    goal: 'Ship checkout',
    startRunner: true,
  })
  assert.equal(started.isError, undefined, JSON.stringify(started.structuredContent))
  assert.deepEqual(started.structuredContent, { workspaceId: 'ws-sprint', started: true })
  assert.deepEqual(requests, [
    {
      kind: 'sprint.create',
      folderPath: '/tmp/project-a',
      goal: 'Ship checkout',
      name: undefined,
      startRunner: true,
      autoApproveArtifacts: false,
      useWorktrees: false,
    },
  ])

  // A started run with no live agent session inside the budget is an explicit
  // launch_confirmation_timeout, never a fake success.
  nextArchitectAlive = false
  const unconfirmed = await tool(tools, 'sprint.create').handler({
    folderPath: '/tmp/project-a',
    goal: 'Ship checkout',
    startRunner: true,
  })
  assert.equal(unconfirmed.isError, true)
  assert.equal(
    (unconfirmed.structuredContent as { error: { code: string } }).error.code,
    'launch_confirmation_timeout'
  )

  // A manual run confirms on the workspace alone — nothing was launched.
  const manual = await tool(tools, 'sprint.create').handler({ folderPath: '/tmp/project-a', goal: 'Ship checkout' })
  assert.deepEqual(manual.structuredContent, { workspaceId: 'ws-sprint', started: false })

  // Delegate failures pass through verbatim (no window, controller errors).
  const failing = createAutomationTools({
    ...backendsOf(),
    delegateToRenderer: async () => ({ ok: false, code: 'sprint_team_exists', message: 'That team already exists.' }),
  })
  const failed = await tool(failing, 'sprint.create').handler({ folderPath: '/tmp/p', goal: 'g' })
  assert.equal((failed.structuredContent as { error: { code: string } }).error.code, 'sprint_team_exists')
}

async function testSprintLifecycleToolsMutateViaMainServices(): Promise<void> {
  const statePath = '/tmp/project-a/.multi-code/sprintengine/checkout-flow/run.yaml'
  const setModeInputs: Array<{ statePath: string; mode: string; actor: string; reason?: string }> = []
  let resumed: string | null = null
  const cancelPayloads: string[] = []
  const projectionRuns = new Set([statePath])

  function toolsFor(cancelResult: () => Promise<unknown>): McpToolRegistration[] {
    return createAutomationTools(
      backendsOf({
        workspaces: [testWorkspace('ws-1', { folderPath: '/tmp/project-a' })],
        readSprintEngineProjection: async (path) =>
          projectionRuns.has(path)
            ? { ok: true, data: { goal: 'Ship checkout', tasks: [] }, token: '1:2' }
            : { ok: false, message: `no run at ${path}` },
        setSprintAutomationMode: async (input) => {
          setModeInputs.push({ statePath: input.statePath, mode: input.mode, actor: input.actor, reason: input.reason })
          // Model idempotence: manual on a manual run is unchanged.
          const changed = input.mode !== 'manual'
          return {
            ok: true,
            changed,
            record: {
              schemaVersion: 1,
              revision: 2,
              desiredMode: input.mode,
              changedAt: 5,
              lastWrite: { actor: input.actor, deviceId: null, at: '' },
            },
          } as never
        },
        resumeSprintRun: (path) => {
          resumed = path
        },
        cancelSprintRun: async (payload) => {
          cancelPayloads.push(payload.statePath)
          return cancelResult() as never
        },
      })
    )
  }

  const tools = toolsFor(async () => ({ ok: true, data: {} }))

  // set_mode forwards the exact SetSprintEngineAutomationModeInput shape:
  // reconstructed statePath, actor 'automation', reason, and never a caller path.
  const set = await tool(tools, 'sprint.set_mode').handler({ workspaceId: 'ws-1', slug: 'checkout-flow', mode: 'run_agents' })
  assert.equal(set.isError, undefined, JSON.stringify(set.structuredContent))
  assert.deepEqual(set.structuredContent, { mode: 'run_agents', changed: true })
  assert.deepEqual(setModeInputs, [{ statePath, mode: 'run_agents', actor: 'automation', reason: 'automation-server' }])

  // Same-mode (manual) write is idempotent: changed:false echoed through.
  const paused = await tool(tools, 'sprint.set_mode').handler({ workspaceId: 'ws-1', slug: 'checkout-flow', mode: 'manual' })
  assert.deepEqual(paused.structuredContent, { mode: 'manual', changed: false })

  // 'paused' is not a real mode — rejected before any backend call.
  const badMode = await tool(tools, 'sprint.set_mode').handler({ workspaceId: 'ws-1', slug: 'checkout-flow', mode: 'paused' })
  assert.equal(badMode.isError, true)
  assert.equal((badMode.structuredContent as { error: { code: string } }).error.code, 'invalid_arguments')

  // Unknown run → sprint_not_found (projection read fails).
  const unknown = await tool(tools, 'sprint.set_mode').handler({ workspaceId: 'ws-1', slug: 'gone', mode: 'run_agents' })
  assert.equal((unknown.structuredContent as { error: { code: string } }).error.code, 'sprint_not_found')

  // Path-traversal slug rejected by SPRINT_SLUG_RE before resolution.
  for (const slug of ['../evil', 'a/b', '..']) {
    const denied = await tool(tools, 'sprint.set_mode').handler({ workspaceId: 'ws-1', slug, mode: 'manual' })
    assert.equal((denied.structuredContent as { error: { code: string } }).error.code, 'invalid_arguments', slug)
  }

  // resume is fire-and-forget: reports requested:true and re-arms the exact statePath.
  const resume = await tool(tools, 'sprint.resume').handler({ workspaceId: 'ws-1', slug: 'checkout-flow' })
  assert.deepEqual(resume.structuredContent, { resumed: { slug: 'checkout-flow', requested: true } })
  assert.equal(resumed, statePath)

  // cancel invokes the composed backend once and echoes the slug on success.
  const canceled = await tool(tools, 'sprint.cancel').handler({ workspaceId: 'ws-1', slug: 'checkout-flow' })
  assert.deepEqual(canceled.structuredContent, { canceled: { slug: 'checkout-flow' } })
  assert.deepEqual(cancelPayloads, [statePath])

  // A backend failure surfaces sprint_cancel_failed with the message plus stderr.
  const failingTools = toolsFor(async () => ({ ok: false, message: 'cancel op failed', stderr: 'git: index locked' }))
  const failedCancel = await tool(failingTools, 'sprint.cancel').handler({ workspaceId: 'ws-1', slug: 'checkout-flow' })
  assert.equal(failedCancel.isError, true)
  const cancelError = (failedCancel.structuredContent as { error: { code: string; message: string } }).error
  assert.equal(cancelError.code, 'sprint_cancel_failed')
  assert.match(cancelError.message, /cancel op failed/)
  assert.match(cancelError.message, /index locked/)
}

async function testSprintSteeringToolsMutateViaMainServices(): Promise<void> {
  const statePath = '/tmp/project-a/.multi-code/sprintengine/checkout-flow/run.yaml'
  const reviewCalls: Array<{ payload: SprintEngineArtifactReviewPayload; action: string }> = []
  const commentCalls: SprintEngineTaskCommentInput[] = []
  const resolveCalls: SprintEngineTaskResolveInput[] = []
  const statusCalls: SprintEngineTaskStatusSetInput[] = []
  const createCalls: SprintEngineTaskCreateInput[] = []
  const updateCalls: SprintEngineTaskUpdateInput[] = []
  const okData = { ok: true as const, data: {} }

  const tools = createAutomationTools(
    backendsOf({
      workspaces: [testWorkspace('ws-1', { folderPath: '/tmp/project-a' })],
      readSprintEngineProjection: async (path) =>
        path === statePath
          ? { ok: true, data: { goal: 'Ship', tasks: [] }, token: '1:2' }
          : { ok: false, message: `no run at ${path}` },
      reviewSprintArtifact: async (payload, action) => {
        reviewCalls.push({ payload, action })
        return okData
      },
      commentSprintTask: async (payload) => {
        commentCalls.push(payload)
        return okData
      },
      resolveSprintTaskInput: async (payload) => {
        resolveCalls.push(payload)
        return okData
      },
      setSprintTaskStatus: async (payload) => {
        statusCalls.push(payload)
        return okData
      },
      createSprintTask: async (payload) => {
        createCalls.push(payload)
        return okData
      },
      updateSprintTask: async (payload) => {
        updateCalls.push(payload)
        return okData
      },
    })
  )

  // approve forwards the reconstructed statePath + artifactId (+ optional
  // feedback); the wiring pins mode 'user', so the tool passes only the payload.
  const approved = await tool(tools, 'sprint.artifact.approve').handler({
    workspaceId: 'ws-1',
    slug: 'checkout-flow',
    artifactId: 'ART-1',
    feedback: 'looks good',
  })
  assert.equal(approved.isError, undefined, JSON.stringify(approved.structuredContent))
  assert.deepEqual(approved.structuredContent, { approved: { slug: 'checkout-flow', artifactId: 'ART-1' } })
  assert.deepEqual(reviewCalls, [
    { payload: { statePath, artifactId: 'ART-1', feedback: 'looks good' }, action: 'approve' },
  ])

  // request_changes requires non-empty feedback at the boundary — rejected
  // before any mutation backend runs.
  const noFeedback = await tool(tools, 'sprint.artifact.request_changes').handler({
    workspaceId: 'ws-1',
    slug: 'checkout-flow',
    artifactId: 'ART-1',
  })
  assert.equal((noFeedback.structuredContent as { error: { code: string } }).error.code, 'invalid_arguments')
  assert.equal(reviewCalls.length, 1, 'a missing-feedback request never reaches the backend')

  const requested = await tool(tools, 'sprint.artifact.request_changes').handler({
    workspaceId: 'ws-1',
    slug: 'checkout-flow',
    artifactId: 'ART-1',
    feedback: 'redo the plan',
  })
  assert.equal(requested.isError, undefined)
  assert.deepEqual(reviewCalls[1], {
    payload: { statePath, artifactId: 'ART-1', feedback: 'redo the plan' },
    action: 'request-changes',
  })

  const commented = await tool(tools, 'sprint.task.comment').handler({
    workspaceId: 'ws-1',
    slug: 'checkout-flow',
    taskId: 'T2',
    body: 'ping',
  })
  assert.equal(commented.isError, undefined)
  assert.deepEqual(commentCalls, [{ statePath, taskId: 'T2', body: 'ping' }])

  // resolve_input forwards complete only when the boolean is true.
  const resolved = await tool(tools, 'sprint.task.resolve_input').handler({
    workspaceId: 'ws-1',
    slug: 'checkout-flow',
    taskId: 'T2',
    resolution: 'use option B',
    complete: true,
  })
  assert.equal(resolved.isError, undefined)
  assert.deepEqual(resolveCalls, [{ statePath, taskId: 'T2', resolution: 'use option B', complete: true }])
  const badComplete = await tool(tools, 'sprint.task.resolve_input').handler({
    workspaceId: 'ws-1',
    slug: 'checkout-flow',
    taskId: 'T2',
    resolution: 'x',
    complete: 'yes',
  })
  assert.equal((badComplete.structuredContent as { error: { code: string } }).error.code, 'invalid_arguments')

  // set_status validates against the task-status union.
  const statusSet = await tool(tools, 'sprint.task.set_status').handler({
    workspaceId: 'ws-1',
    slug: 'checkout-flow',
    taskId: 'T2',
    status: 'in_progress',
  })
  assert.equal(statusSet.isError, undefined)
  assert.deepEqual(statusCalls, [{ statePath, taskId: 'T2', status: 'in_progress' }])
  const badStatus = await tool(tools, 'sprint.task.set_status').handler({
    workspaceId: 'ws-1',
    slug: 'checkout-flow',
    taskId: 'T2',
    status: 'archived',
  })
  assert.equal((badStatus.structuredContent as { error: { code: string } }).error.code, 'invalid_arguments')

  // create forwards title + role + array fields verbatim.
  const created = await tool(tools, 'sprint.task.create').handler({
    workspaceId: 'ws-1',
    slug: 'checkout-flow',
    title: 'New task',
    role: 'developer',
    description: 'do it',
    acceptanceCriteria: ['passes tests'],
    implementationNotes: ['touch the handler'],
  })
  assert.equal(created.isError, undefined, JSON.stringify(created.structuredContent))
  assert.deepEqual(createCalls, [
    {
      statePath,
      title: 'New task',
      role: 'developer',
      description: 'do it',
      acceptanceCriteria: ['passes tests'],
      implementationNotes: ['touch the handler'],
    },
  ])

  // A role outside the mutation-role union is rejected before the backend.
  const badRole = await tool(tools, 'sprint.task.create').handler({
    workspaceId: 'ws-1',
    slug: 'checkout-flow',
    title: 'x',
    role: 'reviewer',
  })
  assert.equal((badRole.structuredContent as { error: { code: string } }).error.code, 'invalid_arguments')
  assert.equal(createCalls.length, 1, 'a bad role never reaches the backend')

  // A bare string where an array is required is rejected, never spread.
  const bareArray = await tool(tools, 'sprint.task.create').handler({
    workspaceId: 'ws-1',
    slug: 'checkout-flow',
    title: 'x',
    role: 'developer',
    acceptanceCriteria: 'one string',
  })
  assert.equal((bareArray.structuredContent as { error: { code: string } }).error.code, 'invalid_arguments')
  assert.equal(createCalls.length, 1, 'a bare-string array field never reaches the backend')

  const updated = await tool(tools, 'sprint.task.update').handler({
    workspaceId: 'ws-1',
    slug: 'checkout-flow',
    taskId: 'T2',
    title: 'Renamed',
    role: 'frontend',
    notes: ['see thread'],
  })
  assert.equal(updated.isError, undefined)
  assert.deepEqual(updateCalls, [{ statePath, taskId: 'T2', title: 'Renamed', role: 'frontend', notes: ['see thread'] }])

  // Unknown run → sprint_not_found (projection read fails) before the mutation.
  const unknownRun = await tool(tools, 'sprint.task.comment').handler({
    workspaceId: 'ws-1',
    slug: 'gone',
    taskId: 'T2',
    body: 'hi',
  })
  assert.equal((unknownRun.structuredContent as { error: { code: string } }).error.code, 'sprint_not_found')

  // A backend {ok:false} surfaces the tool's _failed code with the message and
  // any stderr intact.
  const failing = createAutomationTools(
    backendsOf({
      workspaces: [testWorkspace('ws-1', { folderPath: '/tmp/project-a' })],
      readSprintEngineProjection: async () => ({ ok: true, data: { goal: 'g', tasks: [] }, token: '1:2' }),
      reviewSprintArtifact: async () => ({ ok: false, message: 'artifact already approved', stderr: 'engine: conflict' }),
    })
  )
  const failed = await tool(failing, 'sprint.artifact.approve').handler({
    workspaceId: 'ws-1',
    slug: 'checkout-flow',
    artifactId: 'ART-1',
  })
  assert.equal(failed.isError, true)
  const error = (failed.structuredContent as { error: { code: string; message: string } }).error
  assert.equal(error.code, 'sprint_artifact_approve_failed')
  assert.match(error.message, /already approved/)
  assert.match(error.message, /engine: conflict/)
}

async function testSprintVcsAndUsageToolsReadViaMainServices(): Promise<void> {
  const statePath = '/tmp/project-a/.multi-code/sprintengine/checkout-flow/run.yaml'
  const prCreateCalls: string[] = []
  const prStatusCalls: string[] = []
  const usageCalls: string[] = []
  const vcsBlock = {
    mode: 'run_worktree',
    worktreePath: '.multicode-worktrees/checkout-flow',
    branchName: 'sprint/checkout-flow',
    pullRequestUrl: 'https://github.com/x/y/pull/1',
    pullRequestState: 'open',
    repos: [],
  }
  const usageReport = {
    run: {
      perModel: [],
      total: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0, split: true },
      coverage: { measuredAgents: 1, unmeasuredAgents: 0, unmeasured: [] },
    },
    perAgent: [],
    perTask: {},
    computedAt: 'test-time',
  }

  const tools = createAutomationTools(
    backendsOf({
      workspaces: [testWorkspace('ws-1', { folderPath: '/tmp/project-a' })],
      readSprintEngineProjection: async (path) =>
        path === statePath
          ? { ok: true, data: { goal: 'g', tasks: [] }, token: '1:2' }
          : { ok: false, message: `no run at ${path}` },
      createSprintPullRequest: async (payload) => {
        prCreateCalls.push(payload.statePath)
        return { ok: true, data: { projectionContent: JSON.stringify({ goal: 'g', vcs: vcsBlock }), projectionToken: '3:4' } }
      },
      refreshSprintPullRequestStatus: async (payload) => {
        prStatusCalls.push(payload.statePath)
        return {
          ok: true,
          data: { projectionContent: JSON.stringify({ vcs: { ...vcsBlock, pullRequestState: 'merged' } }), projectionToken: '5:6' },
        }
      },
      readSprintTokenUsage: async (path) => {
        usageCalls.push(path)
        return usageReport
      },
    })
  )

  // pr.create forwards the reconstructed statePath and hands back the refreshed
  // vcs block parsed from the command result's re-read projection.
  const created = await tool(tools, 'sprint.pr.create').handler({ workspaceId: 'ws-1', slug: 'checkout-flow' })
  assert.equal(created.isError, undefined, JSON.stringify(created.structuredContent))
  assert.deepEqual(created.structuredContent, { pr: { slug: 'checkout-flow' }, vcs: vcsBlock })
  assert.deepEqual(prCreateCalls, [statePath])

  // pr.status refreshes then returns the merge state from the re-read projection.
  const status = await tool(tools, 'sprint.pr.status').handler({ workspaceId: 'ws-1', slug: 'checkout-flow' })
  assert.equal(status.isError, undefined, JSON.stringify(status.structuredContent))
  assert.equal((status.structuredContent as { vcs: { pullRequestState: string } }).vcs.pullRequestState, 'merged')
  assert.deepEqual(prStatusCalls, [statePath])

  // token_usage returns the report verbatim under tokenUsage.
  const usage = await tool(tools, 'sprint.token_usage').handler({ workspaceId: 'ws-1', slug: 'checkout-flow' })
  assert.equal(usage.isError, undefined, JSON.stringify(usage.structuredContent))
  assert.deepEqual(usage.structuredContent, { slug: 'checkout-flow', tokenUsage: usageReport })
  assert.deepEqual(usageCalls, [statePath])

  // Unknown run → sprint_not_found before the usage compute (no invented empty report).
  const unknown = await tool(tools, 'sprint.token_usage').handler({ workspaceId: 'ws-1', slug: 'gone' })
  assert.equal((unknown.structuredContent as { error: { code: string } }).error.code, 'sprint_not_found')
  assert.equal(usageCalls.length, 1, 'a missing run never reaches the usage compute')

  // Path-traversal slug rejected by SPRINT_SLUG_RE before any resolution.
  const denied = await tool(tools, 'sprint.pr.create').handler({ workspaceId: 'ws-1', slug: '../evil' })
  assert.equal((denied.structuredContent as { error: { code: string } }).error.code, 'invalid_arguments')
  assert.equal(prCreateCalls.length, 1, 'a bad slug never reaches the PR backend')

  // A non-worktree run's refusal is the engine's ({ok:false}); the tool surfaces
  // sprint_pr_failed with the message + stderr, never pre-empting it at the tool layer.
  const refusing = createAutomationTools(
    backendsOf({
      workspaces: [testWorkspace('ws-1', { folderPath: '/tmp/project-a' })],
      readSprintEngineProjection: async () => ({ ok: true, data: { goal: 'g', tasks: [] }, token: '1:2' }),
      createSprintPullRequest: async () => ({
        ok: false,
        message: 'This run has no worktree to open a pull request from.',
        stderr: 'engine: no worktree',
      }),
    })
  )
  const refused = await tool(refusing, 'sprint.pr.create').handler({ workspaceId: 'ws-1', slug: 'checkout-flow' })
  assert.equal(refused.isError, true)
  const prError = (refused.structuredContent as { error: { code: string; message: string } }).error
  assert.equal(prError.code, 'sprint_pr_failed')
  assert.match(prError.message, /no worktree/)
  assert.match(prError.message, /engine: no worktree/)
}

async function testReadToolsPassServiceFailuresThrough(): Promise<void> {
  const tools = createAutomationTools(
    backendsOf({
      workspaces: [testWorkspace('ws-1', { folderPath: '/tmp/project-a' })],
      readBacklogItem: async () => ({ ok: false, message: 'Backlog item backlog/gone.md does not exist in this workspace.' }),
      listAutomationRuns: async () => ({
        ok: false,
        errors: [{ code: 'io_error', message: 'runs folder unreadable' } as never],
      }),
    })
  )

  const read = await tool(tools, 'backlog.read').handler({ workspaceId: 'ws-1', path: 'backlog/gone.md' })
  assert.equal(read.isError, true)
  const readError = (read.structuredContent as { error: { code: string; message: string } }).error
  assert.equal(readError.code, 'backlog_read_failed')
  assert.match(readError.message, /does not exist/)

  const runs = await tool(tools, 'automation.runs').handler({ workspaceId: 'ws-1', automationId: 'auto-1' })
  assert.equal(runs.isError, true)
  const runsError = (runs.structuredContent as { error: { code: string; message: string } }).error
  assert.equal(runsError.code, 'automations_unavailable')
  assert.match(runsError.message, /runs folder unreadable/)

  // Missing/blank arguments stay explicit invalid_arguments failures.
  const missing = await tool(tools, 'automation.runs').handler({ workspaceId: 'ws-1' })
  assert.equal((missing.structuredContent as { error: { code: string } }).error.code, 'invalid_arguments')
}

const tests = [
  testSettingsDefaultOffAndRoundTrip,
  testToolListNamesTheToolSurface,
  testReadToolsAnswerFromSnapshot,
  testReadToolsResolveWorkspaceRootThroughSnapshot,
  testReadToolsPassServiceFailuresThrough,
  testBacklogCreateRoutesItemsAndEpics,
  testBacklogUpdateAppliesInOrderAndStopsOnFailure,
  testBacklogAssignBuildsTheCanonicalLink,
  testBacklogWorkHandsItemToAgent,
  testBacklogWorkFallsBackAndRefusesFinishedItems,
  testBacklogWorkPresetGuardAndPostLaunchLinkFailure,
  testAutomationMutationToolsGateOnPresetAndModule,
  testAutomationMutationToolsPassPipelineFailuresThrough,
  testSprintReadToolsAnswerFromDisk,
  testSprintCreateDelegatesAndConfirms,
  testSprintLifecycleToolsMutateViaMainServices,
  testSprintSteeringToolsMutateViaMainServices,
  testSprintVcsAndUsageToolsReadViaMainServices,
  testAgentLaunchWidensConfigAndIsolation,
  testInvalidRequestsReturnExplicitErrors,
  testCreateDelegatesAndConfirmsOnTheBus,
  testCreateNeverFakesSuccessWithoutBusConfirmation,
  testDelegateFailurePassesThrough,
  testDelegatePreservesWorkspaceModeOnSuccess,
  testSocketServerSpeaksMcpAndOnlyWhenStarted,
  testStaleSocketFileIsReplacedOnStart,
  testBridgePipesStdioToSocketAndExitsOnServerStop,
  testBridgeFailsClearlyWithoutDiscoveryFile,
  testBridgeReportsStaleDiscoveryFile,
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
