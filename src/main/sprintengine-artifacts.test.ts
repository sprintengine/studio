import assert from 'node:assert/strict'
import { realpathSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { registerSprintEngineIpc } from './ipc/sprintengine-ipc'
import { createPluginRegistry } from './plugin-registry'
import { __resetPluginRegistryForTest, __setPluginRegistryForTest } from './plugin-registry-instance'
import {
  createSprintEngineArtifactHandlers,
  describeUnsupportedSprintEngineStore,
  getArtifactAutoApprovalBlocker,
  sprintEngineDeclaredSiblingRepoRoots,
  SPRINT_ENGINE_RUN_SCHEMA_VERSION,
} from './sprintengine-artifacts'

type IpcHandler = (_event: unknown, payload: unknown) => Promise<unknown>

async function main(): Promise<void> {
  await testReadProjectionUsesProjectionFile()
  await testReadProjectionSurfacesUnavailableAndInvalidProjection()
  await testReadProjectionMarksMissingRunDirectoryPermanent()
  await testReadProjectionRejectsPreMc1542Store()
  testDescribeUnsupportedStoreOnlyJudgesRealProjections()
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
  await testInitializeSprintEngineStatePreservesDisplayName()
  await testInitializeSprintEngineStateRecordsRoleRuntimes()
  await testInitializeSprintEngineStateRecordsConfiguredRoles()
  await testRunnerModeCliInvocationUsesSprintEngineTool()
  await testMergePullRequestSurfacesTheEnginesRefusal()
  await testReadBridgeSurfacesUnavailableMcpAndMalformedPayloads()
  await testIpcRegistersReadOnlyBridgeChannels()
  await testDeclaredSiblingRepoRootsResolveEveryDeclaredProject()
  await testDeclaredSiblingRepoRootsRefuseAnythingNotDeclaredAsASibling()
  await testDeclaredSiblingRepoRootsJudgeSymlinkedRootsByTheirRealTarget()

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

async function writeDeclaredRepos(teamDir: string, repos: unknown[]): Promise<void> {
  await writeFile(
    join(teamDir, 'projection.json'),
    JSON.stringify({ run: { schemaVersion: SPRINT_ENGINE_RUN_SCHEMA_VERSION, vcs: { mode: 'run_worktree', repos } } }),
    'utf-8'
  )
}

async function testDeclaredSiblingRepoRootsResolveEveryDeclaredProject(): Promise<void> {
  const { workspaceRoot, teamDir, statePath } = await createStateFixture()
  const sibling = join(workspaceRoot, '..', 'declared-sibling')
  await mkdir(sibling, { recursive: true })

  try {
    // A run that declares nothing is every single-project run: no extra roots.
    assert.deepEqual(sprintEngineDeclaredSiblingRepoRoots(statePath), [])

    await writeDeclaredRepos(teamDir, [
      { id: 'primary', root: '.', worktreePath: 'w', branchName: 'b' },
      { id: 'mobile', root: '../declared-sibling', worktreePath: 'w-mobile', branchName: 'b' },
    ])
    // realpath, not just resolve: the MCP server resolves the roots it is handed, so
    // this must return the path the server will actually compare against.
    assert.deepEqual(sprintEngineDeclaredSiblingRepoRoots(statePath), [realpathSync(sibling)])
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true })
    await rm(sibling, { recursive: true, force: true })
  }
}

async function testDeclaredSiblingRepoRootsRefuseAnythingNotDeclaredAsASibling(): Promise<void> {
  const { workspaceRoot, teamDir, statePath } = await createStateFixture()

  try {
    await writeDeclaredRepos(teamDir, [
      { id: 'primary', root: '.', worktreePath: 'w', branchName: 'b' },
      // A parent of the workspace would authorize its every neighbour by inclusion.
      { id: 'parent', root: '..', worktreePath: 'w-parent', branchName: 'b' },
      // Declared but not on disk: nothing to authorize.
      { id: 'gone', root: '../vanished-project', worktreePath: 'w-gone', branchName: 'b' },
      { id: 'blank', root: '   ', worktreePath: 'w-blank', branchName: 'b' },
      'not-an-entry',
    ])
    assert.deepEqual(sprintEngineDeclaredSiblingRepoRoots(statePath), [])

    // A store this build cannot read never widens the surface.
    await writeFile(join(teamDir, 'projection.json'), '{ not json', 'utf-8')
    assert.deepEqual(sprintEngineDeclaredSiblingRepoRoots(statePath), [])
    assert.deepEqual(sprintEngineDeclaredSiblingRepoRoots(join(workspaceRoot, 'nope.yaml')), [])
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true })
  }
}

// A declared root is authorized by its REAL target, never by how it was spelled.
// Both halves matter: follow the link and a symlink cannot smuggle in a root the
// server would refuse; judge only after following it and a symlink cannot launder a
// parent past the parent check by wearing a sibling's name.
async function testDeclaredSiblingRepoRootsJudgeSymlinkedRootsByTheirRealTarget(): Promise<void> {
  const { workspaceRoot, teamDir, statePath } = await createStateFixture()
  const realSibling = join(workspaceRoot, '..', `declared-sibling-${process.pid}`)
  const linkToSibling = join(workspaceRoot, '..', `link-to-sibling-${process.pid}`)
  const linkToParent = join(workspaceRoot, '..', `link-to-parent-${process.pid}`)

  try {
    await mkdir(realSibling, { recursive: true })
    await symlink(realpathSync(realSibling), linkToSibling, 'dir')
    // Points at the directory that CONTAINS the workspace.
    await symlink(realpathSync(join(workspaceRoot, '..')), linkToParent, 'dir')

    await writeDeclaredRepos(teamDir, [
      { id: 'primary', root: '.', worktreePath: 'w', branchName: 'b' },
      { id: 'mobile', root: `../link-to-sibling-${process.pid}`, worktreePath: 'w-mobile', branchName: 'b' },
    ])
    // The link's own path is never returned: the server resolves what it is handed,
    // so authorizing the un-resolved spelling would authorize a path it never compares.
    assert.deepEqual(sprintEngineDeclaredSiblingRepoRoots(statePath), [realpathSync(realSibling)])

    await writeDeclaredRepos(teamDir, [
      { id: 'primary', root: '.', worktreePath: 'w', branchName: 'b' },
      { id: 'sneaky', root: `../link-to-parent-${process.pid}`, worktreePath: 'w-sneaky', branchName: 'b' },
    ])
    // Resolves to a parent of the workspace, so the parent check must still catch it
    // even though nothing in the declaration says `..`.
    assert.deepEqual(sprintEngineDeclaredSiblingRepoRoots(statePath), [])
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true })
    await rm(linkToSibling, { recursive: true, force: true })
    await rm(linkToParent, { recursive: true, force: true })
    await rm(realSibling, { recursive: true, force: true })
  }
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
  if (!missingProjection.ok) {
    assert.match(missingProjection.message, /projection\.json|ENOENT/u)
    // The run directory still exists — a just-created run has not written its
    // projection yet, so this must stay transient (pollers keep retrying).
    assert.notEqual(missingProjection.permanent, true)
  }

  await writeFile(join(teamDir, 'projection.json'), '{not-json', 'utf-8')
  const invalidProjection = await handlers.readProjection({ statePath })
  assert.equal(invalidProjection.ok, false)
  if (!invalidProjection.ok) assert.match(invalidProjection.message, /JSON|Unexpected|property name/u)
}

// A run directory that no longer exists (archived or deleted out from under the
// workspace) is a permanent failure: no retry heals it, so the result carries
// `permanent: true` and pollers stop instead of re-failing every tick.
async function testReadProjectionMarksMissingRunDirectoryPermanent(): Promise<void> {
  const { statePath, teamDir } = await createStateFixture()
  const handlers = createHandlers(async () => {
    throw new Error('projection reads must not call MCP')
  })

  await rm(teamDir, { recursive: true })
  const result = await handlers.readProjection({ statePath })
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.permanent, true)
    assert.ok(result.message.includes(teamDir), 'the message must name the missing folder')
  }
}

// Decision 8: a pre-MC-1542 store is rejected LOUDLY at every surface that reads
// one. The renderer reads projection.json off disk without touching Python, so
// this guard is the only thing between an old store and a board rendering
// gate-era columns.
async function testReadProjectionRejectsPreMc1542Store(): Promise<void> {
  const { statePath, teamDir } = await createStateFixture()
  const handlers = createHandlers(async () => {
    throw new Error('projection reads must not call MCP')
  })

  await writeFile(
    join(teamDir, 'projection.json'),
    JSON.stringify({ run: { id: 'team', schemaVersion: 1 }, tasks: [] }),
    'utf-8'
  )
  const stale = await handlers.readProjection({ statePath })
  assert.equal(stale.ok, false)
  if (!stale.ok) {
    assert.match(stale.message, /older version of Multicode/u)
    assert.match(stale.message, /Delete/u)
    assert.ok(stale.message.includes(teamDir), 'the message must name the folder to delete')
    // An old store never becomes readable: permanent, so pollers stop retrying.
    assert.equal(stale.permanent, true)
  }

  // A run block with no schemaVersion predates the field: also version 1.
  await writeFile(join(teamDir, 'projection.json'), JSON.stringify({ run: { id: 'team' }, tasks: [] }), 'utf-8')
  const unversioned = await handlers.readProjection({ statePath })
  assert.equal(unversioned.ok, false)

  await writeFile(
    join(teamDir, 'projection.json'),
    JSON.stringify({ run: { id: 'team', schemaVersion: SPRINT_ENGINE_RUN_SCHEMA_VERSION }, tasks: [] }),
    'utf-8'
  )
  const current = await handlers.readProjection({ statePath })
  assert.equal(current.ok, true)
}

function testDescribeUnsupportedStoreOnlyJudgesRealProjections(): void {
  // No `run` object => not a projection at all. Malformed input is judged
  // downstream; blaming it on an old Multicode would be a lie.
  assert.equal(describeUnsupportedSprintEngineStore(null, '/team'), null)
  assert.equal(describeUnsupportedSprintEngineStore({ tasks: [] }, '/team'), null)
  assert.equal(describeUnsupportedSprintEngineStore({ run: [] }, '/team'), null)
  assert.equal(describeUnsupportedSprintEngineStore({ run: { schemaVersion: 4 } }, '/team'), null)
  // v4 is current; v3, v2 and v1 are rejected (MC-1611 / MC-1591 / MC-1542: never migrate).
  assert.ok(describeUnsupportedSprintEngineStore({ run: { schemaVersion: 3 } }, '/team'))
  assert.ok(describeUnsupportedSprintEngineStore({ run: { schemaVersion: 2 } }, '/team'))
  assert.ok(describeUnsupportedSprintEngineStore({ run: { schemaVersion: 1 } }, '/team'))
  assert.ok(describeUnsupportedSprintEngineStore({ run: {} }, '/team'))
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
  assert.equal(calls[0]?.payload.approvalMode, 'manual', 'manual IPC approval must record manual provenance')
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
  assert.equal(calls[0]?.payload.approvalMode, 'policy', 'auto-run approval must record policy provenance')
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
      directives: { implement: [{ skill: 'marketer' }] },
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

// MC-1612: `vcs pr-merge` reports a REFUSAL (out of merge order, no pull request,
// not a worktree run) as `ok: false` inside its result document and still exits 0 —
// it did its job. The bridge must surface that refusal, because the alternative is a
// Merge button that reports success while the pull request sits exactly where it was.
// Drives the real engine: this is a contract between two processes, and a faked
// stdout would pin the mock's shape rather than the CLI's.
async function testMergePullRequestSurfacesTheEnginesRefusal(): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-sprintengine-pr-merge-'))
  const statePath = join(workspaceRoot, '.multi-code', 'sprintengine', 'team', 'run.yaml')
  const handlers = createHandlers(async () => {
    throw new Error('pr-merge must use the Sprint Engine CLI bridge')
  })

  try {
    const init = await handlers.initializeSprintEngineState({
      statePath,
      name: 'Merge bridge test',
      goal: 'Verify pr-merge refusals reach the user',
      agents: { architect: { role: 'architect' } },
    })
    assert.equal(init.ok, true, init.ok ? undefined : init.message)

    // This run has no worktree, so it has no branch and no pull request to merge.
    const result = await handlers.mergePullRequest({ statePath })

    assert.equal(result.ok, false)
    assert.match(result.ok ? '' : result.message, /worktree mode/u)
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

async function testInitializeSprintEngineStateRecordsRoleRuntimes(): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-sprintengine-role-runtimes-'))
  const statePath = join(workspaceRoot, '.multi-code', 'sprintengine', 'team', 'run.yaml')
  const handlers = createHandlers(async () => {
    throw new Error('init must use the Sprint Engine CLI bridge')
  })

  try {
    const init = await handlers.initializeSprintEngineState({
      statePath,
      name: 'Role runtimes',
      goal: 'Record per-role model',
      agents: { developer: { role: 'developer' } },
      // A role with neither model nor cli must not be recorded (CLI default).
      roleRuntimes: {
        developer: { model: 'claude-fable-5', cli: 'claude-code' },
        tester: { model: null, cli: null },
      },
    })
    assert.equal(init.ok, true, init.ok ? undefined : init.message)
    if (!init.ok) return

    const runYaml = await readFile(statePath, 'utf-8')
    // Scope assertions to the roleRuntimes block (a `tester` role legitimately
    // appears elsewhere in run.yaml, e.g. default quality gates).
    const block = runYaml.slice(runYaml.indexOf('roleRuntimes:')).split(/\n(?=\S)/u)[0]
    assert.match(block, /roleRuntimes:/u)
    assert.match(block, /developer:/u)
    assert.match(block, /claude-fable-5/u)
    assert.doesNotMatch(block, /tester:/u, 'a CLI-default role records no runtime')
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true })
  }
}

async function testInitializeSprintEngineStateRecordsConfiguredRoles(): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-sprintengine-configured-roles-'))
  const statePath = join(workspaceRoot, '.multi-code', 'sprintengine', 'team', 'run.yaml')
  const handlers = createHandlers(async () => {
    throw new Error('init must use the Sprint Engine CLI bridge')
  })

  try {
    // Lazy roster: only the architect is seeded, but enabledRoles carries the
    // full participating set so Python derives reviewer/tester gates for roles
    // that are configured-but-not-yet-seated.
    const init = await handlers.initializeSprintEngineState({
      statePath,
      name: 'Configured roles',
      goal: 'Persist the enabled role set',
      agents: { architect: { role: 'architect' } },
      enabledRoles: ['architect', 'developer', 'tester', 'developer'],
    })
    assert.equal(init.ok, true, init.ok ? undefined : init.message)
    if (!init.ok) return

    const runYaml = await readFile(statePath, 'utf-8')
    // Top-level configuredRoles list, deduped, in the order supplied. YAML
    // renders the block sequence with items on their own `- <role>` lines.
    const cfg = runYaml.match(/^configuredRoles:\n((?:\s*- .*\n?)+)/mu)
    assert.ok(cfg, 'run.yaml records a top-level configuredRoles list')
    const block = cfg[1]
    assert.match(block, /- architect\b/u)
    assert.match(block, /- developer\b/u)
    assert.match(block, /- tester\b/u)
    assert.equal((block.match(/- developer\b/gu) ?? []).length, 1, 'duplicate role is deduped')
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true })
  }
}

async function testReadBridgeSurfacesUnavailableMcpAndMalformedPayloads(): Promise<void> {
  const { workspaceRoot, statePath } = await createStateFixture()
  const handlers = createHandlers(async () => ({
    exitCode: 1,
    stdout: '',
    stderr: 'mcp unavailable',
    response: null,
  }))

  const unavailable = await handlers.readRegistryRoles({ workspaceRoot })
  assert.equal(unavailable.ok, false)
  if (!unavailable.ok) assert.match(unavailable.message, /mcp unavailable/)

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
    approveHumanProof: async (payload) => {
      calls.push(`proof:${payload.taskId}:${payload.artifactId}`)
      return { ok: true, data: {} }
    },
    initializeSprintEngineState: async () => ({ ok: true, data: {} }),
    updateTask: async () => ({ ok: true, data: {} }),
    createTask: async () => ({ ok: true, data: {} }),
    commentTask: async () => ({ ok: true, data: {} }),
    resolveTaskInput: async () => ({ ok: true, data: {} }),
    setTaskStatus: async () => ({ ok: true, data: {} }),
    setRunnerMode: async () => ({ ok: true, data: {} }),
    cancelRun: async () => ({ ok: true, data: {} }),
    createPullRequest: async () => ({ ok: true, data: {} }),
    mergePullRequest: async () => ({ ok: true, data: {} }),
    refreshPullRequestStatus: async () => ({ ok: true, data: {} }),
    setRoleRuntime: async () => ({ ok: true, data: {} }),
    enableRole: async () => ({ ok: true, data: {} }),
    readProjection: async () => ({ ok: true, data: null }),
    readRegistryRoles: async () => {
      calls.push('roles')
      return { ok: true, data: null }
    },
    readRegistryRole: async () => {
      calls.push('role')
      return { ok: true, data: null }
    },
    summarizeFeedback: async () => ({ ok: true, data: null }),
    readTokenUsage: async () => ({} as never),
  })

  await handlers.get('sprintengine:registry:roles:read')?.(null, { workspaceRoot: '/tmp/workspace' })
  await handlers.get('sprintengine:registry:role:read')?.(null, { workspaceRoot: '/tmp/workspace', roleId: 'developer' })
  await handlers.get('sprintengine:proof:approve-human')?.(null, { statePath: '/tmp/workspace/.multi-code/sprintengine/run/run.yaml', taskId: 'P1', artifactId: 'A1' })

  assert.deepEqual(calls, ['roles', 'role', 'proof:P1:A1'])
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})
