import assert from 'node:assert/strict'
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
import { createWorkspaceRegistryService } from '../workspace-registry-service'
import { createInMemoryWorkspaceRegistryStore } from '../workspace-registry-store'
import { createWorkspaceSyncService } from '../workspace-sync-service'
import { createMainKernel } from '../module-host/main-host'
import { createFakeIpcMain } from '../module-host/ipc-main-fake.test-helper'
import { loadMainModules, type CapabilityModule } from '../module-host/load-modules'
import { createAutomationTools, type AutomationBackends } from './automation-tools'
import { createGatewayAuditStore, STUDIO_GATEWAY_AUDIT_FILENAME } from './gateway-audit'
import { createStudioGatewayTools, isStudioGatewayMutation } from './studio-gateway-tools'
import { requiredScopeForTool } from './tailnet/tailnet-scopes'
import { createReviewGatewayTools } from '../review/gateway-tools'
import { reviewChangeSetDir } from '../review/changeset-service'
import type { BriefRunEvent } from '../review/brief-run-service'
import { validateReviewBrief, type ReviewBrief, type ReviewChangeSet } from '../../shared/review'
import { DEFAULT_MCP_PROTOCOL_VERSION, SUPPORTED_MCP_PROTOCOL_VERSIONS } from '../../shared/mcp/protocol'
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
import type { SprintCreateRequest, SprintCreateResult } from '../../shared/sprint-create'
import type { AgentLaunchRequest } from '../../shared/agent-launch'
import type { LoadedPlugin } from '../../shared/plugin-manifest'
import type { MarketplaceRegistryReadInput } from '../../shared/electron-api'
import type { MarketplaceComponentKind } from '../../shared/marketplace/manifest'
import type { CapabilityManifest, ThirdPartyModuleView } from '../../shared/modules/manifest'
import {
  EMPTY_MODULE_SURFACES,
  type ModuleRegistryEntry,
  type ModuleRegistrySnapshot,
} from '../../shared/modules/registry-snapshot'
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
      cliPermissionPreset: 'manual',
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
  createSprint?: (request: SprintCreateRequest) => Promise<SprintCreateResult>
  createWorkspace?: AutomationBackends['createWorkspace']
  launchAgent?: AutomationBackends['launchAgent']
  getAgentSpawnPermissionDefault?: AutomationBackends['getAgentSpawnPermissionDefault']
  /** The CLI this machine would spawn under; the harness's stub session reports it. */
  defaultCli?: string
  listBacklogItems?: AutomationBackends['listBacklogItems']
  readBacklogItem?: AutomationBackends['readBacklogItem']
  listAutomationDefinitions?: AutomationBackends['listAutomationDefinitions']
  listAutomationRuns?: AutomationBackends['listAutomationRuns']
  backlogWrite?: Partial<AutomationBackends['backlogWrite']>
  getAutomationsFrontDoor?: AutomationBackends['getAutomationsFrontDoor']
  listSprintRunStatePaths?: AutomationBackends['listSprintRunStatePaths']
  mobileControl?: AutomationBackends['mobileControl']
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
  readWorkspaceCheckout?: AutomationBackends['readWorkspaceCheckout']
  readRepositoryIdentity?: AutomationBackends['readRepositoryIdentity']
  listPlugins?: AutomationBackends['listPlugins']
  ensureBuiltinSkillInstalled?: AutomationBackends['ensureBuiltinSkillInstalled']
  getModuleRegistrySnapshot?: AutomationBackends['getModuleRegistrySnapshot']
  listInstalledThirdPartyModules?: AutomationBackends['listInstalledThirdPartyModules']
  listModuleContributedTools?: AutomationBackends['listModuleContributedTools']
  readMarketplaceRegistry?: AutomationBackends['readMarketplaceRegistry']
}

function unexpectedCall(name: string): () => never {
  return () => {
    throw new Error(`unexpected backlogWrite.${name} call`)
  }
}

function backendsOf(overrides: BackendsOverrides = {}): AutomationBackends {
  // `workspace.create` mints in main now (MC-2158), so the backend is a real
  // registry rather than a delegated renderer call the test has to stub answering.
  let createdIds = 0
  const registry = createWorkspaceRegistryService({
    store: createInMemoryWorkspaceRegistryStore(),
    now: () => 1_000,
    newWorkspaceId: () => `ws-created-${++createdIds}`,
  })
  const workspaceSync = createWorkspaceSyncService({ registry, now: () => 1_000 })
  return {
    getWorkspaceSyncSnapshot: () => snapshotOf(overrides.workspaces ?? []),
    createWorkspace: overrides.createWorkspace ?? ((input, actor) => workspaceSync.createWorkspace(input, actor)),
    listTerminalSessions: () => overrides.sessions ?? [],
    createSprint:
      overrides.createSprint
      ?? (async () => ({ ok: false, code: 'no_sprint_create_service', message: 'no sprint create service in test' })),
    // Default: no launch port wired. A test that reaches a launch without
    // stubbing one gets an explicit failure, not a silent success.
    launchAgent:
      overrides.launchAgent
      ?? (async () => ({ ok: false, code: 'no_launch_service', message: 'no launch service in test' })),
    // A machine where nobody has chosen a preset yet — the honest starting
    // state, so a case that depends on a default has to say so.
    getAgentSpawnPermissionDefault: overrides.getAgentSpawnPermissionDefault ?? (() => null),
    // Default: the mobile lane is unwired. A test that exercises the mobile
    // tools stubs this; anything else that reaches it fails loudly.
    mobileControl:
      overrides.mobileControl
      ?? {
        readSnapshot: async () => {
          throw new Error('unexpected mobileControl.readSnapshot call')
        },
        dispatchCommand: async () => {
          throw new Error('unexpected mobileControl.dispatchCommand call')
        },
      },
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
      updateDependenciesPlanned: unexpectedCall('updateDependenciesPlanned'),
      addOrUpdateLink: unexpectedCall('addOrUpdateLink'),
      repairIntegrity: unexpectedCall('repairIntegrity'),
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
    readWorkspaceCheckout:
      overrides.readWorkspaceCheckout
      ?? (async () => ({ git: false, branch: null, defaultBranch: null, branches: [], worktrees: [] })),
    readRepositoryIdentity: overrides.readRepositoryIdentity ?? (async () => null),
    listPlugins: overrides.listPlugins ?? (() => []),
    ensureBuiltinSkillInstalled: overrides.ensureBuiltinSkillInstalled ?? (async () => true),
    // module.*/marketplace.*: no registry mirrored and nothing installed unless
    // a case says otherwise, so the default backends prove the "not reported
    // yet" path rather than a fabricated empty registry.
    getModuleRegistrySnapshot: overrides.getModuleRegistrySnapshot ?? (() => null),
    listInstalledThirdPartyModules:
      overrides.listInstalledThirdPartyModules ?? (async () => ({ modules: [], rejected: [] })),
    listModuleContributedTools: overrides.listModuleContributedTools ?? (() => []),
    readMarketplaceRegistry:
      overrides.readMarketplaceRegistry
      ?? (async () => {
        throw new Error('unexpected readMarketplaceRegistry call')
      }),
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
      resolveGatewayTools: () => [],
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
      'cli.runtime.list',
      'marketplace.list',
      'module.list',
      'module.status',
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
      'terminal.create',
      'terminal.list',
      'workspace.checkout',
      'workspace.create',
      'workspace.list',
      'workspace.mobile_command',
      'workspace.snapshot',
      'workspace.status',
    ]
  )
}

// MC-2165: the list a remote client reads before attaching to one of these.
// It reports liveness honestly — a paused agent is not running but is not gone
// — and carries the hook-reported phase with its provenance, so a caller can
// tell an authoritative "waiting for you" from an output-timing guess.
async function testTerminalListReportsAttachableSessions(): Promise<void> {
  const sessions = [
    {
      sessionId: 'session-live',
      processAlive: true,
      suspended: false,
      kind: 'agent',
      workspaceId: 'ws-1',
      agentId: 'agent-a',
      agentName: 'Scout',
      cli: 'claude-code',
      cwd: '/repo/one',
      visible: true,
      startedAt: 10,
      lastOutputAt: 20,
      lastInputAt: null,
      lastVisibleAt: null,
      activity: { kind: 'working', since: 20 },
      agentState: { phase: 'awaiting_input', source: 'hook', since: 21 },
    },
    {
      sessionId: 'session-paused',
      processAlive: false,
      suspended: true,
      kind: 'agent',
      workspaceId: 'ws-2',
      cwd: '/repo/two',
      visible: false,
      startedAt: 5,
      lastOutputAt: 6,
      lastInputAt: null,
      lastVisibleAt: null,
      activity: { kind: 'idle', since: 6 },
    },
    {
      sessionId: 'session-shell',
      processAlive: true,
      suspended: false,
      kind: 'terminal',
      workspaceId: 'ws-1',
      cwd: '/repo/one',
      visible: true,
      startedAt: 30,
      lastOutputAt: 30,
      lastInputAt: null,
      lastVisibleAt: null,
      activity: { kind: 'idle', since: 30 },
    },
  ] as unknown as TerminalSessionSnapshot[]
  const base = backendsOf({ sessions, workspaces: [testWorkspace('ws-1')] })
  // The workspace-name lookup must read the sync snapshot ONCE per call, never
  // once per session: on a registry of hundreds of workspaces a per-row read
  // was a whole-registry clone per row (the 30-second stall of 2026-09-05).
  let snapshotReads = 0
  const tools = createAutomationTools({
    ...base,
    getWorkspaceSyncSnapshot: () => {
      snapshotReads += 1
      return base.getWorkspaceSyncSnapshot()
    },
  })

  const all = await tool(tools, 'terminal.list').handler({})
  assert.equal(all.isError, undefined, JSON.stringify(all.structuredContent))
  const listed = (all.structuredContent as {
    terminals: Array<{
      sessionId: string
      processAlive: boolean
      suspended: boolean
      agentState: unknown
      workspaceName: string | null
      git: unknown
    }>
  }).terminals
  assert.deepEqual(listed.map((entry) => entry.sessionId), ['session-live', 'session-paused', 'session-shell'])
  assert.equal(snapshotReads, 1, 'one snapshot read serves every row of a terminal.list')
  assert.equal(listed[0].workspaceName, testWorkspace('ws-1').name, 'a known workspace names its row')
  assert.equal(listed[1].workspaceName, null, 'an unknown workspace id reads as no name, never a guess')
  // Git facts are read for RUNNING sessions only: a paused or exited chat gets
  // null rather than the checkout's present numbers (the sidebar's own rule),
  // and a network read never fans git out to every checkout ever held.
  assert.equal(listed[1].git, null, 'a paused session carries no git line')
  assert.deepEqual(listed[0].agentState, { phase: 'awaiting_input', source: 'hook', since: 21 })
  // Paused is its own answer: not running, not gone.
  assert.equal(listed[1].processAlive, false)
  assert.equal(listed[1].suspended, true)
  // A plain shell has no agent phase to report, and says so rather than guessing.
  assert.equal(listed[2].agentState, null)

  const filtered = await tool(tools, 'terminal.list').handler({ workspaceId: 'ws-1', kind: 'agent' })
  assert.deepEqual(
    (filtered.structuredContent as { terminals: Array<{ sessionId: string }> }).terminals.map((entry) => entry.sessionId),
    ['session-live']
  )

  const refused = await tool(tools, 'terminal.list').handler({ kind: 'sideways' })
  assert.equal(refused.isError, true)
  assert.equal((refused.structuredContent as { error: { code: string } }).error.code, 'invalid_kind')
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
  // The restart survivor MC-1903 had to hide (a routing placeholder with no
  // live terminal, the unactionable graveyard) no longer exists: main persists
  // the real record, so a workspace that survived a restart is listed like any
  // other and every workspace-scoped tool accepts its id.
  const restartSurvivor = testWorkspace('ws-old', { name: 'Survivor', folderPath: '/repo/old' })
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
  const identityReads: string[] = []
  const tools = createAutomationTools(
    backendsOf({
      workspaces: [workspace, restartSurvivor],
      sessions,
      readRepositoryIdentity: async (folderPath) => {
        identityReads.push(folderPath)
        return folderPath === '/repo/old'
          ? { canonicalKey: 'github.com/acme/old', remoteUrl: 'git@github.com:acme/old.git', name: 'old' }
          : null
      },
    })
  )

  const list = await tool(tools, 'workspace.list').handler({})
  assert.equal(list.isError, undefined)
  const listed = list.structuredContent as {
    workspaces: Array<{ id: string; detail: string; repository: { canonicalKey: string } | null }>
  }
  assert.equal(listed.workspaces.length, 2)
  assert.deepEqual(listed.workspaces.map((entry) => entry.detail), ['full', 'full'])
  // one-project-across-machines: each folder's repository rides the listing,
  // null where the reader has nothing, so a paired Studio can match clones.
  assert.deepEqual(identityReads, ['/repo/old'], 'read once per folder; a folderless workspace is not asked about')
  assert.equal(listed.workspaces.find((entry) => entry.id === 'ws-old')?.repository?.canonicalKey, 'github.com/acme/old')
  assert.equal(listed.workspaces.find((entry) => entry.id === 'ws-1')?.repository, null)

  // A gateway tool operates on the restart survivor with no live agent
  // terminal — the case that used to fail `workspace_without_folder`.
  const survivorStatus = await tool(tools, 'workspace.status').handler({ workspaceId: 'ws-old' })
  assert.equal(survivorStatus.isError, undefined)
  assert.equal(
    (survivorStatus.structuredContent as { workspace: { folderPath: string | null } }).workspace.folderPath,
    '/repo/old',
  )

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

// Wires a workspace + launch port that simulate a confirmed launch: the port
// records the request, inserts the agent into the (mutated) workspace, and
// registers a live terminal session so the handler's confirmation probe passes.
// Returns the launch log and the worktree-creation call log.
//
// The launch stopped being a renderer delegation in MC-2159, so this stubs
// `launchAgent` (the main-process AgentLaunchService) rather than the retired
// renderer request — and the session it registers carries the id the launch
// reports back, which is what the handler now confirms against.
function launchHarness(overrides: BackendsOverrides = {}): {
  tools: ReturnType<typeof createAutomationTools>
  requests: AgentLaunchRequest[]
  worktreeCalls: Array<{ workspaceRoot: string; name: string; baseRef?: string }>
} {
  const workspace = testWorkspace('ws-1', { folderPath: '/tmp/project-a' })
  const sessions: TerminalSessionSnapshot[] = []
  const requests: AgentLaunchRequest[] = []
  const worktreeCalls: Array<{ workspaceRoot: string; name: string; baseRef?: string }> = []
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
    launchAgent:
      overrides.launchAgent
      ?? (async (request) => {
        requests.push(request)
        const agentId = 'agent-claude-abc'
        workspace.agents[agentId] = { id: agentId, name: 'Scout', cli: 'claude-code', cliSessionId: 'sess-1' } as never
        // A full snapshot, not a stub: terminal.create projects the session it
        // just minted straight back to the caller, so a half-shaped one here
        // would pass a test the real runtime's snapshot would fail.
        sessions.push({
          sessionId: 'sess-1',
          kind: 'agent',
          workspaceId: 'ws-1',
          agentId,
          agentName: 'Scout',
          // The CLI the launch service resolved, in its real order: the request
          // when it named one, otherwise this machine's last-selected CLI.
          cli: request.cli ?? overrides.defaultCli ?? 'claude-code',
          cwd: request.worktreePath ?? '/tmp/project-a',
          processAlive: true,
          suspended: false,
          visible: false,
          startedAt: 1,
          lastOutputAt: 1,
          lastInputAt: null,
          lastVisibleAt: null,
          activity: { kind: 'idle', since: 1 },
        } as never)
        return { ok: true, workspaceId: request.workspaceId, agentId, sessionId: 'sess-1' }
      }),
  }
  return { tools: createAutomationTools(backends), requests, worktreeCalls }
}

async function testAgentLaunchWidensConfigAndIsolation(): Promise<void> {
  // bypass is refused at the boundary with its own code — never delegated.
  const bypass = launchHarness()
  const refused = await tool(bypass.tools, 'agent.launch').handler({
    workspaceId: 'ws-1',
    permissionPreset: 'bypass',
  })
  assert.equal(refused.isError, true)
  assert.equal(
    (refused.structuredContent as { error: { code: string } }).error.code,
    'permission_preset_not_allowed'
  )
  assert.equal(bypass.requests.length, 0, 'a refused preset never reaches the launch service')

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
    permissionPreset: 'auto',
    specialistId: 'security-reviewer',
  })
  assert.equal(okConfig.isError, undefined, JSON.stringify(okConfig.structuredContent))
  assert.equal(configured.worktreeCalls.length, 0, 'no worktree requested ⇒ createAgentWorktree not called')
  const req = configured.requests[0]
  assert.equal(req.cliModel, 'opus')
  assert.equal(req.permissionPreset, 'auto')
  assert.equal(req.specialistId, 'security-reviewer')
  assert.equal(req.worktreePath, undefined)
  assert.equal((okConfig.structuredContent as { worktreePath?: string }).worktreePath, undefined)

  // worktree:{} creates an agent/<name> worktree and threads its path through the
  // launch request and the success payload.
  const isolated = launchHarness()
  const okWorktree = await tool(isolated.tools, 'agent.launch').handler({
    workspaceId: 'ws-1',
    name: 'Scout',
    worktree: {},
  })
  assert.equal(okWorktree.isError, undefined, JSON.stringify(okWorktree.structuredContent))
  assert.deepEqual(isolated.worktreeCalls, [{ workspaceRoot: '/tmp/project-a', name: 'Scout' }])
  const worktreeReq = isolated.requests[0]
  assert.equal(worktreeReq.worktreePath, '/tmp/project-a/.multicode-worktrees/Scout')
  assert.equal(
    (okWorktree.structuredContent as { worktreePath?: string }).worktreePath,
    '/tmp/project-a/.multicode-worktrees/Scout'
  )
  assert.equal(
    (okWorktree.structuredContent as { worktreeBranch?: string }).worktreeBranch,
    'agent/Scout',
    'the branch the worktree was minted on is reported, for the row that will name it'
  )

  // worktree.baseRef (checkout-and-branch-on-remote-create) is the ref the
  // worktree forks from — a branch the caller read off workspace.checkout —
  // and reaches the git helper as such; absent, the helper forks HEAD.
  const forked = launchHarness()
  const okForked = await tool(forked.tools, 'agent.launch').handler({
    workspaceId: 'ws-1',
    name: 'Scout',
    worktree: { name: 'fix', baseRef: 'release/2' },
  })
  assert.equal(okForked.isError, undefined, JSON.stringify(okForked.structuredContent))
  assert.deepEqual(forked.worktreeCalls, [{ workspaceRoot: '/tmp/project-a', name: 'fix', baseRef: 'release/2' }])
  const badBase = await tool(launchHarness().tools, 'agent.launch').handler({
    workspaceId: 'ws-1',
    worktree: { baseRef: 7 },
  })
  assert.equal((badBase.structuredContent as { error: { code: string } }).error.code, 'invalid_arguments')

  // A connector forces a worktree even without an explicit worktree request.
  const connector = launchHarness()
  const okConnector = await tool(connector.tools, 'agent.launch').handler({
    workspaceId: 'ws-1',
    name: 'Scout',
    connectorId: 'railway',
  })
  assert.equal(okConnector.isError, undefined, JSON.stringify(okConnector.structuredContent))
  assert.deepEqual(connector.worktreeCalls, [{ workspaceRoot: '/tmp/project-a', name: 'Scout' }])
  const connectorReq = connector.requests[0]
  assert.equal(connectorReq.connectorId, 'railway')
  assert.equal(connectorReq.worktreePath, '/tmp/project-a/.multicode-worktrees/Scout')

  // A worktree-creation failure is fatal isolation — worktree_unavailable, and
  // the launch never happens.
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

async function testCreateMintsInMainWithNoWindow(): Promise<void> {
  // The delegate-then-poll shape this used to assert is gone (MC-2158): there
  // is no renderer to ask and no bus confirmation to wait on, so the tool
  // succeeds with zero windows and returns the record main just committed.
  const backends = backendsOf()
  const tools = createAutomationTools(backends)
  const created = await tool(tools, 'workspace.create').handler({
    name: 'Created via automation',
    folderPath: '/repo/a',
  })
  assert.equal(created.isError, undefined, 'creation no longer depends on a window being open')
  const projection = (created.structuredContent as {
    workspace: { id: string; name: string; folderPath: string | null; detail: string }
  }).workspace
  assert.equal(projection.id, 'ws-created-1')
  assert.equal(projection.name, 'Created via automation')
  assert.equal(projection.folderPath, '/repo/a')
  assert.equal(projection.detail, 'full', 'there is no routing-only projection left to report')
}

async function testCreateSurfacesARegistryRefusal(): Promise<void> {
  // A refusal from main is reported with its own reason — never softened into a
  // success, and never a timeout for something that is not a timeout.
  const backends = backendsOf({
    createWorkspace: () => ({ ok: false, reason: 'registry_commit_failed', message: 'disk is gone' }),
  })
  const tools = createAutomationTools(backends)
  const created = await tool(tools, 'workspace.create').handler({})
  assert.equal(created.isError, true)
  assert.match(JSON.stringify(created.structuredContent), /registry_commit_failed/)
}

// MC-2166: opening a terminal on THIS machine from wherever the call came from.
// The session id is the deliverable — the caller attaches to it immediately —
// and the workspace can be named without an id, because the terminal scope tier
// is granted separately from the one that may call workspace.list.
async function testTerminalCreateSpawnsAndReturnsTheAttachableSession(): Promise<void> {
  const byId = launchHarness()
  const created = await tool(byId.tools, 'terminal.create').handler({ workspaceId: 'ws-1', prompt: 'go' })
  assert.equal(created.isError, undefined, JSON.stringify(created.structuredContent))
  const payload = created.structuredContent as {
    sessionId: string
    workspaceId: string
    agentId: string
    permissionPreset: string
    terminal: { sessionId: string; kind: string; processAlive: boolean; cli: string | null }
  }
  assert.equal(payload.sessionId, 'sess-1', 'the caller gets the session id to attach to, not a search hint')
  assert.equal(payload.workspaceId, 'ws-1')
  assert.equal(payload.terminal.sessionId, 'sess-1')
  assert.equal(payload.terminal.processAlive, true, 'success is a live session, not a launch call returning')
  assert.equal(byId.requests[0].prompt, 'go')
  // No worktree and no connector: terminal.create is not a second door onto
  // agent.launch's workspace-mutating options.
  assert.equal(byId.worktreeCalls.length, 0)
  assert.equal(byId.requests[0].worktreePath, undefined)
  assert.equal(byId.requests[0].connectorId, undefined)

  // A workspace named rather than identified — the path a device holding only
  // the terminal scopes has to use, since workspace.list is closed to it.
  const byName = launchHarness()
  const named = await tool(byName.tools, 'terminal.create').handler({ workspaceName: 'workspace ws-1' })
  assert.equal(named.isError, undefined, JSON.stringify(named.structuredContent))
  assert.equal(byName.requests[0].workspaceId, 'ws-1')

  const unknownName = await tool(launchHarness().tools, 'terminal.create').handler({ workspaceName: 'nowhere' })
  assert.equal((unknownName.structuredContent as { error: { code: string } }).error.code, 'unknown_workspace')

  const bothWays = await tool(launchHarness().tools, 'terminal.create').handler({
    workspaceId: 'ws-1',
    workspaceName: 'Workspace ws-1',
  })
  assert.equal((bothWays.structuredContent as { error: { code: string } }).error.code, 'invalid_arguments')

  const neither = await tool(launchHarness().tools, 'terminal.create').handler({})
  assert.equal((neither.structuredContent as { error: { code: string } }).error.code, 'invalid_arguments')

  // Two workspaces sharing a name is an explicit refusal naming both ids:
  // opening a terminal in the wrong project is not a recoverable mistake.
  const twins = [
    testWorkspace('ws-left', { name: 'Twin', folderPath: '/tmp/left' }),
    testWorkspace('ws-right', { name: 'Twin', folderPath: '/tmp/right' }),
  ]
  const ambiguous = await tool(
    createAutomationTools(backendsOf({ workspaces: twins })),
    'terminal.create'
  ).handler({ workspaceName: 'twin' })
  assert.equal((ambiguous.structuredContent as { error: { code: string } }).error.code, 'ambiguous_workspace_name')
  assert.match(JSON.stringify(ambiguous.structuredContent), /ws-left/)
  assert.match(JSON.stringify(ambiguous.structuredContent), /ws-right/)
}

// The acceptance the item states about defaults: this machine's own settings
// decide the CLI and the preset unless the caller names them — with the one
// exception that `bypass` never crosses this surface, inherited or asked for.
// workspace.checkout (checkout-and-branch-on-remote-create): the read a
// paired Studio makes before choosing where a remote chat runs. It projects
// the backend's facts under the workspace id, and answers a folderless or
// unknown workspace with the same failures every workspace tool gives.
async function testWorkspaceCheckoutReportsTheBackendsFacts(): Promise<void> {
  const workspace = testWorkspace('ws-1', { folderPath: '/tmp/project-a' })
  const orphan = testWorkspace('ws-none', { folderPath: null })
  const reads: string[] = []
  const tools = createAutomationTools(
    backendsOf({
      workspaces: [workspace, orphan],
      readWorkspaceCheckout: async (root) => {
        reads.push(root)
        return {
          git: true,
          branch: 'main',
          defaultBranch: 'main',
          branches: [{ name: 'feat/x', current: false }, { name: 'main', current: true }],
          worktrees: [{ path: '/tmp/project-a', branch: 'main', isMain: true }],
        }
      },
    })
  )
  const answer = await tool(tools, 'workspace.checkout').handler({ workspaceId: 'ws-1' })
  assert.equal(answer.isError, undefined, JSON.stringify(answer.structuredContent))
  assert.deepEqual(reads, ['/tmp/project-a'], 'the read is against the workspace folder')
  const facts = answer.structuredContent as {
    workspaceId: string
    git: boolean
    branch: string | null
    defaultBranch: string | null
    branches: Array<{ name: string; current: boolean }>
    worktrees: Array<{ path: string; branch: string | null; isMain: boolean }>
  }
  assert.equal(facts.workspaceId, 'ws-1')
  assert.equal(facts.git, true)
  assert.equal(facts.branch, 'main')
  assert.deepEqual(facts.branches.map((entry) => entry.name), ['feat/x', 'main'])
  assert.equal(facts.worktrees[0]?.isMain, true)

  const noFolder = await tool(tools, 'workspace.checkout').handler({ workspaceId: 'ws-none' })
  assert.equal((noFolder.structuredContent as { error: { code: string } }).error.code, 'workspace_without_folder')
  const unknown = await tool(tools, 'workspace.checkout').handler({ workspaceId: 'ws-ghost' })
  assert.equal((unknown.structuredContent as { error: { code: string } }).error.code, 'unknown_workspace')
  assert.equal(isStudioGatewayMutation('workspace.checkout'), false, 'a read, on workspace:read — the worktree itself is agent.launch')
}

async function testTerminalCreateTakesThisMachinesLaunchDefaults(): Promise<void> {
  const inherited = launchHarness({
    defaultCli: 'codex',
    getAgentSpawnPermissionDefault: () => 'auto',
  })
  const ok = await tool(inherited.tools, 'terminal.create').handler({ workspaceId: 'ws-1' })
  assert.equal(ok.isError, undefined, JSON.stringify(ok.structuredContent))
  assert.equal(
    inherited.requests[0].cli,
    undefined,
    'an unnamed CLI is left to the launch service, which reads the same settings store'
  )
  assert.equal(inherited.requests[0].permissionPreset, 'auto', "this machine's preset, not a hardcoded one")
  assert.equal((ok.structuredContent as { permissionPreset: string }).permissionPreset, 'auto')
  // The CLI reported is the one the session actually spawned under.
  assert.equal((ok.structuredContent as { terminal: { cli: string } }).terminal.cli, 'codex')

  // An explicit choice overrides the machine default.
  const overridden = launchHarness({
    defaultCli: 'codex',
    getAgentSpawnPermissionDefault: () => 'auto',
  })
  await tool(overridden.tools, 'terminal.create').handler({
    workspaceId: 'ws-1',
    cli: 'claude-code',
    permissionPreset: 'manual',
  })
  assert.equal(overridden.requests[0].cli, 'claude-code')
  assert.equal(overridden.requests[0].permissionPreset, 'manual')

  // Asked for: refused with its own code, and nothing is spawned.
  const asked = launchHarness()
  const refused = await tool(asked.tools, 'terminal.create').handler({
    workspaceId: 'ws-1',
    permissionPreset: 'bypass',
  })
  assert.equal(refused.isError, true)
  assert.equal(
    (refused.structuredContent as { error: { code: string } }).error.code,
    'permission_preset_not_allowed'
  )
  assert.equal(asked.requests.length, 0, 'a refused preset never reaches the launch service')

  // Inherited: clamped to the most restrictive preset rather than refused — the
  // caller cannot fix this machine's setting — and the answer says which preset
  // actually applied, so the clamp is visible rather than silent.
  const clamped = launchHarness({
    getAgentSpawnPermissionDefault: () => 'bypass',
  })
  const spawned = await tool(clamped.tools, 'terminal.create').handler({ workspaceId: 'ws-1' })
  assert.equal(spawned.isError, undefined, JSON.stringify(spawned.structuredContent))
  assert.equal(clamped.requests[0].permissionPreset, 'manual')
  assert.equal((spawned.structuredContent as { permissionPreset: string }).permissionPreset, 'manual')

  // A launch failure is reported as itself, never as a created terminal.
  const broken = launchHarness({
    launchAgent: async () => ({ ok: false, code: 'no_cli_selected', message: 'nobody has chosen a CLI' }),
  })
  const failed = await tool(broken.tools, 'terminal.create').handler({ workspaceId: 'ws-1' })
  assert.equal(failed.isError, true)
  assert.equal((failed.structuredContent as { error: { code: string } }).error.code, 'no_cli_selected')
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
    resolveTools: () => [echoTool],
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

async function testInitializeNegotiatesTheProtocolVersionInsteadOfEchoingIt(): Promise<void> {
  // The gateway used to answer initialize with whatever protocolVersion the client
  // asked for, which told a spec-tracking client (one asking for 2026-07-28 today)
  // that we speak a spec we do not implement.
  // Supported → itself; unsupported, malformed, or absent → our default.
  // The probe is a far-future date deliberately: a real upcoming spec version would
  // have to be re-pointed here the moment we start serving it, and the subject of
  // this test is the downgrade rule, not any one version.
  const unsupported = '2099-01-01'
  assert.ok(
    !SUPPORTED_MCP_PROTOCOL_VERSIONS.includes(unsupported),
    'this test needs a version we do NOT serve'
  )
  // The Python engine pins the same literal (tests/sprintengine_tool/test_mcp_server.py);
  // that pair is what keeps the two servers' declared maximum from drifting apart again.
  // The maximum rose to 2026-07-28 in the commit that earned it: handshake-optional
  // framing, per-request `_meta.protocolVersion`, and `ttlMs` (the two tests below).
  assert.equal(DEFAULT_MCP_PROTOCOL_VERSION, '2026-07-28', 'both servers must answer the same default/maximum')

  const dir = mkdtempSync(join(tmpdir(), 'multicode-automation-negotiate-'))
  const socketPath = join(dir, 'automation.sock')
  const server = createMcpSocketServer({
    socketPath,
    serverName: 'multicode-automation',
    serverVersion: '0.0.0-test',
    resolveTools: () => [],
  })
  await server.start()
  try {
    const socket = connect(socketPath)
    socket.setEncoding('utf8')
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve())
      socket.once('error', reject)
    })
    const responses: Array<Record<string, unknown>> = []
    let raw = ''
    let buffer = ''
    socket.on('data', (chunk: string) => {
      raw += chunk
      buffer += chunk
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line) responses.push(JSON.parse(line))
        newline = buffer.indexOf('\n')
      }
    })

    const initialize = (id: number, params: Record<string, unknown>): void => {
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'initialize', params })}\n`)
    }
    initialize(1, { protocolVersion: '2025-03-26' })
    initialize(2, { protocolVersion: unsupported })
    initialize(3, {})
    initialize(4, { protocolVersion: 20260728 })
    initialize(5, { protocolVersion: '2026-07-28' })
    // A revision we do not know that sits BETWEEN two we do serve. Answering
    // our maximum here named a version the client could not parse and it
    // rejected the handshake, so every spawned agent came up with no tools.
    initialize(6, { protocolVersion: '2025-11-25' })
    // Older than anything we serve: answer our oldest, still never our newest.
    initialize(7, { protocolVersion: '2024-01-01' })
    await waitUntil('seven initialize responses', () => responses.length >= 7)

    const answered = new Map(
      responses.map((response) => [response.id, (response.result as { protocolVersion: string }).protocolVersion])
    )
    assert.equal(answered.get(1), '2025-03-26', 'a supported version is answered with itself')
    assert.equal(answered.get(2), DEFAULT_MCP_PROTOCOL_VERSION, 'an unsupported version downgrades, never errors')
    assert.equal(answered.get(3), DEFAULT_MCP_PROTOCOL_VERSION, 'an absent version answers the default')
    assert.equal(answered.get(4), DEFAULT_MCP_PROTOCOL_VERSION, 'a non-string version answers the default')
    assert.equal(answered.get(5), '2026-07-28', 'the version this gateway now implements is answered with itself')
    assert.equal(answered.get(6), '2025-06-18', 'an unknown version downgrades to the newest we serve at or below it')
    assert.equal(answered.get(7), '2024-11-05', 'a client older than everything we serve gets our oldest, not our newest')
    assert.ok(!raw.includes(unsupported), 'the requested version must never come back to the caller')

    socket.destroy()
  } finally {
    await server.stop()
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * A started socket server plus one connected client that collects newline-delimited
 * JSON-RPC responses. Deliberately sends no `initialize`: every test below it is
 * about a connection that never handshakes.
 *
 * Keep `prefix` short — a Unix socket path is capped near 104 bytes, and the temp
 * dir eats half of that, so a descriptive prefix fails `listen` with EINVAL.
 */
async function handshakelessClient(prefix: string): Promise<{
  send: (frame: Record<string, unknown>) => void
  responses: Array<Record<string, unknown>>
  close: () => Promise<void>
}> {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  const socketPath = join(dir, 'automation.sock')
  const server = createMcpSocketServer({
    socketPath,
    serverName: 'multicode-automation',
    serverVersion: '0.0.0-test',
    resolveTools: () => [
      {
        name: 'workspace.list',
        description: 'test tool',
        inputSchema: { type: 'object', properties: {} },
        handler: async () => ({ content: [{ type: 'text', text: '{}' }], structuredContent: { workspaces: [] } }),
      },
    ],
  })
  await server.start()
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
  return {
    send: (frame) => socket.write(`${JSON.stringify(frame)}\n`),
    responses,
    close: async () => {
      socket.destroy()
      await server.stop()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

async function testToolsAnswerAConnectionThatNeverInitialized(): Promise<void> {
  // 2026-07-28 removes the initialize/initialized handshake, so a spec-tracking
  // client opens the socket and calls straight away. That already worked here (the
  // dispatch has no handshake gate), which is exactly why it needs pinning: nothing
  // in the code says "do not add a gate", so only this test stops one being added.
  const client = await handshakelessClient('multicode-mcp-nohandshake-')
  try {
    client.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    client.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'workspace.list', arguments: {} } })
    await waitUntil('two responses on a connection that never initialized', () => client.responses.length >= 2)

    const byId = new Map(client.responses.map((response) => [response.id, response]))
    const list = byId.get(1) as { error?: unknown; result: { tools: Array<{ name: string }>; ttlMs: number } }
    assert.equal(list.error, undefined, 'tools/list is not gated on a handshake')
    assert.deepEqual(list.result.tools.map((entry) => entry.name), ['workspace.list'])
    // ttlMs (SEP-2549): five minutes, because module enable/disable rewrites this
    // surface live and notifications/tools/list_changed rides the same socket.
    assert.equal(list.result.ttlMs, 300_000, 'tools/list carries a cache hint')
    assert.ok(!('cacheScope' in list.result), 'no cacheScope value is invented')

    const call = byId.get(2) as { error?: unknown; result: { structuredContent: { workspaces: unknown[] } } }
    assert.equal(call.error, undefined, 'tools/call is not gated on a handshake')
    assert.deepEqual(call.result.structuredContent.workspaces, [])
  } finally {
    await client.close()
  }
}

async function testPerRequestProtocolVersionDeclarationIsValidated(): Promise<void> {
  // With the handshake optional and no headers on this transport, `params._meta.
  // protocolVersion` is the only place a client can state which spec its frame
  // speaks. A declaration is a commitment: unlike initialize (which downgrades),
  // an unsupported one is refused rather than served under semantics nobody agreed to.
  const unsupported = '2099-01-01'
  assert.ok(!SUPPORTED_MCP_PROTOCOL_VERSIONS.includes(unsupported), 'this test needs a version we do NOT serve')

  const client = await handshakelessClient('multicode-mcp-declared-')
  try {
    const meta = (protocolVersion: unknown): Record<string, unknown> => ({ _meta: { protocolVersion } })
    client.send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: meta(DEFAULT_MCP_PROTOCOL_VERSION) })
    client.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: meta(unsupported) })
    client.send({ jsonrpc: '2.0', id: 3, method: 'tools/list' })
    client.send({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: meta(20260728) })
    client.send({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'workspace.list', arguments: {}, ...meta(unsupported) },
    })
    client.send({
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'workspace.list', arguments: {}, ...meta(DEFAULT_MCP_PROTOCOL_VERSION) },
    })
    await waitUntil('six responses', () => client.responses.length >= 6)

    const byId = new Map(client.responses.map((response) => [response.id, response]))
    const served = (id: number, why: string): void => {
      const response = byId.get(id) as { error?: { message: string }; result?: unknown }
      assert.equal(response.error, undefined, why)
      assert.ok(response.result, why)
    }
    const refused = (id: number, why: string): void => {
      const response = byId.get(id) as { error: { code: number; message: string }; result?: unknown }
      assert.equal(response.error.code, -32602, why)
      assert.match(response.error.message, /Unsupported MCP protocol version/, why)
      for (const version of SUPPORTED_MCP_PROTOCOL_VERSIONS) {
        assert.ok(response.error.message.includes(version), `the refusal names ${version}`)
      }
      assert.equal(response.result, undefined, 'a refused request is never also served')
    }
    served(1, 'a supported declared version is served normally')
    refused(2, 'an unsupported declared version is refused')
    served(3, 'no declaration at all is served normally')
    refused(4, 'a non-string declaration is a claim we cannot honour, not an absent one')
    refused(5, 'the check covers tools/call, not just tools/list')
    served(6, 'a supported declaration does not stop the tool running')
  } finally {
    await client.close()
  }
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
    resolveTools: () => [],
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
    resolveTools: () => [
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
    resolveTools: () => [{
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

// The epic ordering mark (MC-2137) is the one field an agent sets to say "the
// planning phase for this epic is over", so backlog.update has to carry it.
async function testBacklogUpdateCarriesTheEpicOrderingMark(): Promise<void> {
  const marks: boolean[] = []
  const tools = createAutomationTools(
    backendsOf({
      workspaces: [testWorkspace('ws-1', { folderPath: '/tmp/project-a' })],
      backlogWrite: {
        updateDependenciesPlanned: async (input) => {
          marks.push(input.dependenciesPlanned)
          return { ok: true, store: { schemaVersion: 1, items: [] } }
        },
      },
    })
  )
  const update = tool(tools, 'backlog.update')

  const marked = await update.handler(
    { path: 'backlog/epics/auth.md', dependenciesPlanned: true },
    agentContext('ws-1')
  )
  assert.equal(marked.isError, undefined)
  const cleared = await update.handler(
    { path: 'backlog/epics/auth.md', dependenciesPlanned: false },
    agentContext('ws-1')
  )
  assert.equal(cleared.isError, undefined)
  assert.deepEqual(marks, [true, false], 'the mark is written exactly as asserted, both ways')

  // It is an assertion, not a string: a stringy "true" is refused before any write.
  const stringy = await update.handler(
    { path: 'backlog/epics/auth.md', dependenciesPlanned: 'true' },
    agentContext('ws-1')
  )
  assert.equal((stringy.structuredContent as { error: { code: string } }).error.code, 'invalid_arguments')
  assert.equal(marks.length, 2, 'an invalid mark never reaches the writer')
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

  // The launched startup prompt is the invocation with instructions appended.
  const req = harness.requests[0]
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
  const req = fallback.requests[0]
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
  // bypass is refused at the boundary — before any read or launch.
  const bypass = launchHarness({
    readBacklogItem: async (_root, relativePath) => ({
      ok: true,
      item: { relativePath, title: 'T', isEpic: false, status: 'ready' },
      body: '',
    }),
  })
  const refused = await tool(bypass.tools, 'backlog.work').handler(
    { path: 'backlog/example.md', permissionPreset: 'bypass' },
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
        // Nor does any MCP tool install a marketplace automation — that is the
        // marketplace install path's door, reached from the app, not from a tool.
        installCatalogueDefinition: async () => ({ ok: false, code: 'not_stubbed', message: 'No automation tool installs catalogue automations.' }),
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
    action: { kind: 'spawn-agent', config: { prompt: 'do it', permissionPreset: 'auto' } },
  }
  const ok = await tool(withFrontDoor, 'automation.create').handler({ workspaceId: 'ws-1', definition })
  assert.equal(ok.isError, undefined)
  assert.deepEqual(created, [{ workspaceRoot: '/tmp/project-a', definition }])
  assert.deepEqual(ok.structuredContent, { automation: { id: 'auto-1', name: 'Nightly' } })

  const okRun = await tool(withFrontDoor, 'automation.run').handler({ workspaceId: 'ws-1', automationId: 'auto-1' })
  assert.deepEqual(ran, [{ workspaceRoot: '/tmp/project-a', automationId: 'auto-1' }])
  assert.deepEqual(okRun.structuredContent, { definition: { id: 'auto-1' }, run: { runId: 'run-1' } })

  // bypass is refused before the front door ever sees the draft.
  const bypass = await tool(withFrontDoor, 'automation.create').handler({
    workspaceId: 'ws-1',
    definition: {
      ...definition,
      action: { kind: 'spawn-agent', config: { prompt: 'do it', permissionPreset: 'bypass' } },
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

// Automations spawn their agents in bypass by default (an unattended run cannot
// answer a permission prompt), and that default is resolved in the spawn-agent
// action. It changes nothing here: an EXTERNAL caller still gets exactly two
// presets and cannot grant itself bypass. This pins the boundary so the default
// is never read as permission to widen it.
async function testBypassStaysRefusedAtTheExternalToolBoundary(): Promise<void> {
  const created: unknown[] = []
  const tools = createAutomationTools(
    backendsOf({
      workspaces: [testWorkspace('ws-1', { folderPath: '/tmp/project-a' })],
      getAutomationsFrontDoor: () => ({
        createDefinition: async (input) => {
          created.push(input)
          return { ok: true, value: { id: 'auto-1', name: 'Nightly' } as never }
        },
        updateDefinition: async () => ({ ok: false, code: 'not_stubbed', message: 'No automation tool updates definitions.' }),
        // Nor does any MCP tool install a marketplace automation — that is the
        // marketplace install path's door, reached from the app, not from a tool.
        installCatalogueDefinition: async () => ({ ok: false, code: 'not_stubbed', message: 'No automation tool installs catalogue automations.' }),
        runNow: async () => ({ ok: false, code: 'not_stubbed', message: 'Not exercised here.' }),
      }),
    })
  )

  // The advertised vocabulary is the boundary: two members, bypass absent,
  // on every tool that launches an agent.
  for (const name of ['agent.launch', 'backlog.work'] as const) {
    const properties = tool(tools, name).inputSchema.properties as Record<string, { enum?: unknown }>
    assert.deepEqual(
      properties.permissionPreset?.enum,
      ['manual', 'auto'],
      `${name} advertises exactly the two allowed presets`,
    )
  }

  // And the refusals say what was refused and who can set it — a caller can act
  // on the message without reading the code.
  const launchRefusal = await tool(tools, 'agent.launch').handler({ workspaceId: 'ws-1', permissionPreset: 'bypass' })
  const createRefusal = await tool(tools, 'automation.create').handler({
    workspaceId: 'ws-1',
    definition: {
      name: 'Nightly',
      trigger: { kind: 'schedule', config: { cadence: 'daily' } },
      action: { kind: 'spawn-agent', config: { prompt: 'do it', permissionPreset: 'bypass' } },
    },
  })
  for (const [surface, refusal] of [['agent.launch', launchRefusal], ['automation.create', createRefusal]] as const) {
    const error = (refusal.structuredContent as { error: { code: string; message: string } }).error
    assert.equal(refusal.isError, true, `${surface} refuses bypass`)
    assert.equal(error.code, 'permission_preset_not_allowed', `${surface} refuses with its own code`)
    assert.match(error.message, /bypass/, `${surface} names the refused preset`)
    assert.match(error.message, /person can set that preset/, `${surface} says who can set it instead`)
  }
  assert.deepEqual(created, [], 'a refused draft never reaches the create pipeline')

  // Refusing the literal string is not the boundary — the boundary is the preset
  // the run ACTUALLY gets. Omitting the key resolves to the unattended default on
  // an agent-backed action, and the renderer fills an omitted launch preset from
  // the user's last spawn choice (which ships as bypass), so both surfaces
  // must resolve rather than read.
  const omittedCreate = await tool(tools, 'automation.create').handler({
    workspaceId: 'ws-1',
    definition: {
      name: 'Nightly',
      trigger: { kind: 'schedule', config: { cadence: 'daily' } },
      action: { kind: 'spawn-agent', config: { prompt: 'do it' } },
    },
  })
  assert.equal(omittedCreate.isError, true, 'an agent-backed draft that names no preset is refused')
  assert.equal(
    (omittedCreate.structuredContent as { error: { code: string } }).error.code,
    'permission_preset_not_allowed',
    'omission is refused as a preset problem, not a validation problem',
  )
  assert.deepEqual(created, [], 'the preset-less draft never reaches the create pipeline either')

  // A non-agent action has no preset to resolve and must stay creatable.
  const webhookCreate = await tool(tools, 'automation.create').handler({
    workspaceId: 'ws-1',
    definition: {
      name: 'Ping',
      trigger: { kind: 'schedule', config: { cadence: 'daily' } },
      action: { kind: 'http-post', config: { url: 'https://example.invalid/hook' } },
    },
  })
  assert.equal(webhookCreate.isError, undefined, 'a non-agent action is unaffected by the preset gate')
  assert.equal(created.length, 1, 'the non-agent draft reaches the create pipeline')

  // The pre-MC-2210 spelling of bypass is the SAME preset, so it must hit the
  // same ceiling. Comparing the raw string let `bypass_all` through here and be
  // normalized to `bypass` downstream — an unattended agent nobody consented to
  // (backlog/2026-09-06-automation-create-misses-the-legacy-bypass-spelling.md).
  const legacyBypass = await tool(tools, 'automation.create').handler({
    workspaceId: 'ws-1',
    definition: {
      name: 'Nightly',
      trigger: { kind: 'schedule', config: { cadence: 'daily' } },
      action: { kind: 'spawn-agent', config: { prompt: 'do it', permissionPreset: 'bypass_all' } },
    },
  })
  assert.equal(legacyBypass.isError, true, 'the legacy spelling of bypass is refused too')
  assert.equal(
    (legacyBypass.structuredContent as { error: { code: string } }).error.code,
    'permission_preset_not_allowed',
  )
  assert.equal(created.length, 1, 'the legacy-bypass draft never reaches the create pipeline')

  // An explicitly-named allowed preset still passes through verbatim. `default`
  // is the legacy spelling of `manual`, which is allowed here — only bypass is
  // refused — so it stays accepted for definitions written before the rename.
  for (const preset of ['default', 'auto'] as const) {
    const allowed = await tool(tools, 'automation.create').handler({
      workspaceId: 'ws-1',
      definition: {
        name: 'Nightly',
        trigger: { kind: 'schedule', config: { cadence: 'daily' } },
        action: { kind: 'spawn-agent', config: { prompt: 'do it', permissionPreset: preset } },
      },
    })
    assert.equal(allowed.isError, undefined, `an explicit "${preset}" automation is created`)
  }

  // agent.launch never forwards an absent preset to the renderer's own default.
  const omittedLaunch = launchHarness()
  const launched = await tool(omittedLaunch.tools, 'agent.launch').handler({ workspaceId: 'ws-1', prompt: 'go' })
  assert.equal(launched.isError, undefined, JSON.stringify(launched.structuredContent))
  const launchRequest = omittedLaunch.requests[0]
  assert.equal(
    launchRequest.permissionPreset,
    'manual',
    'an omitted launch preset is pinned to the most restrictive allowed value, not left for the renderer to fill',
  )
}

async function testAutomationMutationToolsPassPipelineFailuresThrough(): Promise<void> {
  const tools = createAutomationTools(
    backendsOf({
      workspaces: [testWorkspace('ws-1', { folderPath: '/tmp/project-a' })],
      getAutomationsFrontDoor: () => ({
        createDefinition: async () => ({ ok: false, code: 'workspace_root_untrusted', message: 'Folder is not an open workspace.' }),
        updateDefinition: async () => ({ ok: false, code: 'not_stubbed', message: 'No automation tool updates definitions.' }),
        // Nor does any MCP tool install a marketplace automation — that is the
        // marketplace install path's door, reached from the app, not from a tool.
        installCatalogueDefinition: async () => ({ ok: false, code: 'not_stubbed', message: 'No automation tool installs catalogue automations.' }),
        runNow: async () => ({ ok: false, code: 'unsupported_trigger', message: 'Run now needs a schedule trigger.' }),
      }),
    })
  )
  const created = await tool(tools, 'automation.create').handler({
    workspaceId: 'ws-1',
    // An explicit allowed preset, so the draft clears the preset gate and the
    // pipeline's own failure is what surfaces.
    definition: {
      name: 'X',
      trigger: { kind: 'schedule', config: {} },
      action: { kind: 'spawn-agent', config: { permissionPreset: 'auto' } },
    },
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

async function testSprintCreateComposesInMainAndConfirms(): Promise<void> {
  const requests: SprintCreateRequest[] = []
  let workspaceVisible = false
  let architectAlive = false
  // What the next creation sets the live-session flag to — lets the timeout path
  // model a run whose architect never comes up.
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
    createSprint: async (request) => {
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
      folderPath: '/tmp/project-a',
      goal: 'Ship checkout',
      name: undefined,
      startRunner: true,
      autoApproveArtifacts: false,
      // MC-2136 flipped this default from false: a sprint runs in one worktree
      // per sprint unless asked otherwise, on every creation surface. A caller
      // that wants the main working tree says so (`useWorktrees: false` /
      // `isolation: "none"`), which is checked below.
      useWorktrees: true,
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

  // MC-2077 — the plural form. A multi-ref launch hands the full deduped list to
  // the service as `sourceRelativePaths`, and `goal` may be absent (the
  // selection derives one).
  requests.length = 0
  nextArchitectAlive = true
  const multi = await tool(tools, 'sprint.create').handler({
    folderPath: '/tmp/project-a',
    sourceRefs: ['backlog/epics/one.md', 'backlog/two.md', 'backlog/two.md'],
  })
  assert.equal(multi.isError, undefined, JSON.stringify(multi.structuredContent))
  assert.deepEqual(
    (requests[0] as { sourceRelativePaths?: string[] }).sourceRelativePaths,
    ['backlog/epics/one.md', 'backlog/two.md']
  )
  assert.equal((requests[0] as { sourceRelativePath?: string }).sourceRelativePath, undefined)

  // A single entry collapses onto the singular contract, byte-identical.
  requests.length = 0
  const singleton = await tool(tools, 'sprint.create').handler({
    folderPath: '/tmp/project-a',
    sourceRefs: ['backlog/two.md'],
  })
  assert.equal(singleton.isError, undefined, JSON.stringify(singleton.structuredContent))
  assert.equal((requests[0] as { sourceRelativePath?: string }).sourceRelativePath, 'backlog/two.md')
  assert.equal((requests[0] as { sourceRelativePaths?: string[] }).sourceRelativePaths, undefined)

  // Both forms together are ambiguous; empty arrays and blank entries are refused.
  for (const args of [
    { folderPath: '/tmp/project-a', sourceRef: 'backlog/a.md', sourceRefs: ['backlog/b.md'] },
    { folderPath: '/tmp/project-a', sourceRefs: [] },
    { folderPath: '/tmp/project-a', sourceRefs: ['  '] },
  ]) {
    const bad = await tool(tools, 'sprint.create').handler(args as never)
    assert.equal(bad.isError, true, JSON.stringify(args))
    assert.equal((bad.structuredContent as { error: { code: string } }).error.code, 'invalid_arguments')
  }

  // MC-2136 — the isolation ladder. `isolation` is the whole thing; the older
  // `useWorktrees` boolean stays accepted and means its first two rungs, so a
  // caller written before this creates the byte-identical run it always did.
  requests.length = 0
  const perTask = await tool(tools, 'sprint.create').handler({
    folderPath: '/tmp/project-a',
    goal: 'Ship checkout',
    isolation: 'task',
  })
  assert.equal(perTask.isError, undefined, JSON.stringify(perTask.structuredContent))
  assert.equal((requests[0] as { useWorktrees?: boolean }).useWorktrees, true, 'per-task rides on run worktrees')
  assert.equal((requests[0] as { taskIsolation?: boolean }).taskIsolation, true)

  requests.length = 0
  await tool(tools, 'sprint.create').handler({ folderPath: '/tmp/project-a', goal: 'g', isolation: 'sprint' })
  assert.equal((requests[0] as { useWorktrees?: boolean }).useWorktrees, true)
  assert.equal(
    'taskIsolation' in (requests[0] as object),
    false,
    'the per-sprint rung sends no isolation field at all — the pre-2136 payload',
  )

  requests.length = 0
  await tool(tools, 'sprint.create').handler({ folderPath: '/tmp/project-a', goal: 'g', useWorktrees: false })
  assert.equal(
    (requests[0] as { useWorktrees?: boolean }).useWorktrees,
    false,
    'an explicit false still means the project folder — only OMITTING both takes the new default',
  )

  requests.length = 0
  await tool(tools, 'sprint.create').handler({ folderPath: '/tmp/project-a', goal: 'g', isolation: 'none' })
  assert.equal((requests[0] as { useWorktrees?: boolean }).useWorktrees, false)

  requests.length = 0
  await tool(tools, 'sprint.create').handler({ folderPath: '/tmp/project-a', goal: 'g', useWorktrees: true })
  assert.equal((requests[0] as { useWorktrees?: boolean }).useWorktrees, true, 'the old spelling still means one worktree')
  assert.equal('taskIsolation' in (requests[0] as object), false)

  // Two spellings that disagree are refused rather than silently resolved either
  // way — an unreadable request must not quietly create the weaker run.
  for (const args of [
    { folderPath: '/tmp/project-a', goal: 'g', isolation: 'task', useWorktrees: false },
    { folderPath: '/tmp/project-a', goal: 'g', isolation: 'none', useWorktrees: true },
    { folderPath: '/tmp/project-a', goal: 'g', isolation: 'per-task' },
  ]) {
    const bad = await tool(tools, 'sprint.create').handler(args as never)
    assert.equal(bad.isError, true, JSON.stringify(args))
    assert.equal((bad.structuredContent as { error: { code: string } }).error.code, 'invalid_arguments')
  }

  // Service failures pass through verbatim (name collisions, controller errors).
  const failing = createAutomationTools({
    ...backendsOf(),
    createSprint: async () => ({ ok: false, code: 'sprint_team_exists', message: 'That team already exists.' }),
  })
  const failed = await tool(failing, 'sprint.create').handler({ folderPath: '/tmp/p', goal: 'g' })
  assert.equal((failed.structuredContent as { error: { code: string } }).error.code, 'sprint_team_exists')
}

// MC-2120 — the execution runtime the wizard has and the gateway did not: the
// pool/run-level `runtime`, the per-role model/effort maps, and the run's agent
// ceiling. Each one reaches the renderer verbatim, and a malformed one is
// refused at the boundary rather than forwarded for the renderer to interpret.
async function testSprintCreateCarriesTheRunRuntime(): Promise<void> {
  const requests: SprintCreateRequest[] = []
  const workspace = testWorkspace('ws-sprint', { folderPath: '/tmp/project-a', mode: 'sprintengine' as never })
  const tools = createAutomationTools({
    ...backendsOf(),
    getWorkspaceSyncSnapshot: () => snapshotOf([workspace]),
    createSprint: async (request) => {
      requests.push(request)
      return { ok: true, workspaceId: 'ws-sprint' }
    },
  })

  // The roleless shape (the default sprint kind): one `runtime` block, no roles.
  const roleless = await tool(tools, 'sprint.create').handler({
    folderPath: '/tmp/project-a',
    goal: 'Ship checkout',
    runtime: { cli: 'claude-code', model: 'claude-opus-5', effort: 'high' },
    maxConcurrentAgents: 6,
  })
  assert.equal(roleless.isError, undefined, JSON.stringify(roleless.structuredContent))
  assert.deepEqual((requests[0] as { runtime?: unknown }).runtime, {
    cli: 'claude-code',
    model: 'claude-opus-5',
    effort: 'high',
  })
  assert.equal((requests[0] as { maxConcurrentAgents?: number }).maxConcurrentAgents, 6)

  // The role-based shape: per-role maps, `null` preserved as the explicit
  // "this role takes its CLI default" it is.
  requests.length = 0
  const roles = await tool(tools, 'sprint.create').handler({
    folderPath: '/tmp/project-a',
    goal: 'Ship checkout',
    roster: { architect: 1, developer: 1 },
    roleClis: { developer: 'codex' },
    roleModels: { architect: 'claude-opus-5', developer: null },
    roleEfforts: { architect: 'high' },
  })
  assert.equal(roles.isError, undefined, JSON.stringify(roles.structuredContent))
  assert.deepEqual((requests[0] as { roleClis?: unknown }).roleClis, { developer: 'codex' })
  assert.deepEqual((requests[0] as { roleModels?: unknown }).roleModels, {
    architect: 'claude-opus-5',
    developer: null,
  })
  assert.deepEqual((requests[0] as { roleEfforts?: unknown }).roleEfforts, { architect: 'high' })

  // Every field is omitted when unset, so a caller written before MC-2120
  // produces the byte-identical payload it always did.
  requests.length = 0
  await tool(tools, 'sprint.create').handler({ folderPath: '/tmp/project-a', goal: 'g' })
  for (const key of ['runtime', 'roleClis', 'roleModels', 'roleEfforts', 'maxConcurrentAgents']) {
    assert.equal(key in (requests[0] as object), false, `${key} is absent when unset`)
  }

  for (const args of [
    { folderPath: '/tmp/project-a', goal: 'g', runtime: 'claude-code' },
    { folderPath: '/tmp/project-a', goal: 'g', runtime: { cli: '' } },
    { folderPath: '/tmp/project-a', goal: 'g', runtime: { reasoning: 'high' } },
    { folderPath: '/tmp/project-a', goal: 'g', roleModels: ['architect'] },
    { folderPath: '/tmp/project-a', goal: 'g', roleClis: { architect: 7 } },
    { folderPath: '/tmp/project-a', goal: 'g', roleModels: { architect: 42 } },
    { folderPath: '/tmp/project-a', goal: 'g', roleEfforts: { architect: '' } },
    { folderPath: '/tmp/project-a', goal: 'g', maxConcurrentAgents: 0 },
    { folderPath: '/tmp/project-a', goal: 'g', maxConcurrentAgents: 11 },
    { folderPath: '/tmp/project-a', goal: 'g', maxConcurrentAgents: 2.5 },
  ]) {
    const bad = await tool(tools, 'sprint.create').handler(args as never)
    assert.equal(bad.isError, true, JSON.stringify(args))
    assert.equal((bad.structuredContent as { error: { code: string } }).error.code, 'invalid_arguments')
  }
}

// MC-2120 — `cli`, `cliModel`, and the sprint runtime fields were blind strings
// until an agent could enumerate them over MCP alone.
async function testCliRuntimeListReportsTheRegistry(): Promise<void> {
  const plugin = (id: string, overrides: Partial<LoadedPlugin['manifest']> = {}): LoadedPlugin => ({
    manifest: {
      id,
      displayName: id === 'claude-code' ? 'Claude Code' : id,
      version: 1,
      binary: id === 'claude-code' ? 'claude' : id,
      permissionPresets: { default: {}, bypass: {} },
      launch: { args: [] },
      promptInjection: { mode: 'argv' },
      completion: { mode: 'exit' },
      capabilities: { resumeSession: true, sessionIdFromCaller: false, toolUse: true, mcpServers: true },
      ...overrides,
    } as unknown as LoadedPlugin['manifest'],
    source: 'bundled',
    manifestPath: `/plugins/${id}/manifest.json`,
    pluginRoot: `/plugins/${id}`,
  })
  const tools = createAutomationTools({
    ...backendsOf(),
    listPlugins: () => [
      plugin('claude-code', {
        modelSelection: {
          args: ['--model', '{{model}}'],
          options: [{ id: 'claude-opus-5', label: 'Opus 5' }, { id: 'claude-sonnet-5' }],
          allowCustomId: true,
        },
        reasoningSelection: {
          args: ['--effort', '{{reasoning}}'],
          levels: [{ id: 'medium' }, { id: 'high', label: 'High' }],
          default: 'medium',
        },
      } as never),
      // A CLI that declares neither: it must still be listed, with the honest
      // empty answer — "no model may be passed" is not the same as "unlisted".
      plugin('plain-cli'),
      // Hooks-only selectability: a spec-less CLI stays LISTED (marked, not
      // omitted, so a remote caller holding a stale id learns why it is
      // refused) but flagged agentSelectable: false.
      plugin('hook-cli', {
        agentStateSpec: {
          registration: { kind: 'settings-json', path: '.claude/settings.local.json' },
          events: [{ event: 'Stop', phase: 'idle', turnEnd: true }],
        },
      } as never),
    ],
  })

  const listed = await tool(tools, 'cli.runtime.list').handler({})
  const clis = (listed.structuredContent as { clis: Array<Record<string, unknown>> }).clis
  assert.deepEqual(clis.map((entry) => entry.id), ['claude-code', 'plain-cli', 'hook-cli'])
  assert.deepEqual(
    clis.map((entry) => entry.agentSelectable),
    [false, false, true],
    'agentSelectable mirrors agentStateSpec presence — marked, never omitted'
  )
  assert.deepEqual(clis[0].models, [{ id: 'claude-opus-5', label: 'Opus 5' }, { id: 'claude-sonnet-5' }])
  assert.equal(clis[0].allowCustomModelId, true)
  assert.deepEqual(clis[0].reasoningLevels, [{ id: 'medium' }, { id: 'high', label: 'High' }])
  assert.equal(clis[0].defaultReasoningLevel, 'medium')
  assert.deepEqual(clis[0].permissionPresets, ['default', 'bypass'])
  assert.equal(clis[1].supportsModelSelection, false)
  assert.deepEqual(clis[1].models, [])
  assert.equal(clis[1].allowCustomModelId, false)
  assert.equal(clis[1].defaultReasoningLevel, null)

  const one = await tool(tools, 'cli.runtime.list').handler({ cli: 'plain-cli' })
  assert.deepEqual(
    (one.structuredContent as { clis: Array<{ id: string }> }).clis.map((entry) => entry.id),
    ['plain-cli']
  )

  // An unknown id fails rather than answering an empty list a caller would read
  // as "this CLI exists and declares nothing".
  const unknown = await tool(tools, 'cli.runtime.list').handler({ cli: 'no-such-cli' })
  assert.equal(unknown.isError, true)
  assert.equal((unknown.structuredContent as { error: { code: string } }).error.code, 'unknown_cli')
}

// MC-2137 — starting a sprint from an epic whose ordering was never declared
// finished. The gate INFORMS: the run is always created, and the response says
// what happened to the intake.
async function testSprintCreateWarnsOnAnUnmarkedEpic(): Promise<void> {
  const workspace = testWorkspace('ws-sprint', { folderPath: '/tmp/project-a', mode: 'sprintengine' as never })
  const epics: Record<string, { isEpic: boolean; dependenciesPlanned?: boolean }> = {
    'backlog/epics/unmarked.md': { isEpic: true },
    'backlog/epics/marked.md': { isEpic: true, dependenciesPlanned: true },
    'backlog/plain-item.md': { isEpic: false },
    // `type: epic` outside backlog/epics/: a real epic to the panel, but not an
    // epic LAUNCH — the run plans regardless, so there is nothing to warn about.
    'backlog/stray-epic.md': { isEpic: true },
  }
  const tools = createAutomationTools({
    ...backendsOf(),
    getWorkspaceSyncSnapshot: () => snapshotOf([workspace]),
    createSprint: async () => ({ ok: true, workspaceId: 'ws-sprint' }),
    readBacklogItem: async (_root, relativePath) => {
      const item = epics[relativePath]
      return item
        ? { ok: true, item: { relativePath, title: 'x', status: 'ready', ...item }, body: '' }
        : { ok: false, message: `no item ${relativePath}` }
    },
  })
  const warningsOf = async (args: Record<string, unknown>): Promise<string[]> => {
    const result = await tool(tools, 'sprint.create').handler(args as never)
    assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent))
    return ((result.structuredContent as { warnings?: string[] }).warnings ?? [])
  }

  const explicitDirect = await warningsOf({
    folderPath: '/tmp/project-a',
    sourceRef: 'backlog/epics/unmarked.md',
    intake: 'direct',
  })
  assert.equal(explicitDirect.length, 1, 'an explicit direct over an unmarked epic is warned about, not refused')
  assert.match(explicitDirect[0], /dependenciesPlanned/)
  assert.match(explicitDirect[0], /unordered/)

  const omitted = await warningsOf({ folderPath: '/tmp/project-a', sourceRef: 'backlog/epics/unmarked.md' })
  assert.equal(omitted.length, 1, 'omitting intake on an unmarked epic no longer takes the epic default silently')
  assert.match(omitted[0], /"planned"/)

  // The states with nothing to say: a marked epic, an explicit planned request,
  // a non-epic source, and a source that cannot be read at all.
  assert.deepEqual(await warningsOf({ folderPath: '/tmp/project-a', sourceRef: 'backlog/epics/marked.md' }), [])
  assert.deepEqual(
    await warningsOf({ folderPath: '/tmp/project-a', sourceRef: 'backlog/epics/unmarked.md', intake: 'planned' }),
    [],
  )
  assert.deepEqual(await warningsOf({ folderPath: '/tmp/project-a', sourceRef: 'backlog/plain-item.md' }), [])
  assert.deepEqual(
    await warningsOf({ folderPath: '/tmp/project-a', sourceRef: 'backlog/stray-epic.md', intake: 'direct' }),
    [],
    'a file outside backlog/epics/ never launches as an epic source, marked or not',
  )
  assert.deepEqual(
    await warningsOf({ folderPath: '/tmp/project-a', sourceRef: 'backlog/gone.md' }),
    [],
    'an unreadable source costs the warning, never the run',
  )
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
    resolveModuleTools: () => [],
    isModuleEnabled: () => true,
  })()
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
    () =>
      createStudioGatewayTools({
        appTools: [appTool, appTool],
        sprintEngineMcpHub: { callRunTool: async () => ({}) },
        resolveModuleTools: () => [],
        isModuleEnabled: () => true,
      }),
    /Duplicate SprintEngine Studio MCP tool/
  )
  assert.equal(isStudioGatewayMutation('backlog.update'), true)
  assert.equal(isStudioGatewayMutation('backlog.repair'), true)
  assert.equal(isStudioGatewayMutation('backlog.list'), false)
  assert.equal(isStudioGatewayMutation('sprintengine.task.publish'), true)
  assert.equal(isStudioGatewayMutation('sprintengine.vcs.commit'), true)
  assert.equal(isStudioGatewayMutation('sprintengine.plan.add_task'), true)
  assert.equal(isStudioGatewayMutation('sprintengine.task.list'), false)
  // browser-pane child 6: acting on the page is a mutation, looking at it is not.
  assert.equal(isStudioGatewayMutation('browser.click'), true)
  assert.equal(isStudioGatewayMutation('browser.open'), true)
  assert.equal(isStudioGatewayMutation('browser.snapshot'), false)

  // A module's tool classifies itself (D11): core has no table it could appear
  // in, so `mutates: true` on the registration is what makes a remote caller
  // need `<family>:operate` and what puts the call in the audit. Read live from
  // the gateway's own resolver, so a module enabled mid-session is honoured.
  const moduleWrites: McpToolRegistration = {
    name: 'widget_write',
    description: 'writes',
    inputSchema: { type: 'object' },
    mutates: true,
    handler: async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
  }
  const moduleReads: McpToolRegistration = {
    name: 'widget_read',
    description: 'reads',
    inputSchema: { type: 'object' },
    handler: async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
  }
  const resolveWidgetTools = createStudioGatewayTools({
    appTools: [],
    sprintEngineMcpHub: { callRunTool: async () => ({}) },
    resolveModuleTools: () => [
      { moduleId: 'widgets', moduleDisplayName: 'Widgets', registration: moduleWrites },
      { moduleId: 'widgets', moduleDisplayName: 'Widgets', registration: moduleReads },
    ],
    isModuleEnabled: () => true,
  })
  assert.equal(isStudioGatewayMutation('widget_write', resolveWidgetTools), true)
  assert.equal(isStudioGatewayMutation('widget_read', resolveWidgetTools), false)
  assert.equal(
    isStudioGatewayMutation('widget_write'),
    false,
    'without a resolver only the core tables answer — nothing is invented'
  )
  assert.equal(
    requiredScopeForTool('widget_write', isStudioGatewayMutation('widget_write', resolveWidgetTools)),
    'workspace:operate',
    'a declared write needs the operate scope a remote device must be granted'
  )
  assert.equal(
    requiredScopeForTool('widget_read', isStudioGatewayMutation('widget_read', resolveWidgetTools)),
    'workspace:read',
    'and an undeclared one stays on the read scope'
  )
  // The review module's one writer rides the same declaration, now that
  // `review_submit_brief` has left core's table.
  assert.equal(isStudioGatewayMutation('review_submit_brief'), false, 'core no longer classifies it by name')
}

// MC-1855: two modules registering the same tool name → the second is rejected
// as a module load error, the first registration wins, and the gateway keeps
// serving. Also proves an SDK-shaped third-party module's tool reaches the
// gateway through loadMainModules (the external-project fixture's shape).
async function testModuleMcpToolContributionOwnershipAndCollisions(): Promise<void> {
  const registrationOf = (name: string, answer: string): McpToolRegistration => ({
    name,
    description: `test tool ${answer}`,
    inputSchema: { type: 'object', properties: {} },
    handler: async () => ({ content: [{ type: 'text', text: answer }], structuredContent: { answer } }),
  })
  const moduleOf = (id: string, tools: McpToolRegistration[]): CapabilityModule => ({
    manifest: {
      id,
      displayName: id,
      version: 1,
      publisher: 'example-author',
      summary: 'test module',
      defaultEnabled: true,
      source: 'third-party',
    },
    registerMain: (host) => host.registerMcpTools(tools),
  })
  const { kernel, report } = loadMainModules({
    ipcMain: createFakeIpcMain().ipcMain,
    modules: [
      moduleOf('first-owner', [registrationOf('weather_deck_forecast', 'first')]),
      moduleOf('second-owner', [
        registrationOf('second_owner_extra', 'extra'),
        registrationOf('weather_deck_forecast', 'second'),
      ]),
    ],
  })
  assert.deepEqual(report.loaded, ['first-owner'], 'first registration wins')
  assert.equal(report.errors.length, 1)
  assert.equal(report.errors[0]?.id, 'second-owner', 'the collision is a module load error')
  assert.match(report.errors[0]?.message ?? '', /already registered by module "first-owner"/)

  const warnings: string[] = []
  const resolveGatewayTools = createStudioGatewayTools({
    appTools: [],
    sprintEngineMcpHub: { callRunTool: async () => ({}) },
    resolveModuleTools: () => kernel.mcpToolRegistrations(),
    isModuleEnabled: () => true,
    warn: (text) => warnings.push(text),
  })
  const served = resolveGatewayTools()
  const forecast = tool(served, 'weather_deck_forecast')
  const answered = await forecast.handler({})
  assert.deepEqual(answered.structuredContent, { answer: 'first' }, 'the gateway keeps serving the first owner')
  assert.equal(
    served.some((registration) => registration.name === 'second_owner_extra'),
    false,
    'a rejected batch registers nothing, not half'
  )
  assert.deepEqual(warnings, [], 'a kernel-rejected collision never reaches the gateway merge')

  // A module shadowing a CORE tool name is skipped with a warning; core wins,
  // and the warning fires once, not on every per-request resolution.
  const shadowWarnings: string[] = []
  const coreTool = registrationOf('workspace.list', 'core')
  const resolveShadowed = createStudioGatewayTools({
    appTools: [coreTool],
    sprintEngineMcpHub: { callRunTool: async () => ({}) },
    resolveModuleTools: () => [
      { moduleId: 'first-owner', moduleDisplayName: 'first-owner', registration: registrationOf('workspace.list', 'shadow') },
    ],
    isModuleEnabled: () => true,
    warn: (text) => shadowWarnings.push(text),
  })
  const shadowed = resolveShadowed()
  const coreAnswer = await tool(shadowed, 'workspace.list').handler({})
  assert.deepEqual(coreAnswer.structuredContent, { answer: 'core' })
  resolveShadowed()
  assert.equal(shadowWarnings.length, 1, 'the collision warns once across resolutions')
  assert.match(shadowWarnings[0] ?? '', /collides with a core gateway tool/)
}

// MC-1855 end-to-end (MC-2120 item 4): the plumbing is unit-tested at the
// kernel and the gateway merge, but nothing proved the last hop — that a real
// connected MCP session LISTS a module's tool and can CALL it. This drives the
// whole path a connected agent drives: module kernel → gateway resolver →
// socket server → JSON-RPC tools/list + tools/call.
async function testModuleContributedToolIsLiveOnAConnectedSession(): Promise<void> {
  const socketPath = join(mkdtempSync(join(tmpdir(), 'multicode-module-tool-')), 'automation.sock')
  const forecastTool: McpToolRegistration = {
    name: 'weather_deck_forecast',
    description: 'Forecast from the fixture module.',
    inputSchema: { type: 'object', properties: { city: { type: 'string' } } },
    handler: async (args) => ({
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: { city: args.city, sky: 'clear' },
    }),
  }
  const fixtureModule: CapabilityModule = {
    manifest: {
      id: 'weather-deck',
      displayName: 'Weather Deck',
      version: 1,
      publisher: 'example-author',
      summary: 'fixture module',
      defaultEnabled: true,
      source: 'third-party',
    },
    registerMain: (host) => host.registerMcpTools([forecastTool]),
  }
  const { kernel, report } = loadMainModules({ ipcMain: createFakeIpcMain().ipcMain, modules: [fixtureModule] })
  assert.deepEqual(report.loaded, ['weather-deck'])

  let moduleEnabled = true
  const resolveGatewayTools = createStudioGatewayTools({
    appTools: createAutomationTools(backendsOf()),
    sprintEngineMcpHub: { callRunTool: async () => ({}) },
    resolveModuleTools: () => kernel.mcpToolRegistrations(),
    isModuleEnabled: () => moduleEnabled,
  })
  const server = createMcpSocketServer({
    socketPath,
    serverName: 'multicode-automation',
    serverVersion: '0.0.0-test',
    resolveTools: resolveGatewayTools,
  })
  await server.start()
  try {
    const socket = connect(socketPath)
    socket.setEncoding('utf8')
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve())
      socket.once('error', reject)
    })
    const responses = new Map<unknown, Record<string, unknown>>()
    let buffer = ''
    socket.on('data', (chunk: string) => {
      buffer += chunk
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line) {
          const parsed = JSON.parse(line) as Record<string, unknown>
          responses.set(parsed.id, parsed)
        }
        newline = buffer.indexOf('\n')
      }
    })
    const call = async (id: number, method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> => {
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })}\n`)
      const deadline = Date.now() + 5_000
      while (!responses.has(id)) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${method}`)
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      return responses.get(id) as Record<string, unknown>
    }

    // A Studio-launched agent's bridge announces itself, then lists.
    socket.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'sprintengine.studio/connect', params: { agentId: 'agent-a', workspaceId: 'ws-1' } })}\n`)
    const listed = await call(1, 'tools/list')
    const names = (listed.result as { tools: Array<{ name: string; description: string }> }).tools
    const contributed = names.find((entry) => entry.name === 'weather_deck_forecast')
    assert.ok(contributed, 'the module tool is listed to a live session alongside the core tools')
    assert.equal(contributed.description, 'Forecast from the fixture module.')
    assert.ok(names.some((entry) => entry.name === 'workspace.list'), 'core tools are still served')
    // The discovery tool is only useful if a connected agent can actually see
    // it, so prove it on the same live listing rather than in isolation.
    assert.ok(
      names.some((entry) => entry.name === 'cli.runtime.list'),
      'cli.runtime.list reaches the connected session that needs it'
    )

    const answered = await call(2, 'tools/call', { name: 'weather_deck_forecast', arguments: { city: 'Dublin' } })
    assert.deepEqual(
      (answered.result as { structuredContent: Record<string, unknown> }).structuredContent,
      { city: 'Dublin', sky: 'clear' },
      'the module handler runs for the connected session'
    )

    // Disabling the owner mid-session keeps the tool ADVERTISED and answers an
    // actionable error instead of running it (MC-1805), live on the same
    // connection — the enablement gate is resolved per call, not captured.
    moduleEnabled = false
    const relisted = await call(3, 'tools/list')
    assert.ok(
      (relisted.result as { tools: Array<{ name: string }> }).tools.some((entry) => entry.name === 'weather_deck_forecast'),
      'a disabled module keeps advertising its capability'
    )
    const refused = await call(4, 'tools/call', { name: 'weather_deck_forecast', arguments: {} })
    const refusal = refused.result as { isError?: boolean; structuredContent: { error: { code: string; message: string } } }
    assert.equal(refusal.isError, true)
    assert.equal(refusal.structuredContent.error.code, 'weather-deck_module_disabled')
    assert.match(refusal.structuredContent.error.message, /Weather Deck module is disabled/)

    socket.destroy()
  } finally {
    await server.stop()
  }
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
// The tools are routed through the REAL contribution path (MC-1855): a module
// host kernel owns the registration under the `review` module id, and the
// gateway resolver gates every call on the module's live enablement — exactly
// the seam review-module.ts registers through in the app.
function reviewHarness(): {
  tools: McpToolRegistration[]
  projectRoot: string
  reviewDir: string
  emitted: BriefRunEvent[]
  /** Flip the Review module the way Settings does, mid-session. */
  setModuleEnabled: (enabled: boolean) => void
  /** Re-resolve the gateway's review tool names, as a fresh tools/list would. */
  listReviewToolNames: () => string[]
} {
  const projectRoot = mkdtempSync(join(tmpdir(), 'review-gw-'))
  const reviewDir = reviewChangeSetDir(projectRoot, REVIEW_ID)
  mkdirSync(reviewDir, { recursive: true })
  writeFileSync(join(reviewDir, 'changeset.json'), `${JSON.stringify(reviewFixtureChangeSet(projectRoot), null, 2)}\n`)
  const emitted: BriefRunEvent[] = []
  let moduleEnabled = true
  const kernel = createMainKernel(createFakeIpcMain().ipcMain, {
    resolveModuleManifest: (moduleId) =>
      moduleId === 'review'
        ? {
            id: 'review',
            displayName: 'Review',
            version: 1,
            publisher: 'multicode',
            summary: 'Guided review.',
            defaultEnabled: true,
          }
        : undefined,
  })
  kernel.hostFor('review').registerMcpTools(
    createReviewGatewayTools({
      listOpenProjectRoots: () => [projectRoot],
      homeDir: () => homedir(),
      emitBriefRunEvent: (event) => emitted.push(event),
    })
  )
  const resolveGatewayTools = createStudioGatewayTools({
    appTools: [],
    sprintEngineMcpHub: { callRunTool: async () => ({}) },
    resolveModuleTools: () => kernel.mcpToolRegistrations(),
    isModuleEnabled: (moduleId) => moduleId !== 'review' || moduleEnabled,
  })
  // The resolver also carries the canonical run tools; the review tests address
  // the review slice only.
  const tools = resolveGatewayTools().filter((registration) => registration.name.startsWith('review_'))
  return {
    tools,
    projectRoot,
    reviewDir,
    emitted,
    setModuleEnabled: (enabled) => {
      moduleEnabled = enabled
    },
    listReviewToolNames: () =>
      resolveGatewayTools()
        .filter((registration) => registration.name.startsWith('review_'))
        .map((registration) => registration.name),
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
  const { tools, projectRoot, reviewDir, emitted, setModuleEnabled, listReviewToolNames } = reviewHarness()
  try {
    setModuleEnabled(false)
    assert.deepEqual(
      listReviewToolNames(),
      ['review_list_pending', 'review_get_changeset', 'review_get_brief', 'review_submit_brief'],
      'a disabled module still lists its tools on a fresh tools/list resolution'
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

// --- module.* / marketplace.* (MC-2078) --------------------------------------

function registryEntry(
  manifest: CapabilityManifest,
  overrides: Partial<ModuleRegistryEntry> = {}
): ModuleRegistryEntry {
  return {
    id: manifest.id,
    manifest,
    source: manifest.source ?? 'bundled',
    enabled: true,
    absence: null,
    surfaces: { ...EMPTY_MODULE_SURFACES },
    ...overrides,
  }
}

function registrySnapshot(
  modules: ModuleRegistryEntry[],
  channel: ModuleRegistrySnapshot['channel'] = 'development'
): ModuleRegistrySnapshot {
  return { capturedAt: Date.parse('2026-08-06T10:00:00Z'), channel, modules }
}

function installedModuleView(
  id: string,
  trust: ThirdPartyModuleView['trust'],
  launch: Partial<ThirdPartyModuleView['launch']> = {}
): ThirdPartyModuleView {
  return {
    manifest: { id, displayName: `Module ${id}`, version: 3, defaultEnabled: true, source: 'third-party' },
    trust,
    launch: { status: 'blocked_unsigned', hasMainEntry: true, expectedToLoad: false, ...launch },
  }
}

async function testModuleToolsReportTheRegistryTheUserSees(): Promise<void> {
  const snapshot = registrySnapshot([
    registryEntry(
      {
        id: 'sprint-engine',
        displayName: 'Sprint Engine',
        version: 1,
        category: 'orchestration',
        defaultEnabled: true,
        dependsOn: ['agent-runtime'],
      },
      {
        surfaces: {
          ...EMPTY_MODULE_SURFACES,
          globalSurfaces: ['sprints'],
          workspaceTypes: ['sprintengine'],
        },
      }
    ),
    registryEntry(
      { id: 'git', displayName: 'Git panel', version: 1, defaultEnabled: true },
      { enabled: false, absence: { reason: 'disabled', message: 'Module "git" is not enabled (Settings → Modules).' } }
    ),
    registryEntry(
      {
        id: 'weather',
        displayName: 'Weather',
        version: 2,
        defaultEnabled: true,
        source: 'third-party',
        permissions: ['workspace.read'],
      }
    ),
  ])
  const tools = createAutomationTools(
    backendsOf({
      getModuleRegistrySnapshot: () => snapshot,
      // `weather` loaded; `sketchy` is installed on disk but never trusted, so
      // the renderer registry has never heard of it.
      listInstalledThirdPartyModules: async () => ({
        modules: [
          installedModuleView('weather', 'trusted', { status: 'trusted_executable', expectedToLoad: true }),
          installedModuleView('sketchy', 'unsigned'),
        ],
        rejected: [],
      }),
      listModuleContributedTools: () => [{ moduleId: 'weather', toolName: 'weather.forecast' }],
    })
  )

  const listed = await tool(tools, 'module.list').handler({})
  const modules = (listed.structuredContent as {
    modules: Array<{ id: string; source: string; enabled: boolean; installed: boolean; absence: { reason: string } | null; trust?: string }>
  }).modules
  assert.deepEqual(
    modules.map((module) => module.id).sort(),
    ['git', 'sketchy', 'sprint-engine', 'weather'],
    'every module the user could see is listed, including an installed-but-untrusted one'
  )
  const git = modules.find((module) => module.id === 'git')
  assert.equal(git?.enabled, false)
  assert.equal(git?.absence?.reason, 'disabled', 'a switched-off module says so instead of vanishing')
  const sketchy = modules.find((module) => module.id === 'sketchy')
  assert.equal(sketchy?.installed, true, 'an untrusted module is still installed')
  assert.equal(sketchy?.enabled, false)
  assert.equal(sketchy?.absence?.reason, 'untrusted')
  assert.equal(sketchy?.trust, 'unsigned')
  assert.equal(
    modules.find((module) => module.id === 'weather')?.trust,
    'trusted',
    'main-owned trust rides along for a loaded third-party module'
  )

  const thirdParty = await tool(tools, 'module.list').handler({ source: 'third-party' })
  assert.deepEqual(
    (thirdParty.structuredContent as { modules: Array<{ id: string }> }).modules.map((module) => module.id).sort(),
    ['sketchy', 'weather']
  )
  const enabledOnly = await tool(tools, 'module.list').handler({ enabled: true })
  assert.deepEqual(
    (enabledOnly.structuredContent as { modules: Array<{ id: string }> }).modules.map((module) => module.id),
    ['sprint-engine', 'weather']
  )
  assert.equal(
    (await tool(tools, 'module.list').handler({ source: 'nope' })).isError,
    true,
    'an unknown source is rejected rather than filtered to nothing'
  )

  const status = await tool(tools, 'module.status').handler({ id: 'sprint-engine' })
  const detail = (status.structuredContent as {
    module: { manifest: { id: string }; dependsOn: string[]; surfaces: { globalSurfaces: string[] }; contributedTools: string[] }
  }).module
  assert.equal(detail.manifest.id, 'sprint-engine')
  assert.deepEqual(detail.dependsOn, ['agent-runtime'])
  assert.deepEqual(detail.surfaces.globalSurfaces, ['sprints'], 'contributed surfaces are reported, not guessed')
  assert.deepEqual(detail.contributedTools, [], 'sprint-engine contributes no gateway tool in this fixture')
  const weatherStatus = await tool(tools, 'module.status').handler({ id: 'weather' })
  assert.deepEqual(
    (weatherStatus.structuredContent as { module: { contributedTools: string[]; permissions: string[] } }).module,
    {
      ...(weatherStatus.structuredContent as { module: Record<string, unknown> }).module,
      contributedTools: ['weather.forecast'],
      permissions: ['workspace.read'],
    }
  )

  // An installed-but-untrusted module still reports its own manifest — the
  // declared permissions are what a caller reads BEFORE deciding to trust it —
  // and null surfaces, because it registered nothing.
  const untrusted = await tool(tools, 'module.status').handler({ id: 'sketchy' })
  const untrustedDetail = (untrusted.structuredContent as {
    module: { manifest: { id: string } | null; surfaces: unknown; absence: { reason: string }; trust: string }
  }).module
  assert.equal(untrustedDetail.manifest?.id, 'sketchy')
  assert.equal(untrustedDetail.surfaces, null, 'a module that never loaded contributes nothing')
  assert.equal(untrustedDetail.absence.reason, 'untrusted')
  assert.equal(untrustedDetail.trust, 'unsigned')

  const unknown = await tool(tools, 'module.status').handler({ id: 'nothing-like-this' })
  assert.equal((unknown.structuredContent as { error: { code: string } }).error.code, 'unknown_module')
}

// MC-2078 x MC-1855, the seam neither item owns: the gateway serves a module's
// tools and `module.*` DESCRIBES that same module, from what should be one
// source of truth (`app-services.ts` hands the same `resolveModuleMcpTools()` to
// both). `testModuleContributedToolIsLiveOnAConnectedSession` above proves the
// tool is listed, callable and enablement-gated; this proves the description
// agrees with it — over one live session, cross-checked against the wire rather
// than against a literal, so a `module.status` reading some other registry fails
// here instead of misreporting the app to an agent.
async function testModuleStatusAgreesWithTheToolsTheGatewayServes(): Promise<void> {
  const socketPath = join(mkdtempSync(join(tmpdir(), 'multicode-module-agree-')), 'automation.sock')
  const forecastTool: McpToolRegistration = {
    name: 'weather_deck_forecast',
    description: 'Forecast from the fixture module.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => ({ content: [{ type: 'text', text: 'ok' }], structuredContent: { sky: 'clear' } }),
  }
  const manifest = {
    id: 'weather-deck',
    displayName: 'Weather Deck',
    version: 1,
    publisher: 'example-author',
    summary: 'fixture module',
    defaultEnabled: true,
    source: 'third-party' as const,
  }
  const fixtureModule: CapabilityModule = { manifest, registerMain: (host) => host.registerMcpTools([forecastTool]) }
  const { kernel } = loadMainModules({ ipcMain: createFakeIpcMain().ipcMain, modules: [fixtureModule] })

  // The one resolver, behind both surfaces — the production wiring. Feeding the
  // gateway and `module.status` separate literals would agree by construction.
  let moduleEnabled = true
  const appTools = createAutomationTools(
    backendsOf({
      getModuleRegistrySnapshot: () =>
        registrySnapshot([
          registryEntry(
            manifest,
            moduleEnabled
              ? {}
              : { enabled: false, absence: { reason: 'disabled', message: 'Module "weather-deck" is not enabled (Settings -> Modules).' } }
          ),
        ]),
      listModuleContributedTools: () =>
        kernel.mcpToolRegistrations().map((entry) => ({ moduleId: entry.moduleId, toolName: entry.registration.name })),
    })
  )
  const server = createMcpSocketServer({
    socketPath,
    serverName: 'sprintengine-studio',
    serverVersion: '0.0.0-test',
    resolveTools: createStudioGatewayTools({
      appTools,
      sprintEngineMcpHub: { callRunTool: async () => ({}) },
      resolveModuleTools: () => kernel.mcpToolRegistrations(),
      isModuleEnabled: () => moduleEnabled,
    }),
  })
  await server.start()
  const socket = connect(socketPath)
  socket.setEncoding('utf8')
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve())
      socket.once('error', reject)
    })
    const responses = new Map<number, Record<string, unknown>>()
    let buffer = ''
    socket.on('data', (chunk: string) => {
      buffer += chunk
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line) {
          const message = JSON.parse(line) as { id?: number }
          if (typeof message.id === 'number') responses.set(message.id, message)
        }
        newline = buffer.indexOf('\n')
      }
    })
    let nextId = 0
    const rpc = async (method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> => {
      nextId += 1
      const id = nextId
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })}\n`)
      const deadline = Date.now() + 5_000
      while (!responses.has(id)) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${method}`)
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      return responses.get(id) as Record<string, unknown>
    }
    const callTool = async (name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
      const response = await rpc('tools/call', { name, arguments: args })
      const result = (response as { result?: { structuredContent?: Record<string, unknown> } }).result
      assert.ok(result, `tools/call ${name} errored: ${JSON.stringify(response)}`)
      return result.structuredContent ?? {}
    }

    await rpc('initialize', { protocolVersion: '2025-03-26' })
    socket.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)

    // What the session is actually served, minus everything core owns: whatever
    // is left is this module's, and is what module.status must name.
    const coreNames = new Set(createAutomationTools(backendsOf()).map((entry) => entry.name))
    const servedByModule = (
      (await rpc('tools/list')) as { result: { tools: Array<{ name: string }> } }
    ).result.tools
      .map((entry) => entry.name)
      .filter(
        (name) => !coreNames.has(name) && !(SPRINTENGINE_TOOL_NAMES as readonly string[]).includes(name),
      )
    assert.deepEqual(servedByModule, ['weather_deck_forecast'], 'the session is served exactly one module tool')

    const status = (await callTool('module.status', { id: 'weather-deck' })) as {
      module: { contributedTools: string[]; absence: { reason: string } | null }
    }
    assert.deepEqual(
      status.module.contributedTools,
      servedByModule,
      'module.status names the tools the gateway is really serving, read off this session'
    )
    assert.equal(status.module.absence, null, 'and reports the module as present while it is serving them')

    // Switching it off in Settings is ONE change with one meaning. The gateway
    // keeps advertising the tool (a caller learns why), and the description
    // surface must flip with it — the failure this guards is module.status
    // reporting an enabled module whose tools every call refuses.
    moduleEnabled = false
    const refused = (await callTool('weather_deck_forecast')) as { error?: { code: string } }
    assert.equal(refused.error?.code, 'weather-deck_module_disabled')
    const disabled = (await callTool('module.status', { id: 'weather-deck' })) as {
      module: { absence: { reason: string } | null }
    }
    assert.equal(
      disabled.module.absence?.reason,
      'disabled',
      'module.status and the gateway agree about enablement at the same instant'
    )
    const listedRow = (
      (await callTool('module.list')) as { modules: Array<{ id: string; enabled: boolean }> }
    ).modules.find((entry) => entry.id === 'weather-deck')
    assert.equal(listedRow?.enabled, false, 'module.list shows the same switched-off module Settings does')
  } finally {
    socket.destroy()
    await server.stop()
  }
}

async function testDevOnlyModulesAreAbsentFromAPackagedBuild(): Promise<void> {
  // A packaged build's renderer registry never carries the dev-only modules —
  // `activeForChannel` drops them — so the tools must report absence, never a
  // present-but-disabled row.
  const tools = createAutomationTools(
    backendsOf({
      getModuleRegistrySnapshot: () =>
        registrySnapshot(
          [registryEntry({ id: 'backlog', displayName: 'Backlog', version: 1, defaultEnabled: true })],
          'production'
        ),
    })
  )
  const listed = await tool(tools, 'module.list').handler({})
  const listedIds = (listed.structuredContent as { modules: Array<{ id: string }> }).modules.map((m) => m.id)
  assert.deepEqual(listedIds, ['backlog'], 'no dev-only module appears in a packaged build')
  assert.equal((listed.structuredContent as { channel: string }).channel, 'production')

  const devOnly = await tool(tools, 'module.status').handler({ id: 'review' })
  const error = (devOnly.structuredContent as { error: { code: string; message: string } }).error
  assert.equal(error.code, 'module_not_in_build', 'a dev-only id is absent, not disabled')
  assert.match(error.message, /development builds/)
}

async function testModuleToolsRefuseBeforeTheRegistryArrives(): Promise<void> {
  const tools = createAutomationTools(backendsOf())
  for (const [name, args] of [
    ['module.list', {}],
    ['module.status', { id: 'git' }],
  ] as Array<[string, Record<string, unknown>]>) {
    const answered = await tool(tools, name).handler(args)
    assert.equal(answered.isError, true, `${name} fails explicitly`)
    assert.equal(
      (answered.structuredContent as { error: { code: string } }).error.code,
      'module_registry_unavailable',
      `${name} never reports an empty registry as fact`
    )
  }
}

async function testMarketplaceListReadsTheSameIndexTheDoorReads(): Promise<void> {
  const marketplace = {
    schemaVersion: 1 as const,
    plugins: [
      {
        id: 'weather-module',
        name: 'Weather',
        publisher: { name: 'Acme', verified: true },
        summary: 'Local forecasts in a panel.',
        category: 'Insight',
        icon: 'cloud',
        latest: 3,
        provides: ['module'] as MarketplaceComponentKind[],
        source: 'https://example.test/weather.zip',
        tags: ['forecast'],
      },
      {
        id: 'railway-mcp',
        name: 'Railway',
        publisher: { name: 'Railway', verified: false },
        summary: 'Deploy from an agent.',
        category: 'Connectivity',
        icon: 'train',
        latest: 1,
        provides: ['mcp'] as MarketplaceComponentKind[],
      },
    ],
  }
  const reads: Array<MarketplaceRegistryReadInput | undefined> = []
  const tools = createAutomationTools(
    backendsOf({
      readMarketplaceRegistry: async (input) => {
        reads.push(input)
        return {
          ok: true,
          state: 'ok',
          registryUrl: 'https://example.test/marketplace.json',
          source: 'bundled',
          stale: false,
          fetchedAt: '2026-08-06T09:00:00.000Z',
          marketplace,
        }
      },
    })
  )

  const all = await tool(tools, 'marketplace.list').handler({})
  const listed = all.structuredContent as {
    total: number
    matched: number
    plugins: Array<{ id: string; signed: boolean; bundleSource?: string }>
    source: string
  }
  assert.equal(listed.total, 2)
  assert.equal(listed.source, 'bundled', 'the read discloses where the index came from')
  assert.equal(listed.plugins.find((plugin) => plugin.id === 'weather-module')?.signed, false)

  const modulesOnly = await tool(tools, 'marketplace.list').handler({ provides: 'module' })
  assert.deepEqual(
    (modulesOnly.structuredContent as { plugins: Array<{ id: string }> }).plugins.map((plugin) => plugin.id),
    ['weather-module'],
    'the module-first facet is a provides filter over the same index'
  )
  const searched = await tool(tools, 'marketplace.list').handler({ query: 'RAILWAY' })
  assert.deepEqual(
    (searched.structuredContent as { plugins: Array<{ id: string }> }).plugins.map((plugin) => plugin.id),
    ['railway-mcp']
  )
  await tool(tools, 'marketplace.list').handler({ forceRefresh: true })
  assert.deepEqual(reads, [undefined, undefined, undefined, { forceRefresh: true }])
  assert.equal(
    (await tool(tools, 'marketplace.list').handler({ provides: 'widgets' })).isError,
    true,
    'an unknown component kind is rejected'
  )

  const offline = createAutomationTools(
    backendsOf({
      readMarketplaceRegistry: async () => ({
        ok: false,
        state: 'fetch-error',
        registryUrl: 'https://example.test/marketplace.json',
        stale: false,
        message: 'network unreachable',
      }),
    })
  )
  const failed = await tool(offline, 'marketplace.list').handler({})
  assert.equal(failed.isError, true)
  const failure = (failed.structuredContent as { error: { code: string; message: string } }).error
  assert.equal(failure.code, 'marketplace_unavailable', 'a failed registry read never renders as an empty catalogue')
  assert.match(failure.message, /network unreachable/)
}

async function testModuleAndMarketplaceToolsAreReadOnly(): Promise<void> {
  // MC-2078 defers install/uninstall/enable to the trust-modelled item, and the
  // gateway's mutation classifier must agree: none of these tools may be
  // audited or gated as a mutation.
  for (const name of ['module.list', 'module.status', 'marketplace.list']) {
    assert.equal(isStudioGatewayMutation(name), false, `${name} is a read`)
  }
  const tools = createAutomationTools(backendsOf())
  for (const name of ['module.list', 'module.status', 'marketplace.list']) {
    const schema = tool(tools, name).inputSchema as { additionalProperties?: boolean }
    assert.equal(schema.additionalProperties, false, `${name} refuses unknown arguments`)
  }
  assert.equal(
    tools.some((registration) => /^module\.(install|uninstall|enable|disable)$/.test(registration.name)),
    false,
    'no module mutation reached this surface'
  )
}

// ── Mobile companion over the gateway (tailnet-mobile-transport) ───────────

async function testMobileSnapshotToolServesTheCompanionReadModel(): Promise<void> {
  const reads: Array<{ include?: string[]; knownSnapshotVersion?: string }> = []
  const tools = createAutomationTools(
    backendsOf({
      mobileControl: {
        readSnapshot: async (input) => {
          reads.push(input)
          if (input.knownSnapshotVersion === 'snap_current') {
            return { unchanged: true as const, snapshotVersion: 'snap_current' }
          }
          return {
            unchanged: false as const,
            snapshot: { protocolVersion: 2, snapshotVersion: 'snap_current', sprintEngines: [] },
          }
        },
        dispatchCommand: async () => {
          throw new Error('not under test')
        },
      },
    })
  )

  const full = await tool(tools, 'workspace.snapshot').handler({ include: ['sprintEngines', 'backlog'] })
  assert.equal(full.isError, undefined)
  const fullBody = full.structuredContent as { unchanged: boolean; snapshot: { snapshotVersion: string } }
  assert.equal(fullBody.unchanged, false)
  assert.equal(fullBody.snapshot.snapshotVersion, 'snap_current')
  assert.deepEqual(reads[0]?.include, ['sprintEngines', 'backlog'])

  const short = await tool(tools, 'workspace.snapshot').handler({ knownSnapshotVersion: 'snap_current' })
  assert.deepEqual(short.structuredContent, { unchanged: true, snapshotVersion: 'snap_current' })

  const badInclude = await tool(tools, 'workspace.snapshot').handler({ include: [''] })
  assert.equal(badInclude.isError, true)
}

async function testMobileCommandToolDispatchesOnlyTheServedEnvelopes(): Promise<void> {
  const dispatched: Array<{ type: string; deviceId: string; idempotencyKey: string }> = []
  const tools = createAutomationTools(
    backendsOf({
      mobileControl: {
        readSnapshot: async () => {
          throw new Error('not under test')
        },
        dispatchCommand: async (input) => {
          dispatched.push({ type: input.type, deviceId: input.deviceId, idempotencyKey: input.idempotencyKey })
          if (input.type === 'sprintengine.create') {
            return { ok: false as const, code: 'path_not_allowed', message: 'workspace token matched no root' }
          }
          return {
            ok: true as const,
            commandId: 'tnc_1',
            commandType: input.type,
            executedAt: '2026-08-31T00:00:00.000Z',
            data: { relativePath: 'backlog/x.md' },
          }
        },
      },
    })
  )
  const reg = tool(tools, 'workspace.mobile_command')

  // The device identity comes from the transport metadata, never the args.
  const ok = await reg.handler(
    {
      type: 'backlog.update',
      payload: { workspacePath: 'ws_abc123', relativePath: 'backlog/x.md', status: 'ready' },
      idempotencyKey: 'idem-1',
    },
    { metadata: { kind: 'remote-tailnet', deviceId: 'tnd_phone' } }
  )
  assert.equal(ok.isError, undefined)
  assert.equal((ok.structuredContent as { ok: boolean }).ok, true)
  assert.deepEqual(dispatched[0], { type: 'backlog.update', deviceId: 'tnd_phone', idempotencyKey: 'idem-1' })

  // Backend refusals surface as tool errors with the backend's own code.
  const refusedByBackend = await reg.handler(
    { type: 'sprintengine.create', payload: { workspacePath: 'ws_zzz', productPrompt: 'x' }, idempotencyKey: 'idem-2' },
    { metadata: { kind: 'remote-tailnet', deviceId: 'tnd_phone' } }
  )
  assert.equal(refusedByBackend.isError, true)
  assert.match(JSON.stringify(refusedByBackend.structuredContent), /path_not_allowed/u)

  // A command type outside the served set never reaches the backend.
  const refusedByTool = await reg.handler({ type: 'device.revoke', payload: {}, idempotencyKey: 'idem-3' })
  assert.equal(refusedByTool.isError, true)
  assert.match(JSON.stringify(refusedByTool.structuredContent), /command_not_supported/u)
  assert.equal(dispatched.length, 2)
}

const tests = [
  testSettingsDefaultOnAndRoundTrip,
  testStudioGatewayStartsDespiteLegacyDisabledSetting,
  testStudioGatewayEndpointContractAcrossPlatforms,
  testToolListNamesTheToolSurface,
  testTerminalListReportsAttachableSessions,
  testReadToolsAnswerFromSnapshot,
  testReadToolsResolveWorkspaceRootThroughSnapshot,
  testReadToolsPassServiceFailuresThrough,
  testMobileSnapshotToolServesTheCompanionReadModel,
  testMobileCommandToolDispatchesOnlyTheServedEnvelopes,
  testBacklogRepairRoutesOnlyValidatedIntegrityOperations,
  testBacklogUpdateAppliesInOrderAndStopsOnFailure,
  testBacklogUpdateCarriesTheEpicOrderingMark,
  testBacklogAssignBuildsTheCanonicalLink,
  testBacklogWorkHandsItemToAgent,
  testBacklogWorkFallsBackAndRefusesFinishedItems,
  testBacklogWorkPresetGuardAndPostLaunchLinkFailure,
  testAutomationMutationToolsGateOnPresetAndModule,
  testBypassStaysRefusedAtTheExternalToolBoundary,
  testAutomationMutationToolsPassPipelineFailuresThrough,
  testSprintReadToolsAnswerFromDisk,
  testSprintCreateComposesInMainAndConfirms,
  testSprintCreateWarnsOnAnUnmarkedEpic,
  testSprintLifecycleToolsMutateViaMainServices,
  testSprintSteeringToolsMutateViaMainServices,
  testSprintVcsAndUsageToolsReadViaMainServices,
  testAgentLaunchWidensConfigAndIsolation,
  testTerminalCreateSpawnsAndReturnsTheAttachableSession,
  testTerminalCreateTakesThisMachinesLaunchDefaults,
  testWorkspaceCheckoutReportsTheBackendsFacts,
  testInvalidRequestsReturnExplicitErrors,
  testCreateMintsInMainWithNoWindow,
  testCreateSurfacesARegistryRefusal,
  testSocketServerSpeaksMcpAndOnlyWhenStarted,
  testInitializeNegotiatesTheProtocolVersionInsteadOfEchoingIt,
  testToolsAnswerAConnectionThatNeverInitialized,
  testPerRequestProtocolVersionDeclarationIsValidated,
  testStaleSocketFileIsReplacedOnStart,
  testBridgePipesStdioToSocketAndExitsOnServerStop,
  testConcurrentBridgesKeepResponsesAndAttributionIsolated,
  testBridgeFailsClearlyWithoutDiscoveryFile,
  testBridgeReportsStaleDiscoveryFile,
  testStudioGatewayMergesCanonicalRunToolsAndRoutesContext,
  testModuleMcpToolContributionOwnershipAndCollisions,
  testModuleContributedToolIsLiveOnAConnectedSession,
  testSprintCreateCarriesTheRunRuntime,
  testCliRuntimeListReportsTheRegistry,
  testStudioGatewayAuditIsRedactedAndRotated,
  testReviewSubmitBriefHappyPathWritesAtomicallyAndEmits,
  testReviewSubmitBriefInvalidReturnsEveryErrorAndWritesNothing,
  testReviewSubmitBriefRejectsSeverityAnnotationKind,
  testReviewToolsRejectUnknownTargetAndStripAbsolutePaths,
  testReviewToolsRefuseWhileTheModuleIsDisabled,
  testModuleToolsReportTheRegistryTheUserSees,
  testModuleStatusAgreesWithTheToolsTheGatewayServes,
  testDevOnlyModulesAreAbsentFromAPackagedBuild,
  testModuleToolsRefuseBeforeTheRegistryArrives,
  testMarketplaceListReadsTheSameIndexTheDoorReads,
  testModuleAndMarketplaceToolsAreReadOnly,
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
