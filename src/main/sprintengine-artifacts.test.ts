import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { registerSprintEngineIpc } from './ipc/sprintengine-ipc'
import { createPluginRegistry } from './plugin-registry'
import { __resetPluginRegistryForTest, __setPluginRegistryForTest } from './plugin-registry-instance'
import { createSprintEngineArtifactHandlers, getArtifactAutoApprovalBlocker } from './sprintengine-artifacts'

type IpcHandler = (_event: unknown, payload: unknown) => Promise<unknown>

async function main(): Promise<void> {
  await testReadProjectionUsesProjectionFile()
  await testReadProjectionSurfacesUnavailableAndInvalidProjection()
  await testMutationResponsesIncludeProjectionAndEventMetadata()
  await testFailedMutationDoesNotReturnProjectionContent()
  await testAutoRunApprovalEnforcesEligibilityBeforeMcpCall()
  testGateApprovesWhenOnlyStaleSameFileDuplicateBlocks()
  testGateStillBlocksDistinctPendingSibling()
  testGateNormalizesBareVsFullPrefixSameFile()
  testGateDecisionMatchesAutoApprovalIntentContract()
  await testRequestChangesFailureDiagnostics()
  await testReadRegistryRolesUsesMcpTool()
  await testReadRegistryRolesPassesLoadedPluginSoulsRoots()
  await testReadRegistryRolesUsesRealMcpBridgeForBundledAndCustomRoles()
  await testReadRegistryRoleSurfacesUnknownRole()
  await testReadDispatchUsesMcpTool()
  await testInitializeSprintEngineStatePreservesDisplayName()
  await testRunnerModeCliInvocationUsesSprintEngineTool()
  await testRosterAddCliInvocationUsesSprintEngineTool()
  await testReadBridgeSurfacesUnavailableMcpAndMalformedPayloads()
  await testIpcRegistersReadOnlyBridgeChannels()

  console.log('sprintengine-artifacts tests passed')
}

async function createStateFixture(): Promise<{ workspaceRoot: string; teamDir: string; statePath: string }> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-sprintengine-bridge-'))
  const teamDir = join(workspaceRoot, '.multi-code', 'sprintengine', 'team')
  await mkdir(teamDir, { recursive: true })
  const statePath = join(teamDir, 'run.yaml')
  await writeFile(statePath, 'name: Bridge Test\n', 'utf-8')
  await writeFile(
    join(teamDir, 'projection.json'),
    JSON.stringify({
      tasks: [],
      agents: {
        'developer-1': {
          role: 'developer',
          currentDispatch: { dispatchId: 'DISP-1', taskId: 'T1' },
        },
      },
    }),
    'utf-8'
  )
  return { workspaceRoot, teamDir, statePath }
}

function createHandlers(runMcpTool: Parameters<typeof createSprintEngineArtifactHandlers>[0]['runMcpTool']) {
  return createSprintEngineArtifactHandlers({
    getAuthenticatedUserId: () => 'user-1',
    openExternal: async () => undefined,
    runMcpTool,
  })
}

async function testReadProjectionUsesProjectionFile(): Promise<void> {
  const { statePath } = await createStateFixture()
  const handlers = createHandlers(async () => {
    throw new Error('projection reads must not call MCP')
  })

  const result = await handlers.readProjection({ statePath })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual((result.data as { tasks: unknown[] }).tasks, [])
}

async function testReadProjectionSurfacesUnavailableAndInvalidProjection(): Promise<void> {
  const { statePath, teamDir } = await createStateFixture()
  const handlers = createHandlers(async () => {
    throw new Error('projection reads must not call MCP')
  })

  await rm(join(teamDir, 'projection.json'))
  const missingProjection = await handlers.readProjection({ statePath })
  assert.equal(missingProjection.ok, false)
  if (!missingProjection.ok) assert.match(missingProjection.message, /projection\.json|ENOENT/u)

  await writeFile(join(teamDir, 'projection.json'), '{not-json', 'utf-8')
  const invalidProjection = await handlers.readProjection({ statePath })
  assert.equal(invalidProjection.ok, false)
  if (!invalidProjection.ok) assert.match(invalidProjection.message, /JSON|Unexpected|property name/u)
}

async function testMutationResponsesIncludeProjectionAndEventMetadata(): Promise<void> {
  const { statePath } = await createStateFixture()
  const calls: Array<{ tool: string; payload: Record<string, unknown> }> = []
  const handlers = createHandlers(async (_context, tool, payload) => {
    calls.push({ tool, payload })
    return {
      exitCode: 0,
      stdout: '',
      stderr: '',
      response: {
        ok: true,
        tool,
        result: {
          ok: true,
          event: {
            id: 'EVT-10',
            type: 'artifact_approved',
            timestamp: '2026-05-22T08:00:00Z',
            actor: 'user-1',
            message: 'approved',
          },
          notification: {
            id: 'EVT-11',
            type: 'agent_notification_requested',
            timestamp: '2026-05-22T08:00:01Z',
            actor: 'user-1',
            message: 'wake owner',
          },
        },
      },
    }
  })

  const result = await handlers.reviewArtifact({ statePath, artifactId: 'A1' }, 'approve', 'user')
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(calls[0]?.tool, 'sprintengine.artifact.approve')
  assert.equal(result.data.projectionContent, JSON.stringify({
    tasks: [],
    agents: {
      'developer-1': {
        role: 'developer',
        currentDispatch: { dispatchId: 'DISP-1', taskId: 'T1' },
      },
    },
  }))
  assert.equal(result.data.latestEventId, 'EVT-11')
  assert.deepEqual((result.data.events as Array<{ id: string }>).map((event) => event.id), ['EVT-10', 'EVT-11'])
}

async function testFailedMutationDoesNotReturnProjectionContent(): Promise<void> {
  const { statePath } = await createStateFixture()
  const handlers = createHandlers(async (_context, tool) => ({
    exitCode: 0,
    stdout: '',
    stderr: '',
    response: {
      ok: false,
      tool,
      error: { code: 'not_ready', message: 'Artifact is not ready.' },
    },
  }))

  const result = await handlers.reviewArtifact({ statePath, artifactId: 'A1' }, 'approve', 'user')
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.message, /not ready/)
}

async function testAutoRunApprovalEnforcesEligibilityBeforeMcpCall(): Promise<void> {
  const { workspaceRoot, teamDir, statePath } = await createStateFixture()
  const artifactPath = join(teamDir, 'plan.md')
  await writeFile(artifactPath, '# Plan\n', 'utf-8')
  await writeFile(
    join(teamDir, 'projection.json'),
    JSON.stringify({
      tasks: [{ id: 'T1', status: 'needs_input', ownerAgentId: 'developer-1' }],
      artifacts: [
        {
          id: 'A1',
          kind: 'architect_plan',
          title: 'Plan',
          path: artifactPath,
          status: 'ready_for_review',
          createdBy: 'architect-1',
          taskId: 'T1',
        },
      ],
    }),
    'utf-8'
  )

  const calls: Array<{ tool: string; payload: Record<string, unknown> }> = []
  const handlers = createHandlers(async (_context, tool, payload) => {
    calls.push({ tool, payload })
    return {
      exitCode: 0,
      stdout: '',
      stderr: '',
      response: {
        ok: true,
        tool,
        result: {
          ok: true,
          event: {
            id: 'EVT-30',
            type: 'artifact_approved',
            timestamp: '2026-05-24T08:00:00Z',
            actor: 'user-1',
            message: 'auto approved',
          },
          notification: {
            id: 'EVT-31',
            type: 'agent_notification_requested',
            timestamp: '2026-05-24T08:00:01Z',
            actor: 'user-1',
            message: 'wake T1 owner',
            targetAgentId: 'developer-1',
            taskId: 'T1',
            notificationKind: 'task_completed_after_artifact_approval',
          },
        },
      },
    }
  })

  const result = await handlers.reviewArtifact({ statePath, artifactId: 'A1' }, 'approve', 'auto-run')
  assert.equal(result.ok, true, `auto-run approval should succeed for eligible artifact, got: ${result.ok ? 'ok' : result.message}`)
  if (!result.ok) return
  assert.equal(calls.length, 1, 'auto-run approval should call MCP exactly once')
  assert.equal(calls[0]?.tool, 'sprintengine.artifact.approve')
  assert.equal(calls[0]?.payload.artifactId, 'A1')
  assert.equal((result.data as { mode: string }).mode, 'auto-run')
  assert.equal(result.data.latestEventId, 'EVT-31')
  const events = result.data.events as Array<{ id: string; type?: string }>
  assert.deepEqual(events.map((event) => event.id), ['EVT-30', 'EVT-31'])
  assert.equal(
    events.find((event) => event.id === 'EVT-31')?.type,
    'agent_notification_requested',
    'mutation response must surface the agent_notification_requested event so the supervisor wake loop can act on it'
  )
  // Bridge contract for AC #2: the supervisor's autoApproveSprintEngineArtifact handler
  // (src/renderer/src/components/workspace/SprintEngineAutoRunSupervisor.tsx:541)
  // consumes result.data.projectionContent to refresh renderer state immediately, then the
  // separate deliverAgentNotificationEvents loop (sprintengineAutoRun.ts:415) reads
  // agent_notification_requested events from the refreshed state and wakes the owning agent.
  // The renderer-side terminal-write half of this chain is verified by
  // testDeliverArtifactApprovalCompletionWakesOwnerWithCompletionPrompt and
  // testDeliverRequestChangesWakesOwnerWithJoinDirectiveWithoutReveal in sprintengineAutoRun.test.ts.
  assert.ok(
    typeof result.data.projectionContent === 'string' && (result.data.projectionContent as string).includes('"developer-1"'),
    'mutation response must return refreshed projectionContent so the supervisor can apply the new state immediately'
  )

  const ineligibleHandlers = createHandlers(async () => {
    throw new Error('MCP must not be called when auto-run eligibility fails')
  })
  await writeFile(
    join(teamDir, 'projection.json'),
    JSON.stringify({
      tasks: [{ id: 'T1', status: 'done', ownerAgentId: 'developer-1' }],
      artifacts: [
        {
          id: 'A1',
          kind: 'architect_plan',
          title: 'Plan',
          path: artifactPath,
          status: 'approved',
          createdBy: 'architect-1',
          taskId: 'T1',
        },
      ],
    }),
    'utf-8'
  )
  const blocked = await ineligibleHandlers.reviewArtifact({ statePath, artifactId: 'A1' }, 'approve', 'auto-run')
  assert.equal(blocked.ok, false, 'auto-run approval must fail for an already-approved artifact')
  if (!blocked.ok) assert.match(blocked.message, /already approved/i)

  void workspaceRoot
}

type GateArtifact = {
  id: string
  kind: string
  title: string
  path: string
  status: string
  createdBy: string
  taskId: string
}

function gateArtifact(overrides: Partial<GateArtifact> & Pick<GateArtifact, 'id' | 'path' | 'status'>): GateArtifact {
  return {
    kind: 'architect_plan',
    title: 'Architect Plan',
    createdBy: 'architect-1',
    taskId: 'T0',
    ...overrides,
  }
}

const NEEDS_INPUT_TASK = [{ id: 'T0', status: 'needs_input', ownerAgentId: 'architect-1' }]

function testGateApprovesWhenOnlyStaleSameFileDuplicateBlocks(): void {
  // The real plan is ready; the only other sibling is a stale draft placeholder
  // pointing at the SAME file (stored full-prefix vs bare). It must not veto.
  const candidate = gateArtifact({ id: 'A2', path: 'plan.md', status: 'ready_for_review' })
  const staleDuplicate = gateArtifact({
    id: 'A1',
    path: '.multi-code/sprintengine/team/plan.md',
    status: 'draft',
    createdBy: 'sprintengine',
  })
  const blocker = getArtifactAutoApprovalBlocker(candidate, NEEDS_INPUT_TASK, [staleDuplicate, candidate])
  assert.equal(blocker, null, `stale same-file duplicate must not block; got: ${blocker}`)
}

function testGateStillBlocksDistinctPendingSibling(): void {
  // A genuinely different file that is still pending (draft) is an independent
  // review gate and must continue to block auto-approval — no regression.
  const candidate = gateArtifact({ id: 'A2', path: 'plan.md', status: 'ready_for_review' })
  const distinctPending = gateArtifact({
    id: 'A3',
    kind: 'design_notes',
    path: 'design-notes.md',
    status: 'draft',
  })
  const blocker = getArtifactAutoApprovalBlocker(candidate, NEEDS_INPUT_TASK, [candidate, distinctPending])
  assert.ok(blocker, 'a distinct pending sibling must still block auto-approval')
  assert.match(blocker ?? '', /A3/, 'the blocker should name the ineligible distinct sibling')
}

function testGateNormalizesBareVsFullPrefixSameFile(): void {
  // Normalization works in both directions and does not over-match by basename:
  // a duplicate in a different subdirectory is a distinct file and still blocks.
  const candidate = gateArtifact({
    id: 'A2',
    path: '.multi-code/sprintengine/team/plan.md',
    status: 'ready_for_review',
  })
  const bareDuplicate = gateArtifact({ id: 'A1', path: 'plan.md', status: 'draft' })
  assert.equal(
    getArtifactAutoApprovalBlocker(candidate, NEEDS_INPUT_TASK, [bareDuplicate, candidate]),
    null,
    'full-prefix candidate must match a bare-path same-file duplicate'
  )

  const differentNestedFile = gateArtifact({ id: 'A4', path: 'archive/plan.md', status: 'draft' })
  assert.ok(
    getArtifactAutoApprovalBlocker(candidate, NEEDS_INPUT_TASK, [candidate, differentNestedFile]),
    'a same-basename file in a different directory is distinct and must still block'
  )
}

function testGateDecisionMatchesAutoApprovalIntentContract(): void {
  // Agreement contract between the main-process gate and the renderer
  // auto-approval intent selector (getAutoApprovalIntentArtifacts) /
  // eligibility helpers in src/renderer/src/utils/sprintengine*.ts: the gate
  // returns approvable (null) exactly when the renderer must propose the
  // artifact, and returns a blocker exactly when the renderer must not. The
  // renderer half of this contract is asserted in
  // testGetAutoApprovalIntentArtifactsExcludesSameFileDuplicateVeto
  // (src/renderer/src/utils/sprintengineAutoRun.test.ts) over the same matrix.
  const candidate = gateArtifact({ id: 'A2', path: 'plan.md', status: 'ready_for_review' })
  const staleSameFile = gateArtifact({
    id: 'A1',
    path: '.multi-code/sprintengine/team/plan.md',
    status: 'draft',
  })
  assert.equal(
    getArtifactAutoApprovalBlocker(candidate, NEEDS_INPUT_TASK, [staleSameFile, candidate]),
    null,
    'gate approves the same-file-duplicate case -> intent must propose'
  )

  const distinctPending = gateArtifact({ id: 'A3', kind: 'design_notes', path: 'notes.md', status: 'draft' })
  assert.ok(
    getArtifactAutoApprovalBlocker(candidate, NEEDS_INPUT_TASK, [candidate, distinctPending]),
    'gate rejects the distinct-pending case -> intent must not propose'
  )
}

async function testRequestChangesFailureDiagnostics(): Promise<void> {
  const { statePath } = await createStateFixture()

  const missingFeedbackHandlers = createHandlers(async () => {
    throw new Error('MCP must not be called when feedback is missing')
  })
  const missingFeedback = await missingFeedbackHandlers.reviewArtifact(
    { statePath, artifactId: 'A1', feedback: '   ' },
    'request-changes',
    'user'
  )
  assert.equal(missingFeedback.ok, false)
  if (!missingFeedback.ok) assert.match(missingFeedback.message, /feedback/i)

  const mcpErrorCalls: Array<{ tool: string; payload: Record<string, unknown> }> = []
  const mcpErrorHandlers = createHandlers(async (_context, tool, payload) => {
    mcpErrorCalls.push({ tool, payload })
    return {
      exitCode: 0,
      stdout: '',
      stderr: '',
      response: {
        ok: false,
        tool,
        error: { code: 'invalid_state', message: 'Artifact is not in a reviewable state.' },
      },
    }
  })
  const mcpFailure = await mcpErrorHandlers.reviewArtifact(
    { statePath, artifactId: 'A1', feedback: 'Please clarify the rollback steps.' },
    'request-changes',
    'user'
  )
  assert.equal(mcpFailure.ok, false)
  if (!mcpFailure.ok) {
    assert.match(mcpFailure.message, /not in a reviewable state/i)
    assert.equal('projectionContent' in (mcpFailure as Record<string, unknown>), false, 'failure responses must not include projection content')
  }
  assert.equal(mcpErrorCalls.length, 1)
  assert.equal(mcpErrorCalls[0]?.tool, 'sprintengine.artifact.request_changes')
  assert.equal(mcpErrorCalls[0]?.payload.feedback, 'Please clarify the rollback steps.')
}

async function testReadRegistryRolesUsesMcpTool(): Promise<void> {
  const { workspaceRoot } = await createStateFixture()
  const calls: Array<{ tool: string; payload: Record<string, unknown>; actor: { role: string } }> = []
  const handlers = createHandlers(async (_context, tool, payload, actor) => {
    calls.push({ tool, payload, actor })
    return {
      exitCode: 0,
      stdout: '',
      stderr: '',
      response: {
        ok: true,
        tool,
        result: {
          ok: true,
          roles: [{ id: 'marketer', label: 'Marketer', source: { layer: 'workspace' } }],
          warnings: [],
        },
      },
    }
  })

  const result = await handlers.readRegistryRoles({ workspaceRoot, includeShadowed: true })
  assert.equal(result.ok, true)
  assert.equal(calls[0]?.tool, 'sprintengine.roles.list')
  assert.deepEqual(calls[0]?.payload, { workspaceRoot, includeShadowed: true, pluginRegistryRoots: [] })
  assert.equal(calls[0]?.actor.role, 'renderer')
}

async function testReadRegistryRolesPassesLoadedPluginSoulsRoots(): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-sprintengine-plugin-bridge-'))
  const pluginRoot = join(workspaceRoot, 'plugins', 'writer-plugin')
  const soulsRoot = join(pluginRoot, 'sprintengine-souls')
  await mkdir(join(soulsRoot, 'roles'), { recursive: true })
  await mkdir(join(soulsRoot, 'skills', 'plugin_writer'), { recursive: true })
  await writeFile(
    join(pluginRoot, 'plugin.json'),
    JSON.stringify({
      id: 'writer-plugin',
      displayName: 'Writer Plugin',
      version: 1,
      binary: 'writer',
      permissionPresets: { default: { label: 'Default', args: [] } },
      launch: { argv: ['writer'] },
      promptInjection: { mode: 'stdin-pipe' },
      completion: { mode: 'process-exit' },
      capabilities: { resumeSession: false, sessionIdFromCaller: false, toolUse: false, mcpServers: false },
      souls: { directory: 'sprintengine-souls' },
    }),
    'utf-8'
  )

  const registry = createPluginRegistry({ bundledRoot: join(workspaceRoot, 'empty-bundled'), userRoot: join(workspaceRoot, 'plugins') })
  const report = registry.loadSync()
  __setPluginRegistryForTest(registry, report)
  const calls: Array<{ context: { workspaceRoot: string; allowedRoots?: string[] }; payload: Record<string, unknown> }> = []
  const handlers = createHandlers(async (context, _tool, payload) => {
    calls.push({ context, payload })
    return {
      exitCode: 0,
      stdout: '',
      stderr: '',
      response: { ok: true, tool: 'sprintengine.roles.list', result: { ok: true, roles: [], warnings: [] } },
    }
  })

  try {
    const result = await handlers.readRegistryRoles({ workspaceRoot })
    assert.equal(result.ok, true)
    assert.deepEqual(calls[0]?.payload.pluginRegistryRoots, [{ id: 'writer-plugin', root: soulsRoot }])
    assert.deepEqual(calls[0]?.context.allowedRoots, [soulsRoot])
  } finally {
    __resetPluginRegistryForTest()
    await rm(workspaceRoot, { recursive: true, force: true })
  }
}

async function testReadRegistryRolesUsesRealMcpBridgeForBundledAndCustomRoles(): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-sprintengine-registry-'))
  const previousPythonPath = process.env.PYTHONPATH
  const rolePath = join(workspaceRoot, '.sprintengine', 'roles', 'marketer.json')
  const skillPath = join(workspaceRoot, '.sprintengine', 'skills', 'marketer', 'SKILL.md')
  await mkdir(join(workspaceRoot, '.sprintengine', 'roles'), { recursive: true })
  await mkdir(join(workspaceRoot, '.sprintengine', 'skills', 'marketer'), { recursive: true })
  await writeFile(
    rolePath,
    JSON.stringify({
      id: 'marketer',
      label: 'Marketer',
      aliases: ['growth-marketer'],
      summary: 'Tests workspace custom role discovery.',
      soul: [{ skill: 'marketer' }],
    }, null, 2),
    'utf-8'
  )
  await writeFile(skillPath, 'Workspace marketer test skill.\n', 'utf-8')

  try {
    delete process.env.PYTHONPATH
    const handlers = createSprintEngineArtifactHandlers({
      getAuthenticatedUserId: () => 'user-1',
      openExternal: async () => undefined,
    })
    const result = await handlers.readRegistryRoles({ workspaceRoot, includeShadowed: true })
    assert.equal(result.ok, true)
    if (!result.ok) return

    const payload = result.data as {
      roles?: Array<{ id?: string; label?: string; source?: { layer?: string } }>
      aliases?: Record<string, string>
    }
    const roleIds = new Set((payload.roles ?? []).map((role) => role.id))
    assert.equal(roleIds.has('developer'), true, 'bundled developer role is discovered through the real MCP bridge')
    assert.equal(roleIds.has('marketer'), true, 'workspace custom role fixture is discovered through the real MCP bridge')
    assert.equal(payload.roles?.find((role) => role.id === 'marketer')?.source?.layer, 'workspace')
    assert.equal(payload.aliases?.growth_marketer, 'marketer')
  } finally {
    if (previousPythonPath === undefined) {
      delete process.env.PYTHONPATH
    } else {
      process.env.PYTHONPATH = previousPythonPath
    }
    await rm(workspaceRoot, { recursive: true, force: true })
  }
}

async function testReadRegistryRoleSurfacesUnknownRole(): Promise<void> {
  const { workspaceRoot } = await createStateFixture()
  const handlers = createHandlers(async (_context, tool) => ({
    exitCode: 0,
    stdout: '',
    stderr: '',
    response: {
      ok: false,
      tool,
      error: { code: 'unknown_role', message: 'Unknown registry role: marketer.' },
    },
  }))

  const result = await handlers.readRegistryRole({ workspaceRoot, roleId: 'marketer' })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.match(result.message, /Unknown registry role/)
}

async function testReadDispatchUsesMcpTool(): Promise<void> {
  const { workspaceRoot, statePath } = await createStateFixture()
  const calls: Array<{ context: { workspaceRoot: string }; tool: string; payload: Record<string, unknown> }> = []
  const handlers = createHandlers(async (context, tool, payload) => {
    calls.push({ context, tool, payload })
    return {
      exitCode: 0,
      stdout: '',
      stderr: '',
      response: {
        ok: true,
        tool,
        result: {
          ok: true,
          currentDispatch: { dispatchId: 'DISP-1', targetKind: 'task', taskId: 'T1' },
          dispatches: [],
        },
      },
    }
  })

  const result = await handlers.readDispatch({ statePath, agentId: 'developer-1', lastDispatchId: 'DISP-0' })
  assert.equal(result.ok, true)
  assert.equal(calls[0]?.context.workspaceRoot, workspaceRoot)
  assert.equal(calls[0]?.tool, 'sprintengine.dispatch.next')
  assert.deepEqual(calls[0]?.payload, { statePath, agentId: 'developer-1', lastDispatchId: 'DISP-0' })
}

async function testRunnerModeCliInvocationUsesSprintEngineTool(): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-sprintengine-runner-'))
  const statePath = join(workspaceRoot, '.multi-code', 'sprintengine', 'team', 'run.yaml')
  const handlers = createHandlers(async () => {
    throw new Error('runner mode writes must use the Sprint Engine CLI bridge')
  })

  try {
    const init = await handlers.initializeSprintEngineState({
      statePath,
      name: 'Runner bridge test',
      goal: 'Verify runner mode CLI invocation',
      agents: {
        architect: { role: 'architect' },
      },
    })
    assert.equal(init.ok, true, init.ok ? undefined : init.message)

    const result = await handlers.setRunnerMode({ statePath, cliWatchPolling: 'enabled' })
    assert.equal(result.ok, true, result.ok ? undefined : result.message)
    if (!result.ok) return

    const runYaml = await readFile(statePath, 'utf-8')
    assert.match(runYaml, /cliWatchPolling:\s+enabled/u)
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true })
  }
}

async function testInitializeSprintEngineStatePreservesDisplayName(): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-sprintengine-init-name-'))
  const statePath = join(workspaceRoot, '.multi-code', 'sprintengine', 'ship-squad', 'run.yaml')
  const handlers = createHandlers(async () => {
    throw new Error('init must use the Sprint Engine CLI bridge')
  })

  try {
    const init = await handlers.initializeSprintEngineState({
      statePath,
      name: 'Ship Squad',
      goal: 'Ship the things',
      agents: {
        architect: { role: 'architect' },
        product: { role: 'product' },
      },
    })
    assert.equal(init.ok, true, init.ok ? undefined : init.message)
    if (!init.ok) return

    const runYaml = await readFile(statePath, 'utf-8')
    assert.match(runYaml, /name:\s+Ship Squad/u)
    assert.equal(typeof init.data.projectionToken, 'string')

    const projection = JSON.parse(String(init.data?.projectionContent ?? '{}')) as { run?: { name?: string } }
    assert.equal(projection.run?.name, 'Ship Squad')
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true })
  }
}

async function testRosterAddCliInvocationUsesSprintEngineTool(): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-sprintengine-roster-add-'))
  const statePath = join(workspaceRoot, '.multi-code', 'sprintengine', 'team', 'run.yaml')
  const handlers = createHandlers(async () => {
    throw new Error('roster mutations must use the Sprint Engine CLI bridge')
  })

  try {
    const init = await handlers.initializeSprintEngineState({
      statePath,
      name: 'Roster add bridge test',
      goal: 'Verify roster add CLI invocation',
      agents: {
        architect: { role: 'architect' },
      },
    })
    assert.equal(init.ok, true, init.ok ? undefined : init.message)

    const result = await handlers.addRosterMember({ statePath, agentId: 'frontend-1', role: 'frontend' })
    assert.equal(result.ok, true, result.ok ? undefined : result.message)
    if (!result.ok) return
    assert.equal((result.data as { agentId?: string }).agentId, 'frontend-1')

    const runYaml = await readFile(statePath, 'utf-8')
    assert.match(runYaml, /frontend-1/u)

    const unknownRole = await handlers.addRosterMember({ statePath, agentId: 'mystery-1', role: 'not_a_role' })
    assert.equal(unknownRole.ok, false)
    if (!unknownRole.ok) assert.match(unknownRole.message, /unknown role/iu)

    const missingAgentId = await handlers.addRosterMember({ statePath, agentId: '  ', role: 'frontend' })
    assert.equal(missingAgentId.ok, false)
    if (!missingAgentId.ok) assert.match(missingAgentId.message, /Agent id is required/u)

    const unsafeAgentId = await handlers.addRosterMember({ statePath, agentId: 'bad id;rm', role: 'frontend' })
    assert.equal(unsafeAgentId.ok, false)
    if (!unsafeAgentId.ok) assert.match(unsafeAgentId.message, /safe sprintengine identifier/u)
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true })
  }
}

async function testReadBridgeSurfacesUnavailableMcpAndMalformedPayloads(): Promise<void> {
  const { statePath } = await createStateFixture()
  const handlers = createHandlers(async () => ({
    exitCode: 1,
    stdout: '',
    stderr: 'mcp unavailable',
    response: null,
  }))

  const unavailable = await handlers.readDispatch({ statePath, agentId: 'developer-1' })
  assert.equal(unavailable.ok, false)
  if (!unavailable.ok) assert.match(unavailable.message, /mcp unavailable/)

  const malformed = await handlers.readDispatch({ statePath, agentId: '' })
  assert.equal(malformed.ok, false)
  if (!malformed.ok) assert.match(malformed.message, /Agent id is required/)

  const malformedRegistry = await handlers.readRegistryRoles({ workspaceRoot: '' })
  assert.equal(malformedRegistry.ok, false)
  if (!malformedRegistry.ok) assert.match(malformedRegistry.message, /Workspace root is required/)

  const malformedRegistryRole = await handlers.readRegistryRole({ workspaceRoot: statePath, roleId: '' })
  assert.equal(malformedRegistryRole.ok, false)
  if (!malformedRegistryRole.ok) assert.match(malformedRegistryRole.message, /Workspace root does not exist|Role id is required/)

  const malformedProjection = await handlers.readProjection({ statePath: 'relative/run.yaml' })
  assert.equal(malformedProjection.ok, false)
  if (!malformedProjection.ok) assert.match(malformedProjection.message, /absolute/)
}

async function testIpcRegistersReadOnlyBridgeChannels(): Promise<void> {
  const calls: string[] = []
  const handlers = new Map<string, IpcHandler>()
  const ipcMain = {
    handle(channel: string, handler: IpcHandler) {
      handlers.set(channel, handler)
    },
  }
  registerSprintEngineIpc(ipcMain as never, {
    openArtifact: async () => ({ ok: true, data: {} }),
    reviewArtifact: async () => ({ ok: true, data: {} }),
    initializeSprintEngineState: async () => ({ ok: true, data: {} }),
    updateTask: async () => ({ ok: true, data: {} }),
    createTask: async () => ({ ok: true, data: {} }),
    commentTask: async () => ({ ok: true, data: {} }),
    resolveTaskInput: async () => ({ ok: true, data: {} }),
    setTaskStatus: async () => ({ ok: true, data: {} }),
    setRunnerMode: async () => ({ ok: true, data: {} }),
    createPullRequest: async () => ({ ok: true, data: {} }),
    refreshPullRequestStatus: async () => ({ ok: true, data: {} }),
    replenishRoster: async () => ({ ok: true, data: {} }),
    addRosterMember: async () => ({ ok: true, data: {} }),
    readProjection: async () => ({ ok: true, data: null }),
    readRegistryRoles: async () => {
      calls.push('roles')
      return { ok: true, data: null }
    },
    readRegistryRole: async () => {
      calls.push('role')
      return { ok: true, data: null }
    },
    readDispatch: async () => {
      calls.push('dispatch')
      return { ok: true, data: null }
    },
    summarizeFeedback: async () => ({ ok: true, data: null }),
  })

  await handlers.get('sprintengine:registry:roles:read')?.(null, { workspaceRoot: '/tmp/workspace' })
  await handlers.get('sprintengine:registry:role:read')?.(null, { workspaceRoot: '/tmp/workspace', roleId: 'developer' })
  await handlers.get('sprintengine:dispatch:read')?.(null, { statePath: '/tmp/workspace/.multi-code/sprintengine/team/run.yaml', agentId: 'developer-1' })

  assert.deepEqual(calls, ['roles', 'role', 'dispatch'])
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})
