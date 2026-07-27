import assert from 'node:assert/strict'
import type { BrowserWindow } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { readAutomationSettings, writeAutomationSettings } from './automation-settings'
import {
  AUTOMATION_SERVER_INFO_FILENAME,
  createAutomationService,
  resolveSocketPath,
  STUDIO_MCP_SERVER_INFO_FILENAME,
} from './automation-service'
import { createMcpSocketServer, type McpConnectionContext, type McpToolRegistration } from './mcp-socket-server'
import { createAutomationTools, type AutomationBackends } from './automation-tools'
import { createRendererAutomationDelegate } from './renderer-delegate'
import { createGatewayAuditStore, STUDIO_GATEWAY_AUDIT_FILENAME } from './gateway-audit'
import { createReviewGatewayTools, createStudioGatewayTools, isStudioGatewayMutation } from './studio-gateway-tools'
import { reviewChangeSetDir } from '../review/changeset-service'
import type { BriefRunEvent } from '../review/brief-run-service'
import { validateReviewBrief, type ReviewBrief, type ReviewChangeSet } from '../../shared/review'
import { SPRINTENGINE_TOOL_NAMES } from '../../shared/sprintengineToolNames.generated'
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
  getRoadmapFrontDoor?: AutomationBackends['getRoadmapFrontDoor']
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
      updateStatus: unexpectedCall('updateStatus'),
      updateType: unexpectedCall('updateType'),
      updateTriage: unexpectedCall('updateTriage'),
      updateEpic: unexpectedCall('updateEpic'),
      addOrUpdateLink: unexpectedCall('addOrUpdateLink'),
      repairIntegrity: unexpectedCall('repairIntegrity'),
      ...overrides.backlogWrite,
    },
    getAutomationsFrontDoor: overrides.getAutomationsFrontDoor ?? (() => null),
    getRoadmapFrontDoor: overrides.getRoadmapFrontDoor ?? (() => null),
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

// The connection context a Studio-launched agent's bridge presents; backlog
// tools default their target project from this advisory identity.
function agentContext(workspaceId: string): McpConnectionContext {
  return { metadata: { kind: 'studio-agent', workspaceId } }
}

async function testSettingsDefaultOnAndRoundTrip(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'multicode-automation-settings-'))
  try {
    const missing = readAutomationSettings(dir)
    assert.equal(missing.settings.enabled, true, 'missing settings file means the Studio MCP is enabled')
    assert.equal(missing.error, null)

    writeAutomationSettings(dir, { enabled: true })
    const enabled = readAutomationSettings(dir)
    assert.equal(enabled.settings.enabled, true)

    writeFileSync(join(dir, 'automation-settings.json'), 'not json')
    const malformed = readAutomationSettings(dir)
    assert.equal(malformed.settings.enabled, true, 'malformed legacy settings cannot disable the Studio MCP')
    assert.match(malformed.error ?? '', /not valid JSON/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function testStudioGatewayStartsDespiteLegacyDisabledSetting(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'multicode-studio-mcp-service-'))
  try {
    writeAutomationSettings(dir, { enabled: false })
    const service = createAutomationService({
      resolveUserDataDir: () => dir,
      appVersion: '0.0.0-test',
      resolveBridgeScriptPath: () => BRIDGE_SCRIPT,
      tools: [],
      sprintEngineMcpHub: {
        callRunTool: async () => {
          throw new Error('unexpected run proxy call')
        },
      },
    })
    const started = await service.initialize()
    assert.equal(started.enabled, true)
    assert.equal(started.running, true)
    assert.equal(existsSync(join(dir, STUDIO_MCP_SERVER_INFO_FILENAME)), true)
    assert.equal(existsSync(join(dir, AUTOMATION_SERVER_INFO_FILENAME)), true)

    const compatibilityDisable = await service.setEnabled(false)
    assert.equal(compatibilityDisable.enabled, true)
    assert.equal(compatibilityDisable.running, true, 'legacy toggle cannot disable the agent MCP contract')
    await service.shutdown()
    assert.equal(existsSync(join(dir, STUDIO_MCP_SERVER_INFO_FILENAME)), false)
    assert.equal(existsSync(join(dir, AUTOMATION_SERVER_INFO_FILENAME)), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function testStudioGatewayEndpointContractAcrossPlatforms(): Promise<void> {
  const windows = resolveSocketPath('C:\\Users\\test\\AppData\\Roaming\\multicode', 'win32')
  assert.match(windows, /^\\\\\.\\pipe\\multicode-automation-[a-f0-9]{12}$/)
  const mac = resolveSocketPath('/Users/test/Library/Application Support/multicode', 'darwin')
  assert.equal(mac, '/Users/test/Library/Application Support/multicode/automation.sock')
  const linux = resolveSocketPath('/home/test/.config/multicode', 'linux')
  assert.equal(linux, '/home/test/.config/multicode/automation.sock')
  const longLinux = resolveSocketPath(`/home/test/${'nested/'.repeat(20)}multicode`, 'linux', '/tmp')
  assert.match(longLinux, /^\/tmp\/multicode-automation-[a-f0-9]{12}\.sock$/)
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
      'backlog.list',
      'backlog.read',
      'backlog.repair',
      'backlog.update',
      'backlog.work',
      'roadmap.add_step',
      'roadmap.approve',
      'roadmap.merge',
      'roadmap.pause',
      'roadmap.remove_step',
      'roadmap.reorder',
      'roadmap.resume',
      'roadmap.skip',
      'roadmap.status',
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

  // MC-1903: a routing placeholder with no live agent is the unactionable
  // graveyard — workspace.list omits it entirely.
  const list = await tool(tools, 'workspace.list').handler({})
  assert.equal(list.isError, undefined)
  const listed = list.structuredContent as { workspaces: Array<{ id: string; detail: string }> }
  assert.equal(listed.workspaces.length, 1)
  assert.equal(listed.workspaces[0]?.id, 'ws-1')
  assert.equal(listed.workspaces[0]?.detail, 'full')

  // A placeholder whose agent terminal survived the restart is the current
  // Studio-owned session: it stays listed, disclosed as routing-only.
  const liveOldSession = {
    sessionId: 'session-old',
    processAlive: true,
    kind: 'agent',
    workspaceId: 'ws-old',
    agentId: 'agent-old',
    visible: true,
    startedAt: 10,
    lastOutputAt: 20,
    lastInputAt: null,
    lastVisibleAt: null,
    activity: { kind: 'idle', since: 20 },
  } as unknown as TerminalSessionSnapshot
  const toolsWithLivePlaceholder = createAutomationTools(
    backendsOf({ workspaces: [workspace, placeholder], sessions: [...sessions, liveOldSession] })
  )
  const listWithLive = await tool(toolsWithLivePlaceholder, 'workspace.list').handler({})
  const listedWithLive = listWithLive.structuredContent as { workspaces: Array<{ id: string; detail: string }> }
  assert.equal(listedWithLive.workspaces.length, 2)
  assert.equal(listedWithLive.workspaces.find((entry) => entry.id === 'ws-old')?.detail, 'routing-only')

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
  let attributedAgentId: string | undefined
  const echoTool: McpToolRegistration = {
    name: 'workspace.list',
    description: 'test tool',
    inputSchema: { type: 'object', properties: {} },
    handler: async (_args, context) => {
      attributedAgentId = context?.metadata.agentId
      return { content: [{ type: 'text', text: '{}' }], structuredContent: { workspaces: [] } }
    },
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

    socket.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'sprintengine.studio/connect', params: { agentId: 'agent-a', workspaceId: 'ws-1' } })}\n`)
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
    assert.equal(attributedAgentId, 'agent-a', 'connection metadata is applied before the first tool call')

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

function spawnBridge(infoPath: string, env: NodeJS.ProcessEnv = process.env): {
  child: ChildProcessWithoutNullStreams
  stdoutLines: Array<Record<string, unknown>>
  stderrChunks: string[]
  exited: Promise<BridgeExit>
} {
  const child = spawn(process.execPath, [BRIDGE_SCRIPT, '--info-path', infoPath], { stdio: 'pipe', env })
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

async function testConcurrentBridgesKeepResponsesAndAttributionIsolated(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'multicode-studio-mcp-concurrency-'))
  const socketPath = join(dir, 'automation.sock')
  const infoPath = join(dir, STUDIO_MCP_SERVER_INFO_FILENAME)
  const server = createMcpSocketServer({
    socketPath,
    serverName: 'sprintengine-studio',
    serverVersion: '0.0.0-test',
    tools: [{
      name: 'agent.identity',
      description: 'test attribution',
      inputSchema: { type: 'object' },
      handler: async (args, context) => {
        if (typeof args.delayMs === 'number') await new Promise((resolve) => setTimeout(resolve, args.delayMs as number))
        const agentId = context?.metadata.agentId ?? 'external-local'
        return { content: [{ type: 'text', text: agentId }], structuredContent: { agentId } }
      },
    }],
  })
  await server.start()
  writeFileSync(infoPath, JSON.stringify({ socketPath, protocol: 'mcp-jsonrpc-ndjson', pid: process.pid }))
  const first = spawnBridge(infoPath, { ...process.env, MULTICODE_AGENT_ID: 'agent-first' })
  const second = spawnBridge(infoPath, { ...process.env, MULTICODE_AGENT_ID: 'agent-second' })
  try {
    for (const bridge of [first, second]) {
      bridge.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`)
    }
    first.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'agent.identity', arguments: { delayMs: 40 } } })}\n`)
    second.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'agent.identity', arguments: {} } })}\n`)
    await waitUntil('two independent bridge responses', () => first.stdoutLines.length >= 2 && second.stdoutLines.length >= 2)
    const firstCall = first.stdoutLines.find((response) => response.id === 2) as { result: { structuredContent: { agentId: string } } }
    const secondCall = second.stdoutLines.find((response) => response.id === 2) as { result: { structuredContent: { agentId: string } } }
    assert.equal(firstCall.result.structuredContent.agentId, 'agent-first')
    assert.equal(secondCall.result.structuredContent.agentId, 'agent-second')
  } finally {
    await server.stop()
  }
  const [firstExit, secondExit] = await Promise.all([first.exited, second.exited])
  assert.equal(firstExit.code, 0)
  assert.equal(secondExit.code, 0)
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

  // Backlog reads default to the connection's own workspace — no id argument.
  const listed = await tool(tools, 'backlog.list').handler({}, agentContext('ws-1'))
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

  // An explicit projectRoot addresses any folder directly — external callers
  // are not gated on the app's workspace registry.
  const external = await tool(tools, 'backlog.list').handler({ projectRoot: '/tmp/external-clone' })
  assert.equal(external.isError, undefined, 'projectRoot works without any connection identity')
  assert.equal(seenRoots[2], '/tmp/external-clone')

  const relative = await tool(tools, 'backlog.list').handler({ projectRoot: 'not/absolute' })
  assert.equal((relative.structuredContent as { error: { code: string } }).error.code, 'invalid_arguments')

  // No projectRoot and no resolvable connection workspace ⇒ a clear failure.
  const bare = await tool(tools, 'backlog.list').handler({})
  assert.equal((bare.structuredContent as { error: { code: string } }).error.code, 'project_root_required')
  const unknown = await tool(tools, 'backlog.list').handler({}, agentContext('nope'))
  assert.equal((unknown.structuredContent as { error: { code: string } }).error.code, 'project_root_required')

  // A restart-restored routing placeholder still resolves for the very agent
  // connected from it — the connection itself is the liveness proof.
  const routing = await tool(tools, 'backlog.list').handler({}, agentContext('ws-routing'))
  assert.equal(routing.isError, undefined, 'a connected agent may use its restored folder route')
  assert.equal(seenRoots[3], '/tmp/stale')

  const folderless = await tool(tools, 'automation.list').handler({ workspaceId: 'ws-folderless' })
  assert.equal((folderless.structuredContent as { error: { code: string } }).error.code, 'workspace_without_folder')
}

async function testBacklogRepairRoutesOnlyValidatedIntegrityOperations(): Promise<void> {
  const repairs: Array<Record<string, unknown>> = []
  const tools = createAutomationTools(
    backendsOf({
      workspaces: [testWorkspace('ws-1', { folderPath: '/tmp/project-a' })],
      backlogWrite: {
        repairIntegrity: async (input) => {
          repairs.push(input)
          return {
            ok: true,
            relativePath: input.relativePath,
            issue: input.issue,
            ...(input.issue === 'duplicate_id'
              ? { previousNumericId: 1741, numericId: 1744 }
              : { replacements: 1 }),
          }
        },
      },
    })
  )
  const repair = tool(tools, 'backlog.repair')
  const repaired = await repair.handler(
    { path: 'backlog/example.md', issue: 'duplicate_id' },
    agentContext('ws-1')
  )
  assert.equal(repaired.isError, undefined)
  assert.deepEqual(repairs, [{
    workspaceRoot: '/tmp/project-a',
    relativePath: 'backlog/example.md',
    issue: 'duplicate_id',
  }])
  assert.deepEqual(repaired.structuredContent, {
    repaired: {
      ok: true,
      relativePath: 'backlog/example.md',
      issue: 'duplicate_id',
      previousNumericId: 1741,
      numericId: 1744,
    },
  })

  const invalid = await repair.handler({ path: 'backlog/example.md', issue: 'rewrite_body' }, agentContext('ws-1'))
  assert.equal(invalid.isError, true)
  assert.equal((invalid.structuredContent as { error: { code: string } }).error.code, 'invalid_arguments')
  assert.equal(repairs.length, 1, 'invalid repair never reaches the writer')
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

  const failed = await update.handler(
    { path: 'backlog/example.md', status: 'in_progress', type: 'feature', epic: null },
    agentContext('ws-1')
  )
  assert.equal(failed.isError, true)
  assert.equal((failed.structuredContent as { error: { code: string } }).error.code, 'backlog_update_failed')
  assert.deepEqual(calls, ['status:in_progress', 'type'], 'stops at the first failing write; epic never runs')

  const empty = await update.handler({ path: 'backlog/example.md' }, agentContext('ws-1'))
  assert.equal((empty.structuredContent as { error: { code: string } }).error.code, 'invalid_arguments')

  const nullStatus = await update.handler({ path: 'backlog/example.md', status: null }, agentContext('ws-1'))
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

  const assigned = await assign.handler({ path: 'backlog/example.md', agentId: 'agent-7' }, agentContext('ws-1'))
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

  const unknownAgent = await assign.handler({ path: 'backlog/example.md', agentId: 'nope' }, agentContext('ws-1'))
  assert.equal((unknownAgent.structuredContent as { error: { code: string } }).error.code, 'unknown_agent')

  // An explicit projectRoot resolves to the open workspace using that folder —
  // and refuses folders no open workspace uses (agent links need the registry).
  const byRoot = await assign.handler({
    projectRoot: '/tmp/project-a',
    path: 'backlog/example.md',
    agentId: 'agent-7',
  })
  assert.equal(byRoot.isError, undefined, 'projectRoot maps back to the open workspace record')
  assert.equal(linked.length, 2)
  const elsewhere = await assign.handler({
    projectRoot: '/tmp/not-open',
    path: 'backlog/example.md',
    agentId: 'agent-7',
  })
  assert.equal((elsewhere.structuredContent as { error: { code: string } }).error.code, 'workspace_not_open')
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

  const worked = await tool(harness.tools, 'backlog.work').handler(
    {
      path: 'backlog/example.md',
      cli: 'claude-code',
      name: 'Scout',
      instructions: 'Focus on the failing test first.',
    },
    agentContext('ws-1')
  )
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
  const worked = await tool(fallback.tools, 'backlog.work').handler(
    { path: 'backlog/example.md', cli: 'mystery-cli' },
    agentContext('ws-1')
  )
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
    const refused = await tool(refuse.tools, 'backlog.work').handler({ path }, agentContext('ws-1'))
    assert.equal((refused.structuredContent as { error: { code: string } }).error.code, 'backlog_item_not_workable')
    assert.equal(refuse.requests.length, 0, 'a non-workable item is never launched')
  }

  // A missing/invalid path is not_found (and never launched).
  const missing = launchHarness({ readBacklogItem: async () => ({ ok: false, message: 'no such item' }) })
  const notFound = await tool(missing.tools, 'backlog.work').handler({ path: 'backlog/gone.md' }, agentContext('ws-1'))
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
  const refused = await tool(bypass.tools, 'backlog.work').handler(
    { path: 'backlog/example.md', permissionPreset: 'bypass_all' },
    agentContext('ws-1')
  )
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
  const worked = await tool(linkFail.tools, 'backlog.work').handler(
    { path: 'backlog/example.md', cli: 'claude-code' },
    agentContext('ws-1')
  )
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
        // No MCP tool edits a definition (create + run only), so an update here
        // would mean the surface grew: refuse rather than fake a success.
        updateDefinition: async () => ({ ok: false, code: 'not_stubbed', message: 'No automation tool updates definitions.' }),
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
        updateDefinition: async () => ({ ok: false, code: 'not_stubbed', message: 'No automation tool updates definitions.' }),
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
  assert.deepEqual(created.structuredContent, { slug: 'checkout-flow', vcs: vcsBlock })
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

  const read = await tool(tools, 'backlog.read').handler({ path: 'backlog/gone.md' }, agentContext('ws-1'))
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

// A recording fake of the roadmap front door: captures the calls the tools forward
// and returns canned outcomes, so the tests assert wiring + arg shaping + the
// unavailable/failure paths without a live orchestrator.
function recordingRoadmapFrontDoor(overrides: {
  board?: unknown
  addStep?: (input: unknown) => Promise<{ ok: boolean; message?: string; ref?: string }>
  removeStep?: (input: unknown) => Promise<{ ok: boolean; message?: string }>
  reorderStep?: (input: unknown) => Promise<{ ok: boolean; message?: string }>
  skipStep?: (input: unknown) => Promise<{ ok: boolean; message?: string }>
  steerLane?: (lane: string, action: string, actor: string) => Promise<{ ok: boolean; message?: string }>
} = {}): { frontDoor: AutomationBackends['getRoadmapFrontDoor']; calls: unknown[] } {
  const calls: unknown[] = []
  const record = <T,>(name: string, value: T): T => {
    calls.push({ name, value })
    return value
  }
  const frontDoor = () =>
    ({
      readBoard: async () => record('readBoard', overrides.board ?? null),
      addStep: (input: unknown) => (overrides.addStep ?? (async () => ({ ok: true, ref: (input as { ref: string }).ref })))(record('addStep', input)),
      removeStep: (input: unknown) => (overrides.removeStep ?? (async () => ({ ok: true })))(record('removeStep', input)),
      reorderStep: (input: unknown) => (overrides.reorderStep ?? (async () => ({ ok: true })))(record('reorderStep', input)),
      skipStep: (input: unknown) => (overrides.skipStep ?? (async () => ({ ok: true })))(record('skipStep', input)),
      steerLane: (lane: string, action: string, actor: string) => {
        calls.push({ name: 'steerLane', value: { lane, action, actor } })
        return (overrides.steerLane ?? (async () => ({ ok: true })))(lane, action, actor)
      },
    }) as unknown as ReturnType<NonNullable<AutomationBackends['getRoadmapFrontDoor']>>
  return { frontDoor: () => frontDoor(), calls }
}

async function testRoadmapToolsReadPlanAndSteer(): Promise<void> {
  // Unavailable module: every roadmap tool reports roadmap_module_unavailable, never
  // a fake success.
  const offline = createAutomationTools(backendsOf({ getRoadmapFrontDoor: () => null }))
  const offStatus = await tool(offline, 'roadmap.status').handler({})
  assert.equal(offStatus.isError, true)
  assert.equal((offStatus.structuredContent as { error: { code: string } }).error.code, 'roadmap_module_unavailable')

  // roadmap.status forwards the board read straight through.
  const board = { roadmapRef: 'backlog/roadmaps/platform.md', title: 'Platform', lanes: [] }
  const read = recordingRoadmapFrontDoor({ board })
  const readTools = createAutomationTools(backendsOf({ getRoadmapFrontDoor: read.frontDoor }))
  const status = await tool(readTools, 'roadmap.status').handler({})
  assert.deepEqual((status.structuredContent as { roadmap: unknown }).roadmap, board)

  // add_step resolves a workspaceId to its project root and passes it as projectPath,
  // tagging the action 'automation'.
  const add = recordingRoadmapFrontDoor()
  const addTools = createAutomationTools(
    backendsOf({
      workspaces: [testWorkspace('ws-mobile', { folderPath: '/repos/mobile' })],
      getRoadmapFrontDoor: add.frontDoor,
    })
  )
  const added = await tool(addTools, 'roadmap.add_step').handler({ ref: 'backlog/foo.md', workspaceId: 'ws-mobile', lane: 'Up next' })
  assert.equal(added.isError, undefined)
  assert.deepEqual(
    add.calls.find((call) => (call as { name: string }).name === 'addStep'),
    { name: 'addStep', value: { ref: 'backlog/foo.md', projectPath: '/repos/mobile', lane: 'Up next', actor: 'automation' } }
  )

  // add_step with an unknown workspaceId fails at the tool boundary, never reaching
  // the front door.
  const addUnknown = await tool(addTools, 'roadmap.add_step').handler({ ref: 'backlog/foo.md', workspaceId: 'nope' })
  assert.equal((addUnknown.structuredContent as { error: { code: string } }).error.code, 'unknown_workspace')

  // A front-door rejection (malformed ref) surfaces as the tool's own failure code,
  // carrying the message — never fake success.
  const reject = recordingRoadmapFrontDoor({ addStep: async () => ({ ok: false, message: 'not a backlog path' }) })
  const rejectTools = createAutomationTools(backendsOf({ getRoadmapFrontDoor: reject.frontDoor }))
  const rejected = await tool(rejectTools, 'roadmap.add_step').handler({ ref: 'not-a-path' })
  assert.equal(rejected.isError, true)
  assert.equal((rejected.structuredContent as { error: { code: string; message: string } }).error.code, 'roadmap_add_step_failed')
  assert.match((rejected.structuredContent as { error: { message: string } }).error.message, /not a backlog path/)

  // reorder rejects a non-integer index at the boundary.
  const reorder = recordingRoadmapFrontDoor()
  const reorderTools = createAutomationTools(backendsOf({ getRoadmapFrontDoor: reorder.frontDoor }))
  const badIndex = await tool(reorderTools, 'roadmap.reorder').handler({ ref: 'backlog/foo.md', toIndex: 1.5 })
  assert.equal((badIndex.structuredContent as { error: { code: string } }).error.code, 'invalid_arguments')
  await tool(reorderTools, 'roadmap.reorder').handler({ ref: 'backlog/foo.md', toIndex: 2, toLane: 'Later' })
  assert.deepEqual(
    reorder.calls.find((call) => (call as { name: string }).name === 'reorderStep'),
    { name: 'reorderStep', value: { ref: 'backlog/foo.md', toIndex: 2, toLane: 'Later', actor: 'automation' } }
  )

  // skip requires a reason and forwards it.
  const skip = recordingRoadmapFrontDoor()
  const skipTools = createAutomationTools(backendsOf({ getRoadmapFrontDoor: skip.frontDoor }))
  const noReason = await tool(skipTools, 'roadmap.skip').handler({ ref: 'backlog/foo.md' })
  assert.equal((noReason.structuredContent as { error: { code: string } }).error.code, 'invalid_arguments')
  await tool(skipTools, 'roadmap.skip').handler({ ref: 'backlog/foo.md', reason: 'superseded' })
  assert.deepEqual(
    skip.calls.find((call) => (call as { name: string }).name === 'skipStep'),
    { name: 'skipStep', value: { ref: 'backlog/foo.md', reason: 'superseded', actor: 'automation' } }
  )

  // The four steer tools name a lane and forward the action + 'automation' actor.
  const steer = recordingRoadmapFrontDoor()
  const steerTools = createAutomationTools(backendsOf({ getRoadmapFrontDoor: steer.frontDoor }))
  for (const action of ['approve', 'merge', 'pause', 'resume'] as const) {
    const result = await tool(steerTools, `roadmap.${action}`).handler({ lane: 'Up next' })
    assert.equal(result.isError, undefined)
  }
  assert.deepEqual(
    steer.calls.filter((call) => (call as { name: string }).name === 'steerLane').map((call) => (call as { value: unknown }).value),
    [
      { lane: 'Up next', action: 'approve', actor: 'automation' },
      { lane: 'Up next', action: 'merge', actor: 'automation' },
      { lane: 'Up next', action: 'pause', actor: 'automation' },
      { lane: 'Up next', action: 'resume', actor: 'automation' },
    ]
  )

  // A steer refusal (no pending approval) surfaces the message.
  const refuse = recordingRoadmapFrontDoor({ steerLane: async () => ({ ok: false, message: 'No pending approval for this lane.' }) })
  const refuseTools = createAutomationTools(backendsOf({ getRoadmapFrontDoor: refuse.frontDoor }))
  const refused = await tool(refuseTools, 'roadmap.approve').handler({ lane: 'Up next' })
  assert.equal((refused.structuredContent as { error: { code: string } }).error.code, 'roadmap_approve_failed')
}

async function testStudioGatewayMergesCanonicalRunToolsAndRoutesContext(): Promise<void> {
  const calls: Array<{ runId: string; toolName: string; arguments?: Record<string, unknown> }> = []
  const appTool: McpToolRegistration = {
    name: 'workspace.list',
    description: 'list workspaces',
    inputSchema: { type: 'object' },
    handler: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
  }
  const tools = createStudioGatewayTools({
    appTools: [appTool],
    sprintEngineMcpHub: {
      callRunTool: async (input) => {
        calls.push(input)
        return {
          content: [{ type: 'text', text: 'canonical' }],
          structuredContent: { ok: true, taskId: 'task-7' },
        }
      },
    },
  })
  assert.equal(tools.length, SPRINTENGINE_TOOL_NAMES.length + 1)
  assert.equal(SPRINTENGINE_TOOL_NAMES.every((name) => tools.some((candidate) => candidate.name === name)), true)

  const runTool = tool(tools, 'sprintengine.task.next')
  const noRun = await runTool.handler({}, { metadata: { kind: 'studio-agent', agentId: 'agent-a' } })
  assert.equal(noRun.isError, true)
  assert.equal((noRun.structuredContent as { error: { code: string } }).error.code, 'no_active_sprint')

  const proxied = await runTool.handler(
    { role: 'developer' },
    { metadata: { kind: 'studio-agent', agentId: 'agent-a', sprintRunId: 'run-a' } }
  )
  assert.deepEqual(proxied.structuredContent, { ok: true, taskId: 'task-7' })
  assert.deepEqual(calls, [{ runId: 'run-a', toolName: 'sprintengine.task.next', arguments: { role: 'developer' } }])

  assert.throws(
    () => createStudioGatewayTools({ appTools: [appTool, appTool], sprintEngineMcpHub: { callRunTool: async () => ({}) } }),
    /Duplicate SprintEngine Studio MCP tool/
  )
  assert.equal(isStudioGatewayMutation('backlog.update'), true)
  assert.equal(isStudioGatewayMutation('backlog.repair'), true)
  assert.equal(isStudioGatewayMutation('backlog.list'), false)
  assert.equal(isStudioGatewayMutation('sprintengine.task.publish'), true)
  assert.equal(isStudioGatewayMutation('sprintengine.vcs.commit'), true)
  assert.equal(isStudioGatewayMutation('sprintengine.plan.address_reviews'), true)
  assert.equal(isStudioGatewayMutation('sprintengine.task.list'), false)
}

async function testStudioGatewayAuditIsRedactedAndRotated(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'multicode-studio-mcp-audit-'))
  try {
    const store = createGatewayAuditStore({ resolveUserDataDir: () => dir, maxBytes: 1024, backups: 2 })
    for (let index = 0; index < 20; index += 1) {
      store.record({
        connection: {
          kind: 'studio-agent',
          workspaceId: 'ws-1',
          agentId: 'agent-a',
          cliId: 'codex',
          sprintRunId: 'run-a',
        },
        tool: 'backlog.create',
        durationMs: 7,
        args: {
          workspaceId: 'ws-1',
          relativePath: `backlog/item-${index}.md`,
          prompt: 'never-log-this-prompt',
          token: 'never-log-this-token',
          body: { secret: 'never-log-this-body' },
        },
        result: {
          content: [{ type: 'text', text: 'full tool response is not audited' }],
          structuredContent: { ok: true, relativePath: `backlog/item-${index}.md`, title: 'not retained' },
        },
      })
    }
    const path = join(dir, STUDIO_GATEWAY_AUDIT_FILENAME)
    assert.equal(existsSync(path), true)
    assert.equal(existsSync(`${path}.1`), true, 'bounded log rotates before unbounded growth')
    const combined = [path, `${path}.1`, `${path}.2`]
      .filter(existsSync)
      .map((candidate) => readFileSync(candidate, 'utf8'))
      .join('')
    assert.doesNotMatch(combined, /never-log-this|full tool response|"title"/)
    assert.match(combined, /"workspaceId":"ws-1"/)
    assert.match(combined, /"tool":"backlog.create"/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// --- Review MCP tools on the gateway (plan §3.3) -----------------------------

const REVIEW_ID = 'cs123'

// A valid change set with a branch source, so review_get_changeset has an absolute
// repoRoot to strip. Two non-binary files with hunks give annotations a real line
// extent. Hand-built (checkBriefMatchesChangeSet assumes the changeset is valid).
function reviewFixtureChangeSet(repoRoot: string): ReviewChangeSet {
  return {
    schemaVersion: 1,
    id: 'cs_fixture',
    source: { kind: 'branch', repoRoot, baseRef: 'main', headRef: 'feature' },
    title: 'feature → main',
    baseRef: 'main',
    headSha: 'abc123def456',
    files: [
      {
        path: 'src/store.ts',
        status: 'modified',
        binary: false,
        additions: 1,
        deletions: 0,
        hunks: [
          {
            oldStart: 1,
            oldLines: 2,
            newStart: 1,
            newLines: 3,
            lines: [
              { kind: 'context', text: 'export const store = {' },
              { kind: 'add', text: '  next: 1,' },
              { kind: 'context', text: '}' },
            ],
          },
        ],
      },
      {
        path: 'src/view.tsx',
        status: 'added',
        binary: false,
        additions: 1,
        deletions: 0,
        hunks: [
          { oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: [{ kind: 'add', text: 'export const View = () => null' }] },
        ],
      },
    ],
    stats: { files: 2, additions: 2, deletions: 0 },
    fetchedAt: '2026-07-18T00:00:00Z',
  }
}

function reviewValidBrief(): ReviewBrief {
  return {
    schemaVersion: 1,
    changeSetId: 'cs_fixture',
    headSha: 'abc123def456',
    generatedAt: '2026-07-18T00:00:00Z',
    overview: {
      intent: 'Add a next counter to the store and a view that reads it.',
      blastRadius: 'Touches the store shape and one new view component.',
      readingGuide: 'Read the store first, then the view that consumes it.',
      complexity: 'low',
    },
    steps: [
      {
        id: 'step-store',
        order: 0,
        title: 'Store foundation',
        narrative: 'The store gains a next field; the view later reads it.',
        files: [{ path: 'src/store.ts', why: 'introduces the next field', readingNote: 'read-closely' }],
        annotations: [
          {
            id: 'ann-1',
            path: 'src/store.ts',
            anchor: { side: 'new', startLine: 1, endLine: 2 },
            kind: 'explain',
            title: 'New field',
            summary: 'The store now carries a next counter.',
            hoverTip: 'This is where the counter enters the store shape.',
          },
        ],
      },
      {
        id: 'step-view',
        order: 1,
        title: 'View surface',
        narrative: 'A new component renders against the store.',
        files: [{ path: 'src/view.tsx', why: 'new component consuming the store', readingNote: 'mechanical-skim' }],
        annotations: [],
      },
    ],
    knowledgeRefs: [],
    coverage: { assignedPaths: ['src/store.ts', 'src/view.tsx'], unassignedPaths: [] },
  }
}

// Seed a review directory with an ingested change set under a temp project root,
// and build the review tools scoped to it. `emitted` captures brief-run events.
function reviewHarness(): {
  tools: McpToolRegistration[]
  projectRoot: string
  reviewDir: string
  emitted: BriefRunEvent[]
  /** Flip the Review module the way Settings does, mid-session. */
  setModuleEnabled: (enabled: boolean) => void
} {
  const projectRoot = mkdtempSync(join(tmpdir(), 'review-gw-'))
  const reviewDir = reviewChangeSetDir(projectRoot, REVIEW_ID)
  mkdirSync(reviewDir, { recursive: true })
  writeFileSync(join(reviewDir, 'changeset.json'), `${JSON.stringify(reviewFixtureChangeSet(projectRoot), null, 2)}\n`)
  const emitted: BriefRunEvent[] = []
  let moduleEnabled = true
  const tools = createReviewGatewayTools({
    isReviewModuleEnabled: () => moduleEnabled,
    listOpenProjectRoots: () => [projectRoot],
    homeDir: () => homedir(),
    emitBriefRunEvent: (event) => emitted.push(event),
  })
  return {
    tools,
    projectRoot,
    reviewDir,
    emitted,
    setModuleEnabled: (enabled) => {
      moduleEnabled = enabled
    },
  }
}

async function testReviewSubmitBriefHappyPathWritesAtomicallyAndEmits(): Promise<void> {
  const { tools, projectRoot, reviewDir, emitted } = reviewHarness()
  try {
    const submit = await tool(tools, 'review_submit_brief').handler({
      reviewId: REVIEW_ID,
      projectRoot,
      brief: reviewValidBrief() as unknown as Record<string, unknown>,
    })
    assert.equal(submit.isError, undefined, 'valid brief submits without error')
    assert.equal(submit.structuredContent?.ok, true)

    // The brief landed on disk atomically and re-validates.
    const briefPath = join(reviewDir, 'brief.json')
    assert.ok(existsSync(briefPath), 'brief.json written')
    assert.ok(validateReviewBrief(JSON.parse(readFileSync(briefPath, 'utf8'))).ok, 'persisted brief is valid')
    assert.equal(existsSync(join(reviewDir, '.brief.json.tmp')), false, 'no temp file left behind')

    // The brief-run event fired so an open Reviews door reloads.
    assert.deepEqual(emitted, [{ workspaceId: REVIEW_ID, phase: 'done' }])

    // The read tools now see the landed brief.
    const listed = await tool(tools, 'review_list_pending').handler({})
    const reviews = (listed.structuredContent as { reviews: Array<{ reviewId: string; source: string; hasBrief: boolean }> }).reviews
    assert.deepEqual(reviews, [{ reviewId: REVIEW_ID, projectRoot, source: 'branch', hasBrief: true }])
    const got = await tool(tools, 'review_get_brief').handler({ reviewId: REVIEW_ID, projectRoot })
    assert.equal((got.structuredContent as { brief: ReviewBrief | null }).brief?.changeSetId, 'cs_fixture')
  } finally {
    rmSync(projectRoot, { recursive: true, force: true })
  }
}

async function testReviewSubmitBriefInvalidReturnsEveryErrorAndWritesNothing(): Promise<void> {
  const { tools, projectRoot, reviewDir } = reviewHarness()
  try {
    // Pre-seed a prior brief so we can prove garbage never overwrites it.
    const briefPath = join(reviewDir, 'brief.json')
    const prior = `${JSON.stringify(reviewValidBrief(), null, 2)}\n`
    writeFileSync(briefPath, prior)

    // A shapeless object fails many schema checks at once.
    const submit = await tool(tools, 'review_submit_brief').handler({ reviewId: REVIEW_ID, projectRoot, brief: {} })
    assert.equal(submit.isError, true, 'invalid brief is an error')
    const errors = (submit.structuredContent as { errors: string[] }).errors
    assert.ok(Array.isArray(errors) && errors.length > 1, 'returns every validator message, not just the first')
    assert.equal(readFileSync(briefPath, 'utf8'), prior, 'prior brief.json is untouched')

    // A shaped-but-mismatched brief (wrong changeSetId + dropped coverage) fails the
    // cross-check and still writes nothing.
    const mismatched = reviewValidBrief()
    mismatched.changeSetId = 'cs_wrong'
    const cross = await tool(tools, 'review_submit_brief').handler({
      reviewId: REVIEW_ID,
      projectRoot,
      brief: mismatched as unknown as Record<string, unknown>,
    })
    assert.equal(cross.isError, true)
    assert.ok((cross.structuredContent as { errors: string[] }).errors.some((e) => /changeSetId/.test(e)))
    assert.equal(readFileSync(briefPath, 'utf8'), prior, 'a mismatch never overwrites either')

    // A JSON string instead of the brief object is refused before validation.
    const stringy = await tool(tools, 'review_submit_brief').handler({
      reviewId: REVIEW_ID,
      projectRoot,
      brief: JSON.stringify(reviewValidBrief()),
    })
    assert.equal(stringy.isError, true)
    assert.equal((stringy.structuredContent as { error: { code: string } }).error.code, 'invalid_arguments')
  } finally {
    rmSync(projectRoot, { recursive: true, force: true })
  }
}

async function testReviewSubmitBriefRejectsSeverityAnnotationKind(): Promise<void> {
  const { tools, projectRoot, reviewDir } = reviewHarness()
  try {
    // The no-verdicts firewall: any annotation kind outside explain|context|knowledge
    // is rejected by the shape validator, so a severity verdict cannot be smuggled in.
    const brief = reviewValidBrief() as unknown as { steps: Array<{ annotations: Array<{ kind: string }> }> }
    brief.steps[0].annotations[0].kind = 'severity'
    const submit = await tool(tools, 'review_submit_brief').handler({
      reviewId: REVIEW_ID,
      projectRoot,
      brief: brief as unknown as Record<string, unknown>,
    })
    assert.equal(submit.isError, true, 'a severity kind is rejected')
    assert.ok((submit.structuredContent as { errors: string[] }).errors.some((e) => /kind/.test(e)), 'names the offending kind')
    assert.equal(existsSync(join(reviewDir, 'brief.json')), false, 'the firewall wrote no brief')
  } finally {
    rmSync(projectRoot, { recursive: true, force: true })
  }
}

async function testReviewToolsRejectUnknownTargetAndStripAbsolutePaths(): Promise<void> {
  const { tools, projectRoot } = reviewHarness()
  try {
    const home = homedir()

    // A projectRoot that is not an open project fails cleanly, and the error never
    // echoes the absolute path the caller guessed.
    const foreign = await tool(tools, 'review_get_changeset').handler({ reviewId: REVIEW_ID, projectRoot: join(home, 'not-open') })
    assert.equal(foreign.isError, true)
    const foreignError = (foreign.structuredContent as { error: { code: string; message: string } }).error
    assert.equal(foreignError.code, 'unknown_project')
    assert.ok(!foreignError.message.includes(home), 'the error leaks no absolute machine path')

    // A malformed reviewId is rejected before any path is built.
    const badId = await tool(tools, 'review_get_brief').handler({ reviewId: '../escape', projectRoot })
    assert.equal(badId.isError, true)
    assert.equal((badId.structuredContent as { error: { code: string } }).error.code, 'invalid_arguments')

    // review_get_changeset returns the full change set but strips the branch
    // source's absolute repoRoot — no machine path in the payload.
    const got = await tool(tools, 'review_get_changeset').handler({ reviewId: REVIEW_ID, projectRoot })
    assert.equal(got.isError, undefined)
    const payload = got.structuredContent as { changeset: { source: Record<string, unknown>; files: unknown[] }; truncated: boolean }
    assert.equal(payload.truncated, false)
    assert.equal(payload.changeset.files.length, 2, 'the change set is returned in full')
    assert.equal(payload.changeset.source.kind, 'branch')
    assert.equal('repoRoot' in payload.changeset.source, false, 'repoRoot is stripped')
    assert.ok(!JSON.stringify(payload.changeset.source).includes(projectRoot), 'no absolute project path in the source')
  } finally {
    rmSync(projectRoot, { recursive: true, force: true })
  }
}

// MC-1805: a disabled Review module makes review unreachable in BOTH processes.
// The tools stay registered — an agent still sees the capability, and learns why
// it is refusing — but every one of them refuses before touching a file.
async function testReviewToolsRefuseWhileTheModuleIsDisabled(): Promise<void> {
  const { tools, projectRoot, reviewDir, emitted, setModuleEnabled } = reviewHarness()
  try {
    setModuleEnabled(false)
    assert.deepEqual(
      tools.map((registration) => registration.name),
      ['review_list_pending', 'review_get_changeset', 'review_get_brief', 'review_submit_brief'],
      'registration is static: a disabled module still lists its tools'
    )

    const calls: Array<[string, Record<string, unknown>]> = [
      ['review_list_pending', {}],
      ['review_get_changeset', { reviewId: REVIEW_ID, projectRoot }],
      ['review_get_brief', { reviewId: REVIEW_ID, projectRoot }],
      [
        'review_submit_brief',
        { reviewId: REVIEW_ID, projectRoot, brief: reviewValidBrief() as unknown as Record<string, unknown> },
      ],
    ]
    for (const [name, args] of calls) {
      const refused = await tool(tools, name).handler(args)
      assert.equal(refused.isError, true, `${name} refuses`)
      const error = (refused.structuredContent as { error: { code: string; message: string } }).error
      assert.equal(error.code, 'review_module_disabled', `${name} names the reason`)
      assert.equal(
        error.message,
        'The Review module is disabled. Enable it in Settings → Modules to use review tools.',
        `${name} returns the module-disabled sentence verbatim`
      )
    }

    // No read and no write happened on behalf of a disabled capability.
    assert.equal(existsSync(join(reviewDir, 'brief.json')), false, 'no brief was written')
    assert.deepEqual(emitted, [], 'nothing was announced to open windows')

    // Enablement is read per call, off the same registrations: switching the
    // module back on in Settings works on the next call, not the next restart.
    setModuleEnabled(true)
    const listed = await tool(tools, 'review_list_pending').handler({})
    assert.equal(listed.isError, undefined, 'an enabled module answers normally')
    const submitted = await tool(tools, 'review_submit_brief').handler({
      reviewId: REVIEW_ID,
      projectRoot,
      brief: reviewValidBrief() as unknown as Record<string, unknown>,
    })
    assert.equal(submitted.structuredContent?.ok, true, 'and the one mutation works again')
    assert.deepEqual(emitted, [{ workspaceId: REVIEW_ID, phase: 'done' }])
  } finally {
    rmSync(projectRoot, { recursive: true, force: true })
  }
}

const tests = [
  testSettingsDefaultOnAndRoundTrip,
  testStudioGatewayStartsDespiteLegacyDisabledSetting,
  testStudioGatewayEndpointContractAcrossPlatforms,
  testToolListNamesTheToolSurface,
  testReadToolsAnswerFromSnapshot,
  testReadToolsResolveWorkspaceRootThroughSnapshot,
  testReadToolsPassServiceFailuresThrough,
  testBacklogRepairRoutesOnlyValidatedIntegrityOperations,
  testBacklogUpdateAppliesInOrderAndStopsOnFailure,
  testBacklogAssignBuildsTheCanonicalLink,
  testBacklogWorkHandsItemToAgent,
  testBacklogWorkFallsBackAndRefusesFinishedItems,
  testBacklogWorkPresetGuardAndPostLaunchLinkFailure,
  testRoadmapToolsReadPlanAndSteer,
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
  testConcurrentBridgesKeepResponsesAndAttributionIsolated,
  testBridgeFailsClearlyWithoutDiscoveryFile,
  testBridgeReportsStaleDiscoveryFile,
  testStudioGatewayMergesCanonicalRunToolsAndRoutesContext,
  testStudioGatewayAuditIsRedactedAndRotated,
  testReviewSubmitBriefHappyPathWritesAtomicallyAndEmits,
  testReviewSubmitBriefInvalidReturnsEveryErrorAndWritesNothing,
  testReviewSubmitBriefRejectsSeverityAnnotationKind,
  testReviewToolsRejectUnknownTargetAndStripAbsolutePaths,
  testReviewToolsRefuseWhileTheModuleIsDisabled,
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
