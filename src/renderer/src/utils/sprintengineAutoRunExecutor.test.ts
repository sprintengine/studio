import assert from 'node:assert/strict'
import type { Workspace } from '../types/workspace'
import {
  TerminalListIpcError,
  bracketedTerminalPaste,
  listTerminalSessionsForAutoRun,
  publishTerminalListIpcFailureNotice,
  recordSpawnFailure,
  safeTerminalKill,
  safeTerminalStatus,
  spawnTerminalSession,
  writeBracketedPrompt,
  TERMINAL_LIST_IPC_NOTICE_COOLDOWN_MS,
  type SprintEngineAutoRunExecutorPorts,
} from './sprintengineAutoRunExecutor'

type Call = {
  method: string
  args: unknown[]
}

type FakePorts = {
  ports: SprintEngineAutoRunExecutorPorts
  calls: Call[]
}

function workspaceFixture(): Workspace {
  return {
    id: 'workspace-1',
    name: 'Auto-run workspace',
  } as Workspace
}

type Overrides = Partial<SprintEngineAutoRunExecutorPorts>

function createFakePorts(overrides: Overrides = {}): FakePorts {
  const calls: Call[] = []
  const record = (method: string, args: unknown[]): void => {
    calls.push({ method, args })
  }
  const fallback = <T>(value: T): (() => Promise<T>) => async () => value
  const ports: SprintEngineAutoRunExecutorPorts = {
    ensureSprintEngineTaskWorktree:
      overrides.ensureSprintEngineTaskWorktree ?? fallback({ ok: true, isolated: false, worktreePath: null }),
    terminalList: overrides.terminalList ?? fallback([]),
    terminalWrite: overrides.terminalWrite
      ?? (async (sessionId, data) => { record('terminalWrite', [sessionId, data]) }),
    terminalKill: overrides.terminalKill
      ?? (async (sessionId) => { record('terminalKill', [sessionId]) }),
    terminalStatus: overrides.terminalStatus
      ?? (async () => ({ processAlive: false })),
    terminalSpawn: overrides.terminalSpawn
      ?? (async (args) => ({ ok: true, sessionId: args.sessionId, exitCode: 0, message: '' })),
    pathExists: overrides.pathExists ?? (async () => true),
    readSprintEngineProjection: overrides.readSprintEngineProjection
      ?? (async () => ({ ok: true, data: {} } as any)),
    autoApproveSprintEngineArtifact: overrides.autoApproveSprintEngineArtifact
      ?? (async () => ({ ok: true, data: {} } as any)),
    memoryResolveRoot: overrides.memoryResolveRoot
      ?? (async () => ({ ok: false, status: 'inaccessible', relativeRoot: null, message: '' } as any)),
    publishDiagnostic: overrides.publishDiagnostic
      ?? (async (input) => { record('publishDiagnostic', [input]); return input as any }),
    applyTerminalRevealPolicy: overrides.applyTerminalRevealPolicy
      ?? ((workspaceId, agentId, name, policy, config) => {
        record('applyTerminalRevealPolicy', [workspaceId, agentId, name, policy, config])
      }),
    getWorkspace: overrides.getWorkspace ?? (() => undefined),
    setSprintEngineState: overrides.setSprintEngineState
      ?? ((workspaceId, state) => { record('setSprintEngineState', [workspaceId, state]) }),
    setSprintEngineAutomationMode: overrides.setSprintEngineAutomationMode
      ?? ((workspaceId, mode) => { record('setSprintEngineAutomationMode', [workspaceId, mode]) }),
    setFolderMissing: overrides.setFolderMissing
      ?? ((workspaceId, missing) => { record('setFolderMissing', [workspaceId, missing]) }),
    updateAgent: overrides.updateAgent
      ?? ((workspaceId, agentId, update) => { record('updateAgent', [workspaceId, agentId, update]) }),
    markSprintEngineAgentNotificationDelivered: overrides.markSprintEngineAgentNotificationDelivered
      ?? ((workspaceId, key) => { record('markSprintEngineAgentNotificationDelivered', [workspaceId, key]) }),
    applyAutomationStopReason: overrides.applyAutomationStopReason
      ?? ((workspaceId, reason, context) => { record('applyAutomationStopReason', [workspaceId, reason, context]) }),
  }
  return { ports, calls }
}

async function testBracketedPasteEscapeSequence(): Promise<void> {
  const paste = bracketedTerminalPaste('hello\nworld')
  assert.equal(paste, '\x1b[200~hello\nworld\x1b[201~')
  assert.equal(
    bracketedTerminalPaste('crlf\r\nline'),
    '\x1b[200~crlf\nline\x1b[201~',
    'CRLF should normalize to LF before bracketed paste',
  )
}

async function testWriteBracketedPromptSubmitsAfterPaste(): Promise<void> {
  const writes: Array<{ sessionId: string; data: string }> = []
  const { ports } = createFakePorts({
    terminalWrite: async (sessionId, data) => {
      writes.push({ sessionId, data })
    },
  })
  await writeBracketedPrompt(ports, 'session-7', 'Run dispatch', 0)
  assert.equal(writes.length, 2)
  assert.equal(writes[0].sessionId, 'session-7')
  assert.ok(writes[0].data.startsWith('\x1b[200~'))
  assert.ok(writes[0].data.endsWith('\x1b[201~'))
  assert.ok(writes[0].data.includes('Run dispatch'))
  assert.deepEqual(writes[1], { sessionId: 'session-7', data: '\r' })
}

async function testListTerminalSessionsResolvesWithPortResult(): Promise<void> {
  const fakeSessions = [
    { sessionId: 's1', processAlive: true, kind: 'agent', agentId: 'developer-1' } as any,
  ]
  let invocations = 0
  const { ports } = createFakePorts({
    terminalList: async () => {
      invocations += 1
      return fakeSessions
    },
  })
  const sessions = await listTerminalSessionsForAutoRun(ports, workspaceFixture(), 'unit-test:resolve')
  assert.equal(invocations, 1)
  assert.equal(sessions.length, 1)
  assert.equal(sessions[0].sessionId, 's1')
}

async function testListTerminalSessionsRejectionWrappedAsIpcError(): Promise<void> {
  const cause = new Error('IPC channel closed')
  const { ports } = createFakePorts({
    terminalList: async () => {
      throw cause
    },
  })
  let raised: unknown = null
  try {
    await listTerminalSessionsForAutoRun(ports, workspaceFixture(), 'unit-test:reject')
  } catch (error) {
    raised = error
  }
  assert.ok(raised instanceof TerminalListIpcError, 'expected TerminalListIpcError')
  const error = raised as TerminalListIpcError
  assert.equal(error.workspaceId, 'workspace-1')
  assert.equal(error.workspaceName, 'Auto-run workspace')
  assert.equal(error.intent, 'unit-test:reject')
  assert.equal(error.cause, cause)
}

async function testPublishTerminalListIpcFailureNoticeFirstCall(): Promise<void> {
  const cooldown = new Map<string, number>()
  const cause = new Error('socket closed')
  const error = new TerminalListIpcError({
    workspaceId: 'workspace-1',
    workspaceName: 'Auto-run workspace',
    intent: 'reconcile-duplicates',
    cause,
  })
  const captured: any[] = []
  const { ports } = createFakePorts({
    publishDiagnostic: async (input) => {
      captured.push(input)
      return input as any
    },
  })
  await publishTerminalListIpcFailureNotice(ports, workspaceFixture(), error, 'reconcile', cooldown, 1_000)
  assert.equal(captured.length, 1)
  assert.equal(captured[0].level, 'warning')
  assert.equal(captured[0].source, 'sprintengine')
  assert.equal(captured[0].title, 'Auto-run paused: terminal IPC unavailable')
  assert.ok((captured[0].details as string).includes('reconcile'))
  assert.ok((captured[0].details as string).includes('socket closed'))
  assert.equal(cooldown.get('workspace-1'), 1_000)
}

async function testPublishTerminalListIpcFailureNoticeRespectsCooldown(): Promise<void> {
  const cooldown = new Map<string, number>([['workspace-1', 100]])
  const error = new TerminalListIpcError({
    workspaceId: 'workspace-1',
    workspaceName: 'Auto-run workspace',
    intent: 'supervise',
    cause: new Error('boom'),
  })
  const captured: any[] = []
  const { ports } = createFakePorts({
    publishDiagnostic: async (input) => {
      captured.push(input)
      return input as any
    },
  })
  await publishTerminalListIpcFailureNotice(
    ports,
    workspaceFixture(),
    error,
    'supervise',
    cooldown,
    100 + TERMINAL_LIST_IPC_NOTICE_COOLDOWN_MS - 1,
  )
  assert.equal(captured.length, 0, 'must not publish while inside cooldown window')
}

async function testPublishTerminalListIpcFailureNoticeRepublishesAfterCooldown(): Promise<void> {
  const cooldown = new Map<string, number>([['workspace-1', 100]])
  const error = new TerminalListIpcError({
    workspaceId: 'workspace-1',
    workspaceName: 'Auto-run workspace',
    intent: 'supervise',
    cause: new Error('boom'),
  })
  const captured: any[] = []
  const { ports } = createFakePorts({
    publishDiagnostic: async (input) => {
      captured.push(input)
      return input as any
    },
  })
  await publishTerminalListIpcFailureNotice(
    ports,
    workspaceFixture(),
    error,
    'supervise',
    cooldown,
    100 + TERMINAL_LIST_IPC_NOTICE_COOLDOWN_MS + 1,
  )
  assert.equal(captured.length, 1, 'must publish again after cooldown elapses')
  assert.equal(cooldown.get('workspace-1'), 100 + TERMINAL_LIST_IPC_NOTICE_COOLDOWN_MS + 1)
}

async function testSafeTerminalStatusReturnsPortResult(): Promise<void> {
  const { ports } = createFakePorts({
    terminalStatus: async () => ({ processAlive: true }),
  })
  const status = await safeTerminalStatus(ports, 'session-1')
  assert.deepEqual(status, { processAlive: true })
}

async function testSafeTerminalStatusFallsBackOnError(): Promise<void> {
  const { ports } = createFakePorts({
    terminalStatus: async () => { throw new Error('ipc gone') },
  })
  const status = await safeTerminalStatus(ports, 'session-2')
  assert.deepEqual(status, { processAlive: false })
}

async function testSafeTerminalKillSwallowsErrors(): Promise<void> {
  const { ports } = createFakePorts({
    terminalKill: async () => { throw new Error('kill failed') },
  })
  await safeTerminalKill(ports, 'session-3')
}

async function testSpawnTerminalSessionPropagatesResult(): Promise<void> {
  const { ports } = createFakePorts({
    terminalSpawn: async (args) => ({ ok: true, sessionId: args.sessionId, exitCode: 0, message: '' }),
  })
  const result = await spawnTerminalSession(ports, {
    sessionId: 'session-99',
    cols: 100,
    rows: 30,
  })
  assert.equal(result.ok, true)
  assert.equal(result.sessionId, 'session-99')
}

async function testSpawnTerminalSessionConvertsThrownErrorToFailure(): Promise<void> {
  const { ports } = createFakePorts({
    terminalSpawn: async () => { throw new Error('mcp config missing') },
  })
  const result = await spawnTerminalSession(ports, {
    sessionId: 'session-100',
    cols: 100,
    rows: 30,
  })
  assert.equal(result.ok, false)
  assert.equal(result.sessionId, 'session-100')
  assert.equal(result.message, 'mcp config missing')
  assert.equal(result.exitCode, 1)
}

async function testRecordSpawnFailureResetsStoreAndPublishesDiagnostic(): Promise<void> {
  const { ports, calls } = createFakePorts()
  await recordSpawnFailure(ports, {
    workspaceId: 'workspace-1',
    workspaceName: 'Auto-run workspace',
    agentId: 'developer-1',
    agentLabel: 'Developer 1',
    selectedCli: 'codex',
    cliPermissionPreset: 'manual',
    taskId: 'T1',
    sessionId: 'session-x',
    executionCwd: '/tmp/workspace',
    sprintEngineStatePath: '/tmp/workspace/.multi-code/sprintengine/team/run.yaml',
    spawnMessage: 'MCP config sync failed: missing server multicode-sprintengine',
  })
  const findCall = (method: string): Call | undefined => calls.find((call) => call.method === method)

  const stopCall = findCall('applyAutomationStopReason')
  assert.ok(stopCall)
  assert.equal(stopCall!.args[0], 'workspace-1')
  assert.equal(stopCall!.args[1], 'agent_spawn_failed')
  assert.deepEqual(stopCall!.args[2], {
    agentId: 'developer-1',
    taskId: 'T1',
    message: 'Developer 1 could not be started for task T1.',
    details: [
      'Spawn error: MCP config sync failed: missing server multicode-sprintengine',
      'CLI: codex',
      'CLI permissions: manual',
      'Session: session-x',
    ].join('\n'),
  })

  const updateCall = findCall('updateAgent')
  assert.ok(updateCall)
  assert.equal(updateCall!.args[0], 'workspace-1')
  assert.equal(updateCall!.args[1], 'developer-1')
  assert.deepEqual(updateCall!.args[2], {
    cliSessionId: undefined,
    cliStartRequested: false,
    cliHasLaunched: false,
    cliOnboardingPromptSent: false,
    cliResumeAvailable: false,
  })

  const diagnosticCall = findCall('publishDiagnostic')
  assert.ok(diagnosticCall)
  const diagnostic = diagnosticCall!.args[0] as any
  assert.equal(diagnostic.level, 'error')
  assert.equal(diagnostic.source, 'terminal')
  assert.equal(diagnostic.title, 'Developer 1 was not started')
  assert.equal(diagnostic.message, 'MCP config sync failed: missing server multicode-sprintengine')
  assert.ok((diagnostic.details as string).includes('codex'))
  assert.ok((diagnostic.details as string).includes('T1'))
  assert.ok((diagnostic.details as string).includes('/tmp/workspace'))
  assert.equal(diagnostic.workspaceId, 'workspace-1')
  assert.equal(diagnostic.agentId, 'developer-1')
  assert.equal(diagnostic.taskId, 'T1')
  assert.equal(diagnostic.sessionId, 'session-x')
}

async function testRecordSpawnFailureOrdersStoreUpdatesBeforeDiagnostic(): Promise<void> {
  const { ports, calls } = createFakePorts()
  await recordSpawnFailure(ports, {
    workspaceId: 'workspace-1',
    workspaceName: 'Auto-run workspace',
    agentId: 'developer-1',
    agentLabel: 'Developer 1',
    selectedCli: 'codex',
    cliPermissionPreset: 'manual',
    taskId: 'T1',
    sessionId: 'session-x',
    executionCwd: '/tmp/workspace',
    sprintEngineStatePath: '/tmp/workspace/.multi-code/sprintengine/team/run.yaml',
    spawnMessage: 'spawn failed',
  })
  const order = calls.map((call) => call.method)
  const stopIdx = order.indexOf('applyAutomationStopReason')
  const agentIdx = order.indexOf('updateAgent')
  const diagnosticIdx = order.indexOf('publishDiagnostic')
  assert.ok(stopIdx >= 0)
  assert.ok(agentIdx > stopIdx)
  assert.ok(diagnosticIdx > agentIdx, 'diagnostic must publish after store mutations settle')
}

async function main(): Promise<void> {
  await testBracketedPasteEscapeSequence()
  await testWriteBracketedPromptSubmitsAfterPaste()
  await testListTerminalSessionsResolvesWithPortResult()
  await testListTerminalSessionsRejectionWrappedAsIpcError()
  await testPublishTerminalListIpcFailureNoticeFirstCall()
  await testPublishTerminalListIpcFailureNoticeRespectsCooldown()
  await testPublishTerminalListIpcFailureNoticeRepublishesAfterCooldown()
  await testSafeTerminalStatusReturnsPortResult()
  await testSafeTerminalStatusFallsBackOnError()
  await testSafeTerminalKillSwallowsErrors()
  await testSpawnTerminalSessionPropagatesResult()
  await testSpawnTerminalSessionConvertsThrownErrorToFailure()
  await testRecordSpawnFailureResetsStoreAndPublishesDiagnostic()
  await testRecordSpawnFailureOrdersStoreUpdatesBeforeDiagnostic()
  console.log('sprintengineAutoRunExecutor tests passed')
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})
