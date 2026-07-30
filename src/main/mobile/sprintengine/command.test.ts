import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'fs/promises'
import { platform, tmpdir } from 'os'
import { dirname, join } from 'path'
import {
  buildSprintEngineArtifactReviewArgs,
  mobileControlProtocolVersion,
  MobileSprintEngineCommandService,
  type MobileControlCommand,
  type MobileSprintEngineSessionOrchestrator,
} from './command'
import { createMobileAutomationsController } from './automations-controller'
import { defaultMobileSnapshotCommands, readSprintEngineSnapshot } from './snapshot'
import { deriveWorkspaceId } from './workspace-id'
import type {
  AutomationDefinition,
  AutomationDefinitionDraft,
} from '../../../shared/automations/contracts'
import type { WorkspaceSyncSnapshot } from '../../../shared/workspace-sync'
import type { Workspace } from '../../../renderer/src/types/workspace'
import { createAutomationsEngine } from '../../automations/engine'
import { createBuiltInAutomationProviderRegistry } from '../../automations/provider-registry'
import { AutomationsStore } from '../../automations/store'
import { WEBHOOK_TRIGGER_KIND } from '../../automations/triggers/webhook'
import { registerAutomationsIpc } from '../../ipc/automations-ipc'
import type { IpcInvokeHandler } from '../../module-host/main-host'
import { addOrUpdateBacklogLink, readBacklogObjectStore } from '../../backlog-service'
import { parseBacklogFrontmatter } from '../../../shared/backlog/frontmatter'
import { buildSprintEngineRunLink } from '../../../shared/backlog/sprintengine-links'

const now = new Date('2026-04-28T19:45:00.000Z')

void main()

async function main(): Promise<void> {
  await assertArtifactApproveInvokesSprintEngineTool()
  await assertArtifactApproveUsesAuthorizedDiscoveredStateOutsideServiceCwd()
  await assertArtifactApproveRejectsUnauthorizedDiscoveredStatePath()
  await assertArtifactRequestChangesInvokesSprintEngineTool()
  assertAutoRunArtifactApproveArgsUseCanonicalActor()
  await assertArtifactRequestChangesRejectsStaleSnapshot()
  await assertSameIdempotencyKeyAndBodyReplaysCachedResult()
  await assertSameIdempotencyKeyWithDifferentBodyIsRejected()
  await assertIdempotencyReplaySurvivesServiceRecreation()
  await assertToolSuccessResponseLossRetryDoesNotReinvokeTool()
  await assertInvalidArtifactPathIsRejected()
  await assertSprintEngineCreateUsesControlledHandover()
  await assertSprintEngineCreateHonorsSprintConfig()
  await assertTaskStartUsesDesktopSessionOrchestration()
  await assertTaskStartUsesAuthorizedDiscoveredStateOutsideServiceCwd()
  await assertTaskStartRejectsBlockedDependencies()
  await assertTaskStartConsultsProjectionWhenRunYamlGraphMirrorIsStale()
  await assertFollowUpUsesKnownAgentSessionOrchestration()
  await assertFollowUpUsesAuthorizedDiscoveredStateOutsideServiceCwd()
  await assertFollowUpRejectsTerminalControlCharacters()
  await assertUnsupportedCommandIsRejected()
  await assertBacklogUpdateWritesFrontmatter()
  await assertBacklogStartSprintEngineUsesHandoverAndMarksItem()
  await assertBacklogStartLaunchesAnEpicWithItsChildren()
  await assertBacklogStartHonoursExplicitWorktreeOptOut()
  await assertBacklogStartSkipsWorktreesInANonGitWorkspace()
  await assertBacklogStartLinksTheRunThroughASymlinkedWorkspaceRoot()
  await assertBacklogStartRollsBackTheRunStoreWhenInitFails()
  await assertOpenPullRequestLinksThePrToItsBacklogItem()
  await assertOpenPullRequestReturnsAndLinksEveryProjectsPullRequest()
  await assertBacklogStartRejectsPathOutsideBacklogFolder()
  await assertBacklogCreateWritesFileAndRecord()
  await assertBacklogCreateRejectsEmptyTitle()
  await assertBacklogCreateKeepsGeneratedPathUnderBacklog()
  await assertFilesystemMutationHandlersProtectSprintEngineStateAliases()
  await assertOpenPullRequestInvokesVcsPr()
  await assertSetAutomationModeRoutesToDesktopSession()
  await assertSetAutomationModeRejectsWhenHeadless()
  await assertAutomationsControlPausesAndEnablesThroughTheEngineFrontDoor()
  await assertAutomationsControlRunsAScheduleAutomationNow()
  await assertAutomationsControlSurfacesUnsupportedTriggerFromTheEngine()
  await assertAutomationsControlSurfacesInFlightFromTheEngine()
  await assertAutomationsControlRejectsAnUnknownWorkspaceToken()
  await assertAutomationsControlRejectsMalformedPayloads()
  await assertAutomationsControlSurfacesABlockedProviderHonestly()
  await assertAutomationsControlRejectsAnAutomationTheDesktopNoLongerHas()
  await assertAutomationsControlRetryDoesNotFireASecondRun()
  await assertAutomationsControlRejectsWhenTheModuleIsAbsent()
  await assertAutomationsControlIsAdvertisedOnlyWithItsHandler()
}

// ---------------------------------------------------------------------------
// automations.control (item 47)
//
// The whole point of these is that they run against the REAL automations stack:
// a real AutomationsStore on disk, a real AutomationsEngine, and the real IPC
// front door — wired to the command service through the same production adapter
// (createMobileAutomationsController) that terminal-mobile-command-service uses.
// A stubbed controller would prove the mapping and nothing about the two engine
// limits the phone actually has to respect, which is what this task is about.
// ---------------------------------------------------------------------------

async function assertAutomationsControlPausesAndEnablesThroughTheEngineFrontDoor(): Promise<void> {
  const fixture = await automationsFixture()
  await fixture.createAutomation()

  const paused = await fixture.service.dispatch(command('automations.control', {
    workspacePath: deriveWorkspaceId(fixture.workspaceRoot),
    automationId: 'nightly-review',
    action: 'pause',
  }))

  assert.equal(paused.ok, true)
  assert.deepEqual(paused.ok === true ? paused.data : null, {
    automationId: 'nightly-review',
    status: 'paused',
  })
  // The authoritative store — not just the reply — must carry it, and pausing must
  // clear the scheduled next run, which is what the shared write core does.
  const afterPause = await fixture.readDefinition()
  assert.equal(afterPause.status, 'paused')
  assert.equal(afterPause.nextRunAt, null)

  const enabled = await fixture.service.dispatch(command('automations.control', {
    workspacePath: deriveWorkspaceId(fixture.workspaceRoot),
    automationId: 'nightly-review',
    action: 'enable',
  }, { commandId: 'cmd_2', idempotencyKey: 'mobile:device_1:cmd_2' }))

  assert.equal(enabled.ok, true)
  const afterEnable = await fixture.readDefinition()
  assert.equal(afterEnable.status, 'enabled')
  // Re-enabling reschedules: a paused automation that came back with no next run
  // would never fire again, and the phone would show a live automation that is dead.
  assert.equal(afterEnable.nextRunAt, '2026-06-18T00:10:00.000Z')
}

async function assertAutomationsControlRunsAScheduleAutomationNow(): Promise<void> {
  const fixture = await automationsFixture()
  await fixture.createAutomation()

  const result = await fixture.service.dispatch(command('automations.control', {
    workspacePath: deriveWorkspaceId(fixture.workspaceRoot),
    automationId: 'nightly-review',
    action: 'runNow',
  }))

  assert.equal(result.ok, true)
  assert.equal(fixture.runs.length, 1, 'run-now must actually fire the automation, not just report success')
  const data = result.ok === true ? result.data as { runId?: string; runStatus?: string; status?: string } : null
  assert.equal(data?.runStatus, 'completed')
  assert.equal(data?.status, 'enabled')
  assert.ok(data?.runId, 'the phone gets the run id it just started')

  // The result rides the relay, which rejects any summary containing a local path.
  // The engine's own result carries the full definition (provider-owned trigger and
  // action config, which can hold paths and webhook secrets); only the narrow view
  // may cross the wire.
  const serialized = JSON.stringify(result.ok === true ? result.data : {})
  assert.ok(!serialized.includes(fixture.workspaceRoot), 'command result must not carry the local workspace path')
  assert.ok(!serialized.includes('Review this workspace.'), 'command result must not carry the automation prompt')
}

async function assertAutomationsControlSurfacesUnsupportedTriggerFromTheEngine(): Promise<void> {
  // ENGINE LIMIT 1a: run-now is schedule-triggers-only (engine.ts runNow). The
  // engine hard-rejects anything else, so the desktop must surface that rejection
  // rather than swallow it — and the phone must not draw the button at all, which
  // is what `triggerKind` on the projection is for.
  const fixture = await automationsFixture()
  await fixture.createAutomation({
    id: 'on-webhook',
    name: 'On Webhook',
    trigger: { kind: WEBHOOK_TRIGGER_KIND, config: { kind: WEBHOOK_TRIGGER_KIND, enabled: false } },
  })

  const result = await fixture.service.dispatch(command('automations.control', {
    workspacePath: deriveWorkspaceId(fixture.workspaceRoot),
    automationId: 'on-webhook',
    action: 'runNow',
  }))

  assert.equal(result.ok, false)
  assert.equal(result.ok === false ? result.error.code : '', 'command_not_supported')
  assert.equal(result.ok === false ? result.error.retryable : true, false)
  // The engine's own words reach the phone: a rejection the user cannot read is a
  // rejection that gets retried forever.
  assert.match(result.ok === false ? result.error.message : '', /not supported/i)
  assert.equal(fixture.runs.length, 0)

  // Enable/pause is NOT schedule-only — the limit is run-now's alone. A webhook
  // automation must still be pausable from the phone. This is the negative control
  // for the rejection above: it proves the command reaches the engine for this
  // automation, so `unsupported_trigger` came from the trigger kind and not from a
  // fixture that simply could not be controlled at all.
  const paused = await fixture.service.dispatch(command('automations.control', {
    workspacePath: deriveWorkspaceId(fixture.workspaceRoot),
    automationId: 'on-webhook',
    action: 'pause',
  }, { commandId: 'cmd_2', idempotencyKey: 'mobile:device_1:cmd_2' }))
  assert.equal(paused.ok, true)
  assert.equal((await fixture.readDefinition('on-webhook')).status, 'paused')
}

async function assertAutomationsControlSurfacesInFlightFromTheEngine(): Promise<void> {
  // ENGINE LIMIT 1b: a second run while one is in flight is rejected with
  // `in_flight` (engine.ts runNow). Proven against the real engine by holding the
  // first run open, so the rejection comes from the engine's own in-flight set
  // rather than from a stub that was told to say so.
  let releaseFirstRun = (): void => {}
  const firstRunStarted = new Promise<void>((resolveStarted) => {
    const fixtureRunGate = new Promise<void>((resolveGate) => {
      releaseFirstRun = resolveGate
    })
    pendingRunGate = { started: resolveStarted, gate: fixtureRunGate }
  })

  const fixture = await automationsFixture()
  await fixture.createAutomation()

  const workspacePath = deriveWorkspaceId(fixture.workspaceRoot)
  const firstRun = fixture.service.dispatch(command('automations.control', {
    workspacePath,
    automationId: 'nightly-review',
    action: 'runNow',
  }))
  await firstRunStarted

  const secondRun = await fixture.service.dispatch(command('automations.control', {
    workspacePath,
    automationId: 'nightly-review',
    action: 'runNow',
  }, { commandId: 'cmd_2', idempotencyKey: 'mobile:device_1:cmd_2' }))

  assert.equal(secondRun.ok, false)
  assert.equal(secondRun.ok === false ? secondRun.error.code : '', 'task_not_ready')
  // Retryable, unlike unsupported_trigger: this exact command succeeds once the
  // run in flight finishes.
  assert.equal(secondRun.ok === false ? secondRun.error.retryable : false, true)
  assert.match(secondRun.ok === false ? secondRun.error.message : '', /already running/i)

  releaseFirstRun()
  assert.equal((await firstRun).ok, true)
  assert.equal(fixture.runs.length, 1, 'the in-flight rejection must not have started a second run')

  // Negative control: once the run in flight has finished, the SAME command
  // succeeds. Without this, a run-now that was simply broken would pass the
  // rejection assertions above for the wrong reason.
  const afterItFinished = await fixture.service.dispatch(command('automations.control', {
    workspacePath,
    automationId: 'nightly-review',
    action: 'runNow',
  }, { commandId: 'cmd_3', idempotencyKey: 'mobile:device_1:cmd_3' }))
  assert.equal(afterItFinished.ok, true, 'run-now must be accepted once nothing is in flight')
  assert.equal(fixture.runs.length, 2)
}

async function assertAutomationsControlRejectsAnUnknownWorkspaceToken(): Promise<void> {
  // Fail closed: a workspace token this desktop cannot resolve never reaches the
  // automations store.
  const fixture = await automationsFixture()
  await fixture.createAutomation()

  const result = await fixture.service.dispatch(command('automations.control', {
    workspacePath: deriveWorkspaceId(join(tmpdir(), 'multicode-not-this-workspace')),
    automationId: 'nightly-review',
    action: 'pause',
  }))

  assert.equal(result.ok, false)
  assert.equal(result.ok === false ? result.error.code : '', 'path_not_allowed')
  assert.equal((await fixture.readDefinition()).status, 'enabled', 'the automation must be untouched')
}

async function assertAutomationsControlRejectsMalformedPayloads(): Promise<void> {
  const fixture = await automationsFixture()
  await fixture.createAutomation()
  const workspacePath = deriveWorkspaceId(fixture.workspaceRoot)

  const malformed: Array<Record<string, unknown>> = [
    { automationId: 'nightly-review', action: 'pause' },
    { workspacePath, action: 'pause' },
    { workspacePath, automationId: 'nightly-review' },
    // `cancel` is the one the UI will be tempted by, and it must never validate:
    // no cancel primitive exists in the engine.
    { workspacePath, automationId: 'nightly-review', action: 'cancel' },
    { workspacePath, automationId: 'nightly-review', action: 'enable', extra: 'ok-to-ignore', ...{} },
  ]

  for (const [index, payload] of malformed.entries()) {
    const result = await fixture.service.dispatch(command(
      'automations.control',
      payload as MobileControlCommand['payload'],
      { commandId: `cmd_bad_${index}`, idempotencyKey: `mobile:device_1:cmd_bad_${index}` }
    ))
    // The last payload is well-formed (an unknown extra key is tolerated), so it is
    // the negative control: if validation were rejecting everything, it would fail here.
    const expectAccepted = index === malformed.length - 1
    assert.equal(result.ok, expectAccepted, `payload ${index} acceptance`)
    if (!expectAccepted && result.ok === false) {
      assert.equal(result.error.code, 'invalid_payload', `payload ${index} error code`)
    }
  }
}

async function assertAutomationsControlSurfacesABlockedProviderHonestly(): Promise<void> {
  // The `blocked` status exists BECAUSE a provider is missing or refused, so enabling
  // a blocked automation is the one the phone will actually hit. The write core
  // refuses it (unknown_action / provider_blocked), and reporting that as an internal
  // error would tell the user "something broke" when the truth is "this desktop has
  // no such connector". Seeded through the store directly, which is how a definition
  // whose provider this build does not register comes to exist on disk.
  const fixture = await automationsFixture()
  await new AutomationsStore(fixture.workspaceRoot).createDefinition({
    id: 'needs-watchtower',
    name: 'Needs a connector this build lacks',
    status: 'blocked',
    trigger: { kind: 'schedule', config: { kind: 'schedule', cadence: { type: 'interval', everyMinutes: 30 }, timezone: 'UTC' } },
    action: { kind: 'acme.unregistered-action', config: {} },
    autonomyDefault: 'review_only',
    nextRunAt: null,
    lastRunAt: null,
    lastRunId: null,
    createdAt: '2026-06-18T00:00:00.000Z',
    updatedAt: '2026-06-18T00:00:00.000Z',
  })

  const result = await fixture.service.dispatch(command('automations.control', {
    workspacePath: deriveWorkspaceId(fixture.workspaceRoot),
    automationId: 'needs-watchtower',
    action: 'enable',
  }))

  assert.equal(result.ok, false)
  assert.equal(result.ok === false ? result.error.code : '', 'command_not_supported')
  // The provider's own reason reaches the phone, not a generic failure.
  assert.match(result.ok === false ? result.error.message : '', /acme\.unregistered-action/)
  // And it stays blocked: a refused enable must not half-apply.
  assert.equal((await fixture.readDefinition('needs-watchtower')).status, 'blocked')
}

async function assertAutomationsControlRejectsAnAutomationTheDesktopNoLongerHas(): Promise<void> {
  // The phone acted on a snapshot listing an automation that has since been deleted.
  // That is a stale view, not an internal fault, and not a malformed payload.
  const fixture = await automationsFixture()
  await fixture.createAutomation()

  const result = await fixture.service.dispatch(command('automations.control', {
    workspacePath: deriveWorkspaceId(fixture.workspaceRoot),
    automationId: 'deleted-yesterday',
    action: 'pause',
  }))

  assert.equal(result.ok, false)
  assert.equal(result.ok === false ? result.error.code : '', 'stale_snapshot')
}

async function assertAutomationsControlRetryDoesNotFireASecondRun(): Promise<void> {
  // Run-now spawns an agent. A phone that retries on a lost response (the exact case
  // idempotencyKey exists for) must NOT fire a second agent run: that costs real money
  // and can collide with the run already going.
  const fixture = await automationsFixture()
  await fixture.createAutomation()

  const runNow = () => fixture.service.dispatch(command('automations.control', {
    workspacePath: deriveWorkspaceId(fixture.workspaceRoot),
    automationId: 'nightly-review',
    action: 'runNow',
  }))

  const first = await runNow()
  const replayed = await runNow()

  assert.equal(first.ok, true)
  assert.equal(replayed.ok, true)
  assert.equal(fixture.runs.length, 1, 'a retried run-now must replay the cached result, not spawn a second agent run')
  assert.deepEqual(
    replayed.ok === true ? replayed.data : null,
    first.ok === true ? first.data : undefined,
    'the retry must return the original run, not a new one'
  )
}

async function assertAutomationsControlRejectsWhenTheModuleIsAbsent(): Promise<void> {
  // A desktop build with no Automations module must reject honestly rather than
  // report a success nobody applied.
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-mobile-automations-absent-'))
  const service = new MobileSprintEngineCommandService({
    workspaceRoot,
    now: () => now,
    execute: async () => {
      throw new Error('the Sprint Engine tool must not run for automation control')
    },
    automationsController: createMobileAutomationsController(() => null),
  })

  const result = await service.dispatch(command('automations.control', {
    workspacePath: deriveWorkspaceId(workspaceRoot),
    automationId: 'nightly-review',
    action: 'enable',
  }))

  assert.equal(result.ok, false)
  assert.equal(result.ok === false ? result.error.code : '', 'command_not_supported')
}

async function assertAutomationsControlIsAdvertisedOnlyWithItsHandler(): Promise<void> {
  // snapshot.commands is what the phone reads to know it may send the command. It
  // is `string[]` on the wire so it CAN grow without a client release — which is
  // exactly why advertising a command the desktop cannot execute would be a lie the
  // protocol has no way to catch.
  assert.ok(
    defaultMobileSnapshotCommands.includes('automations.control'),
    'automations.control must be advertised now that the desktop can execute it'
  )
}

// A real automations stack over a temp workspace: real store on disk, real engine,
// real IPC front door, and the production controller adapter.
let pendingRunGate: { started: () => void; gate: Promise<void> } | null = null

async function automationsFixture(): Promise<{
  workspaceRoot: string
  service: MobileSprintEngineCommandService
  runs: string[]
  createAutomation(overrides?: Partial<AutomationDefinitionDraft>): Promise<void>
  readDefinition(automationId?: string): Promise<AutomationDefinition>
}> {
  const workspaceRoot = await realpath(await mkdtemp(join(tmpdir(), 'multicode-mobile-automations-')))
  const runs: string[] = []
  const runGate = pendingRunGate
  pendingRunGate = null

  const providerRegistry = createBuiltInAutomationProviderRegistry()
  const engine = createAutomationsEngine({
    createStore: (root) => new AutomationsStore(root),
    getProjectFolders: () => [{ workspaceId: 'ws-1', folderPath: workspaceRoot }],
    runAutomation: async (input) => {
      runs.push(input.definition.id)
      // Held open only by the in-flight test, which needs a run that is genuinely
      // still running when the second command arrives.
      if (runGate) {
        runGate.started()
        await runGate.gate
      }
      return { status: 'completed', summary: 'Manual run completed.' }
    },
    now: () => automationsNow,
    createRunId: ({ automationId, dueAt }) => `${automationId}-${Date.parse(dueAt)}`,
  })

  const handlers = new Map<string, IpcInvokeHandler>()
  const frontDoor = registerAutomationsIpc(
    { registerIpc: (channel, handler) => handlers.set(channel, handler) },
    {
      engine,
      createStore: (root) => new AutomationsStore(root),
      triggerProviders: providerRegistry.listTriggerProviders(),
      actionProviders: providerRegistry.listActionProviders(),
      getWorkspaceSyncSnapshot: () => automationsWorkspaceSnapshot(workspaceRoot),
      now: () => automationsNow,
    }
  )

  const service = new MobileSprintEngineCommandService({
    workspaceRoot,
    now: () => now,
    execute: async () => {
      throw new Error('the Sprint Engine tool must not run for automation control')
    },
    automationsController: createMobileAutomationsController(() => frontDoor),
  })

  return {
    workspaceRoot,
    service,
    runs,
    async createAutomation(overrides: Partial<AutomationDefinitionDraft> = {}): Promise<void> {
      const created = await frontDoor.createDefinition({
        workspaceRoot,
        definition: {
          id: 'nightly-review',
          name: 'Nightly Review',
          status: 'enabled',
          trigger: {
            kind: 'schedule',
            config: { kind: 'schedule', timezone: 'UTC', cadence: { type: 'interval', everyMinutes: 10 } },
          },
          action: { kind: 'spawn-agent', config: { prompt: 'Review this workspace.' } },
          autonomyDefault: 'review_only',
          ...overrides,
        },
      })
      assert.equal(created.ok, true, `automation fixture must be created: ${created.ok === false ? created.message : ''}`)
    },
    async readDefinition(automationId = 'nightly-review'): Promise<AutomationDefinition> {
      const definition = await new AutomationsStore(workspaceRoot).getDefinition(automationId)
      assert.equal(definition.ok, true)
      if (!definition.ok) throw new Error('unreachable')
      return definition.value
    },
  }
}

const automationsNow = Date.parse('2026-06-18T00:00:00.000Z')

function automationsWorkspaceSnapshot(workspaceRoot: string): WorkspaceSyncSnapshot {
  return {
    sequence: 1,
    state: {
      activeWorkspaceId: 'ws-1',
      primaryWorkspaceWindowId: 'primary',
      workspaceWindows: [],
      // Only the id/name/folderPath are read here; the rest of Workspace is a
      // renderer-owned shape this snapshot never carries.
      workspaces: [{
        id: 'ws-1',
        name: 'Automations',
        folderPath: workspaceRoot,
      } as Workspace],
    },
  }
}

async function assertSetAutomationModeRoutesToDesktopSession(): Promise<void> {
  // MC-1497: the mode is renderer-owned, so the command routes to the desktop
  // session orchestrator rather than the CLI.
  const fixture = await writeSprintEngineFixture('automation-team', '.multi-code/sprintengine/automation-team/documents/requirements.md')
  const calls: Array<{ mode: string; sprintEngineId: string; statePath: string }> = []
  const service = new MobileSprintEngineCommandService({
    workspaceRoot: fixture.workspaceRoot,
    statePaths: [fixture.statePath],
    now: () => now,
    execute: async () => {
      throw new Error('Sprint Engine tool should not run for automation-mode changes')
    },
    sessionOrchestrator: {
      startTask: async () => {
        throw new Error('startTask should not run')
      },
      sendFollowUp: async () => {
        throw new Error('sendFollowUp should not run')
      },
      setAutomationMode: async (request) => {
        calls.push({ mode: request.mode, sprintEngineId: request.sprintEngineId, statePath: request.statePath })
        return { mode: request.mode, appliedAt: now.toISOString() }
      },
    },
  })

  const result = await service.dispatch(command('sprintengine.setAutomationMode', {
    sprintEngineId: 'automation-team',
    mode: 'run_agents_and_approve_artifacts',
  }))

  assert.equal(result.ok, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].mode, 'run_agents_and_approve_artifacts')
  assert.equal(calls[0].statePath, fixture.statePath)
}

async function assertSetAutomationModeRejectsWhenHeadless(): Promise<void> {
  // With no desktop session (no orchestrator wire), the command must reject
  // cleanly rather than write a value the supervisor won't read.
  const fixture = await writeSprintEngineFixture('automation-headless-team', '.multi-code/sprintengine/automation-headless-team/documents/requirements.md')
  const service = new MobileSprintEngineCommandService({
    workspaceRoot: fixture.workspaceRoot,
    statePaths: [fixture.statePath],
    now: () => now,
    execute: async () => ({ exitCode: 0, stdout: '{"ok":true}', stderr: '' }),
  })

  const result = await service.dispatch(command('sprintengine.setAutomationMode', {
    sprintEngineId: 'automation-headless-team',
    mode: 'manual',
  }))

  assert.equal(result.ok, false)
  assert.equal(result.ok === false ? result.error.code : '', 'command_not_supported')
}

async function assertOpenPullRequestInvokesVcsPr(): Promise<void> {
  // MC-1496: the mobile openPullRequest command shells the Sprint Engine CLI
  // `vcs pr` with the mobile actor id; the CLI owns idempotency + guards.
  const fixture = await writeSprintEngineFixture('pr-team', '.multi-code/sprintengine/pr-team/documents/requirements.md')
  const invocations: Array<{ args: string[]; cwd: string }> = []
  const service = new MobileSprintEngineCommandService({
    workspaceRoot: fixture.workspaceRoot,
    statePaths: [fixture.statePath],
    now: () => now,
    execute: async (invocation) => {
      invocations.push(invocation)
      return { exitCode: 0, stdout: '{"ok":true,"data":{"pullRequestUrl":"https://github.com/acme/repo/pull/9"}}', stderr: '' }
    },
  })

  const result = await service.dispatch(command('sprintengine.openPullRequest', { sprintEngineId: 'pr-team' }))

  assert.equal(result.ok, true)
  assert.equal(invocations.length, 1)
  assert.deepEqual(invocations[0].args, ['--state', fixture.statePath, 'vcs', 'pr', '--id', 'mobile:device_1'])
  assert.equal(invocations[0].cwd, fixture.workspaceRoot)
  assert.equal(service.getAuditLog()[0].status, 'accepted')
}

async function assertOpenPullRequestLinksThePrToItsBacklogItem(): Promise<void> {
  // The payoff of the epic: with the desktop closed, opening the PR must reach
  // back to the item that started the run. The renderer's projection tick does
  // this today, but it only runs with a window mounted on the workspace.
  const fixture = await writeSprintEngineFixture('pr-link-team', '.multi-code/sprintengine/pr-link-team/documents/requirements.md')
  await mkdir(join(fixture.workspaceRoot, 'backlog'), { recursive: true })
  await writeFile(
    join(fixture.workspaceRoot, 'backlog', 'feature.md'),
    '---\ntype: feature\nstatus: in_progress\n---\n\n# Ship it\n\nBody.\n',
    'utf8'
  )
  // The execution link the start path wrote — the only backlog -> run correspondence.
  await addOrUpdateBacklogLink({
    workspaceRoot: fixture.workspaceRoot,
    relativePath: 'backlog/feature.md',
    link: buildSprintEngineRunLink({
      teamSlug: 'pr-link-team',
      runRelativePath: '.multi-code/sprintengine/pr-link-team/run.yaml',
    }),
  })

  const service = new MobileSprintEngineCommandService({
    workspaceRoot: fixture.workspaceRoot,
    statePaths: [fixture.statePath],
    now: () => now,
    // The real `vcs pr` answers with pullRequestUrl at the top level.
    execute: async () => ({
      exitCode: 0,
      stdout: JSON.stringify({ ok: true, action: 'vcs_pr', branch: 'se/pr-link-team', pullRequestUrl: 'https://github.com/acme/repo/pull/9' }),
      stderr: '',
    }),
  })

  const result = await service.dispatch(command('sprintengine.openPullRequest', { sprintEngineId: 'pr-link-team' }))
  assert.equal(result.ok, true)

  const items = await readBacklogStoreItems(fixture.workspaceRoot)
  const record = items.find((item) => item.source.relativePath === 'backlog/feature.md')
  const prLink = record?.links?.find((link) => link.id === 'sprint-engine:pull-request')
  assert.equal(prLink?.target.kind, 'sprintengine.pullRequest')
  assert.equal(prLink?.target.url, 'https://github.com/acme/repo/pull/9')
  // `external` is lifecycle-neutral: attaching a PR never moves the item.
  assert.equal(prLink?.type, 'external')
  const frontmatter = parseBacklogFrontmatter(await readFile(join(fixture.workspaceRoot, 'backlog', 'feature.md'), 'utf8'))
  assert.equal(frontmatter.fields.status, 'in_progress')
}

async function assertOpenPullRequestReturnsAndLinksEveryProjectsPullRequest(): Promise<void> {
  // MC-1612: a run spanning projects opens one pull request per project. The phone
  // must be told about all of them, and the item must link all of them — a single
  // link would silently hide half of what the sprint delivered.
  const fixture = await writeSprintEngineFixture('multi-pr-team', '.multi-code/sprintengine/multi-pr-team/documents/requirements.md')
  await mkdir(join(fixture.workspaceRoot, 'backlog'), { recursive: true })
  await writeFile(
    join(fixture.workspaceRoot, 'backlog', 'feature.md'),
    '---\ntype: feature\nstatus: in_progress\n---\n\n# Ship it\n\nBody.\n',
    'utf8'
  )
  await addOrUpdateBacklogLink({
    workspaceRoot: fixture.workspaceRoot,
    relativePath: 'backlog/feature.md',
    link: buildSprintEngineRunLink({
      teamSlug: 'multi-pr-team',
      runRelativePath: '.multi-code/sprintengine/multi-pr-team/run.yaml',
    }),
  })

  const service = new MobileSprintEngineCommandService({
    workspaceRoot: fixture.workspaceRoot,
    statePaths: [fixture.statePath],
    now: () => now,
    // The real multi-project `vcs pr`: every project under `repos` (each naming
    // itself the way a person says it), the primary's url still at the top level.
    execute: async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        ok: true,
        action: 'vcs_pr',
        pullRequestUrl: 'https://github.com/acme/repo/pull/9',
        repos: [
          { repo: 'primary', ok: true, project: 'multicode', pullRequestUrl: 'https://github.com/acme/repo/pull/9' },
          { repo: 'mobile', ok: true, project: 'multicode-mobile', pullRequestUrl: 'https://github.com/acme/mobile/pull/3' },
        ],
      }),
      stderr: '',
    }),
  })

  const result = await service.dispatch(command('sprintengine.openPullRequest', { sprintEngineId: 'multi-pr-team' }))
  assert.equal(result.ok, true)

  // Additive only: `pullRequests` rides beside the fields the phone already knows,
  // so the protocol stays v2 and no new scope is needed.
  const data = result.ok ? (result.data as { pullRequestUrl?: string; pullRequests?: unknown[] }) : {}
  assert.equal(data.pullRequestUrl, 'https://github.com/acme/repo/pull/9')
  assert.deepEqual(data.pullRequests, [
    { repo: 'primary', url: 'https://github.com/acme/repo/pull/9', repoLabel: 'multicode' },
    { repo: 'mobile', url: 'https://github.com/acme/mobile/pull/3', repoLabel: 'multicode-mobile' },
  ])

  const items = await readBacklogStoreItems(fixture.workspaceRoot)
  const links = items.find((item) => item.source.relativePath === 'backlog/feature.md')?.links ?? []
  // One link per project. The primary keeps the id it has always had, so a
  // single-project run's link is untouched; the sibling gets its own.
  const primaryLink = links.find((link) => link.id === 'sprint-engine:pull-request')
  const mobileLink = links.find((link) => link.id === 'sprint-engine:pull-request:mobile')
  assert.equal(primaryLink?.target.url, 'https://github.com/acme/repo/pull/9')
  assert.equal(primaryLink?.label, 'Pull request (multicode)')
  assert.equal(mobileLink?.target.url, 'https://github.com/acme/mobile/pull/3')
  assert.equal(mobileLink?.label, 'Pull request (multicode-mobile)')
  assert.equal(mobileLink?.type, 'external')
}

async function assertArtifactApproveInvokesSprintEngineTool(): Promise<void> {
  const fixture = await writeSprintEngineFixture('review-team', '.multi-code/sprintengine/review-team/documents/requirements.md')
  const invocations: Array<{ args: string[]; cwd: string }> = []
  const service = new MobileSprintEngineCommandService({
    workspaceRoot: fixture.workspaceRoot,
    statePaths: [fixture.statePath],
    now: () => now,
    execute: async (invocation) => {
      invocations.push(invocation)
      return { exitCode: 0, stdout: '{"ok":true,"action":"approved"}', stderr: '' }
    },
  })

  const result = await service.dispatch(command('artifact.approve', {
    sprintEngineId: 'review-team',
    artifactId: 'A1',
  }))

  assert.equal(result.ok, true)
  assert.equal(invocations.length, 1)
  assert.deepEqual(invocations[0].args, [
    '--state',
    fixture.statePath,
    'artifact',
    'approve',
    '--artifact-id',
    'A1',
    '--id',
    'mobile:device_1',
  ])
  assert.equal(invocations[0].cwd, fixture.workspaceRoot)
  assert.equal(service.getAuditLog()[0].status, 'accepted')
}

async function assertArtifactApproveUsesAuthorizedDiscoveredStateOutsideServiceCwd(): Promise<void> {
  const fixture = await writeSprintEngineFixture('discovered-review-team', '.multi-code/sprintengine/discovered-review-team/documents/requirements.md')
  const serviceWorkspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-mobile-command-cwd-'))
  const invocations: Array<{ args: string[]; cwd: string }> = []
  const service = new MobileSprintEngineCommandService({
    workspaceRoot: serviceWorkspaceRoot,
    now: () => now,
    execute: async (invocation) => {
      invocations.push(invocation)
      return { exitCode: 0, stdout: '{"ok":true,"action":"approved"}', stderr: '' }
    },
  })

  const result = await service.dispatch(command('artifact.approve', {
    sprintEngineId: 'discovered-review-team',
    artifactId: 'A1',
  }, {
    commandId: 'cmd_discovered_review',
    idempotencyKey: 'mobile:device_1:discovered-review',
  }), {
    statePaths: [fixture.statePath],
    allowedWorkspaceRoots: [fixture.workspaceRoot],
  })

  assert.equal(result.ok, true)
  assert.equal(invocations.length, 1)
  assert.equal(invocations[0].cwd, fixture.workspaceRoot)
  assert.deepEqual(invocations[0].args.slice(0, 2), ['--state', fixture.statePath])
}

async function assertArtifactApproveRejectsUnauthorizedDiscoveredStatePath(): Promise<void> {
  const fixture = await writeSprintEngineFixture('unauthorized-review-team', '.multi-code/sprintengine/unauthorized-review-team/documents/requirements.md')
  const allowedWorkspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-mobile-command-allowed-'))
  let invocationCount = 0
  const service = new MobileSprintEngineCommandService({
    workspaceRoot: allowedWorkspaceRoot,
    now: () => now,
    execute: async () => {
      invocationCount += 1
      return { exitCode: 0, stdout: '{"ok":true}', stderr: '' }
    },
  })

  const result = await service.dispatch(command('artifact.approve', {
    sprintEngineId: 'unauthorized-review-team',
    artifactId: 'A1',
  }, {
    commandId: 'cmd_unauthorized_review',
    idempotencyKey: 'mobile:device_1:unauthorized-review',
  }), {
    statePaths: [fixture.statePath],
    allowedWorkspaceRoots: [allowedWorkspaceRoot],
  })

  assert.equal(result.ok, false)
  assert.equal(result.ok === false ? result.error.code : '', 'path_not_allowed')
  assert.equal(invocationCount, 0)
}

async function assertArtifactRequestChangesInvokesSprintEngineTool(): Promise<void> {
  const fixture = await writeSprintEngineFixture('request-changes-team', '.multi-code/sprintengine/request-changes-team/documents/requirements.md')
  const invocations: Array<{ args: string[]; cwd: string }> = []
  const service = new MobileSprintEngineCommandService({
    workspaceRoot: fixture.workspaceRoot,
    statePaths: [fixture.statePath],
    now: () => now,
    execute: async (invocation) => {
      invocations.push(invocation)
      return { exitCode: 0, stdout: '{"ok":true,"action":"changes_requested"}', stderr: '' }
    },
  })

  const result = await service.dispatch(command('artifact.requestChanges', {
    sprintEngineId: 'request-changes-team',
    artifactId: 'A1',
    feedback: 'Clarify the acceptance criteria.',
  }))

  assert.equal(result.ok, true)
  assert.equal(invocations.length, 1)
  assert.deepEqual(invocations[0].args, [
    '--state',
    fixture.statePath,
    'artifact',
    'request-changes',
    '--artifact-id',
    'A1',
    '--id',
    'mobile:device_1',
    '--feedback',
    'Clarify the acceptance criteria.',
  ])
  assert.equal(invocations[0].cwd, fixture.workspaceRoot)
}

function assertAutoRunArtifactApproveArgsUseCanonicalActor(): void {
  assert.deepEqual(buildSprintEngineArtifactReviewArgs({
    statePath: '/workspace/.multi-code/sprintengine/team/run.yaml',
    action: 'approve',
    artifactId: 'A1',
    actorId: 'auto-run',
  }), [
    '--state',
    '/workspace/.multi-code/sprintengine/team/run.yaml',
    'artifact',
    'approve',
    '--artifact-id',
    'A1',
    '--id',
    'auto-run',
  ])
}

async function assertArtifactRequestChangesRejectsStaleSnapshot(): Promise<void> {
  const fixture = await writeSprintEngineFixture('stale-team', '.multi-code/sprintengine/stale-team/documents/requirements.md')
  const service = new MobileSprintEngineCommandService({
    workspaceRoot: fixture.workspaceRoot,
    statePaths: [fixture.statePath],
    now: () => now,
    execute: async () => {
      throw new Error('tool should not run for stale snapshots')
    },
  })

  const result = await service.dispatch(command('artifact.requestChanges', {
    sprintEngineId: 'stale-team',
    artifactId: 'A1',
    feedback: 'Clarify the acceptance criteria.',
  }, {
    expectedSnapshotVersion: 'snap_stale',
    idempotencyKey: 'mobile:device_1:stale',
  }))

  assert.equal(result.ok, false)
  assert.equal(result.ok === false ? result.error.code : '', 'stale_snapshot')
}

async function assertSameIdempotencyKeyAndBodyReplaysCachedResult(): Promise<void> {
  const fixture = await writeSprintEngineFixture('replay-team', '.multi-code/sprintengine/replay-team/documents/requirements.md')
  let invocationCount = 0
  const service = new MobileSprintEngineCommandService({
    workspaceRoot: fixture.workspaceRoot,
    statePaths: [fixture.statePath],
    now: () => now,
    execute: async () => {
      invocationCount += 1
      return { exitCode: 0, stdout: '{"ok":true}', stderr: '' }
    },
  })
  const mobileCommand = command('artifact.approve', {
    sprintEngineId: 'replay-team',
    artifactId: 'A1',
  }, {
    idempotencyKey: 'mobile:device_1:replay',
  })

  const first = await service.dispatch(mobileCommand)
  const second = await service.dispatch({ ...mobileCommand, commandId: 'cmd_replay' })

  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.equal(invocationCount, 1)
  assert.deepEqual(second.ok && first.ok ? second.data : null, first.ok ? first.data : null)
  assert.equal(service.getAuditLog()[0].status, 'accepted')
  assert.equal(service.getAuditLog()[0].deviceId, 'device_1')
  assert.equal(service.getAuditLog()[0].commandId, 'cmd_replay')
}

async function assertSameIdempotencyKeyWithDifferentBodyIsRejected(): Promise<void> {
  const fixture = await writeSprintEngineFixture('replay-conflict-team', '.multi-code/sprintengine/replay-conflict-team/documents/requirements.md')
  let invocationCount = 0
  const service = new MobileSprintEngineCommandService({
    workspaceRoot: fixture.workspaceRoot,
    statePaths: [fixture.statePath],
    now: () => now,
    execute: async () => {
      invocationCount += 1
      return { exitCode: 0, stdout: '{"ok":true}', stderr: '' }
    },
  })
  const firstCommand = command('artifact.approve', {
    sprintEngineId: 'replay-conflict-team',
    artifactId: 'A1',
  }, {
    idempotencyKey: 'mobile:device_1:replay-conflict',
  })

  const first = await service.dispatch(firstCommand)
  const second = await service.dispatch(command('artifact.requestChanges', {
    sprintEngineId: 'replay-conflict-team',
    artifactId: 'A1',
    feedback: 'This different body must not be executed.',
  }, {
    commandId: 'cmd_replay_conflict',
    idempotencyKey: 'mobile:device_1:replay-conflict',
  }))

  assert.equal(first.ok, true)
  assert.equal(second.ok, false)
  assert.equal(second.ok === false ? second.error.code : '', 'duplicate_idempotency_key')
  assert.equal(invocationCount, 1)
  const audit = service.getAuditLog()[0]
  assert.equal(audit.status, 'rejected')
  assert.equal(audit.deviceId, 'device_1')
  assert.equal(audit.commandId, 'cmd_replay_conflict')
  assert.equal(audit.code, 'duplicate_idempotency_key')
  assert.equal(JSON.stringify(audit).includes('This different body'), false)
}

async function assertIdempotencyReplaySurvivesServiceRecreation(): Promise<void> {
  const fixture = await writeSprintEngineFixture('replay-recreate-team', '.multi-code/sprintengine/replay-recreate-team/documents/requirements.md')
  let invocationCount = 0
  const firstService = new MobileSprintEngineCommandService({
    workspaceRoot: fixture.workspaceRoot,
    statePaths: [fixture.statePath],
    now: () => now,
    execute: async () => {
      invocationCount += 1
      return { exitCode: 0, stdout: '{"ok":true,"action":"approved"}', stderr: '' }
    },
  })
  const mobileCommand = command('artifact.approve', {
    sprintEngineId: 'replay-recreate-team',
    artifactId: 'A1',
  }, {
    idempotencyKey: 'mobile:device_1:replay-recreate',
  })

  const first = await firstService.dispatch(mobileCommand)
  const recreatedService = new MobileSprintEngineCommandService({
    workspaceRoot: fixture.workspaceRoot,
    statePaths: [fixture.statePath],
    now: () => now,
    execute: async () => {
      invocationCount += 1
      return { exitCode: 0, stdout: '{"ok":true,"action":"approved-again"}', stderr: '' }
    },
  })
  const second = await recreatedService.dispatch({ ...mobileCommand, commandId: 'cmd_replay_recreate' })

  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.equal(invocationCount, 1)
  assert.deepEqual(second.ok && first.ok ? second.data : null, first.ok ? first.data : null)
}

async function assertToolSuccessResponseLossRetryDoesNotReinvokeTool(): Promise<void> {
  const fixture = await writeSprintEngineFixture('response-loss-team', '.multi-code/sprintengine/response-loss-team/documents/requirements.md')
  let invocationCount = 0
  const service = new MobileSprintEngineCommandService({
    workspaceRoot: fixture.workspaceRoot,
    statePaths: [fixture.statePath],
    now: () => now,
    execute: async () => {
      invocationCount += 1
      return { exitCode: 0, stdout: '{"ok":true,"action":"changes_requested"}', stderr: '' }
    },
  })
  const mobileCommand = command('artifact.requestChanges', {
    sprintEngineId: 'response-loss-team',
    artifactId: 'A1',
    feedback: 'Clarify the launch criteria.',
  }, {
    idempotencyKey: 'mobile:device_1:response-loss',
  })

  await service.dispatch(mobileCommand)
  const retry = await service.dispatch({ ...mobileCommand, commandId: 'cmd_response_loss_retry' })

  assert.equal(retry.ok, true)
  assert.equal(invocationCount, 1)
  assert.equal(retry.ok ? (retry.data as { action: string }).action : '', 'changes_requested')
}

async function assertInvalidArtifactPathIsRejected(): Promise<void> {
  const fixture = await writeSprintEngineFixture('invalid-artifact-team', '../outside.md')
  let invocationCount = 0
  const service = new MobileSprintEngineCommandService({
    workspaceRoot: fixture.workspaceRoot,
    statePaths: [fixture.statePath],
    now: () => now,
    execute: async () => {
      invocationCount += 1
      return { exitCode: 0, stdout: '{"ok":true}', stderr: '' }
    },
  })

  const result = await service.dispatch(command('artifact.approve', {
    sprintEngineId: 'invalid-artifact-team',
    artifactId: 'A1',
  }))

  assert.equal(result.ok, false)
  assert.equal(result.ok === false ? result.error.code : '', 'path_not_allowed')
  assert.equal(invocationCount, 0)
}

async function assertSprintEngineCreateUsesControlledHandover(): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-mobile-command-create-'))
  const invocations: Array<{ args: string[]; cwd: string }> = []
  const service = new MobileSprintEngineCommandService({
    workspaceRoot,
    now: () => now,
    execute: async (invocation) => {
      invocations.push(invocation)
      return { exitCode: 0, stdout: '{"ok":true,"action":"handover","team":"mobile-cmd-create"}', stderr: '' }
    },
  })

  const result = await service.dispatch(command('sprintengine.create', {
    workspacePath: workspaceRoot,
    productPrompt: 'Build a focused mobile companion sprintengine.',
  }, {
    commandId: 'cmd_create',
    idempotencyKey: 'mobile:device_1:create',
  }))

  assert.equal(result.ok, true)
  assert.equal(invocations.length, 1)
  assert.equal(invocations[0].cwd, workspaceRoot)
  assert.deepEqual(invocations[0].args.slice(0, 4), ['handover', '--name', 'mobile-cmd_create', '--goal'])
  assert.equal(invocations[0].args.includes('--handover-text'), true)
  assert.equal(invocations[0].args.includes('--actor'), true)
}

async function assertSprintEngineCreateHonorsSprintConfig(): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-mobile-command-create-config-'))
  const statePath = join(workspaceRoot, '.multi-code', 'sprintengine', 'checkout-flow', 'run.yaml')
  const invocations: Array<{ args: string[]; cwd: string }> = []
  const service = new MobileSprintEngineCommandService({
    workspaceRoot,
    now: () => now,
    execute: async (invocation) => {
      invocations.push(invocation)
      // `handover` hands back the run.yaml it bootstrapped so the follow-up
      // `init` can apply the configured roles; `init` just acknowledges.
      const stdout = invocation.args[0] === 'handover'
        ? JSON.stringify({ ok: true, action: 'handover', team: 'checkout-flow', statePath })
        : '{"ok":true,"action":"init"}'
      return { exitCode: 0, stdout, stderr: '' }
    },
  })

  const result = await service.dispatch(command('sprintengine.create', {
    workspacePath: workspaceRoot,
    productPrompt: 'Ship the checkout flow.',
    config: {
      teamName: 'Checkout Flow',
      roleCounts: { developer: 2, tester: 1 },
    },
  }, {
    commandId: 'cmd_create_config',
    idempotencyKey: 'mobile:device_1:create-config',
  }))

  assert.equal(result.ok, true)
  // handover bootstraps the store; init persists the roster as configuredRoles.
  assert.equal(invocations.length, 2)
  const handoverArgs = invocations[0].args
  // The requested name is slugified the same way the engine will slugify it.
  assert.deepEqual(handoverArgs.slice(0, 3), ['handover', '--name', 'checkout-flow'])
  // Leases mint no seats: handover carries no `--agent role:role-N` seat specs.
  assert.equal(handoverArgs.includes('--agent'), false)

  // The roster maps to configuredRoles (distinct roles; seat counts dropped) plus
  // one rosterConfigured marker — never per-seat agents.
  const initArgs = invocations[1].args
  assert.deepEqual(initArgs.slice(0, 3), ['--state', statePath, 'init'])
  const configuredRolesJson = initArgs[initArgs.indexOf('--configured-roles-json') + 1]
  assert.deepEqual(JSON.parse(configuredRolesJson), ['developer', 'tester'])
  const agentSpecs: string[] = []
  for (let index = 0; index < initArgs.length; index += 1) {
    if (initArgs[index] === '--agent') agentSpecs.push(initArgs[index + 1])
  }
  assert.deepEqual(agentSpecs, ['developer:developer'])

  // Out-of-bounds config is rejected before any tool invocation.
  const rejected = await service.dispatch(command('sprintengine.create', {
    workspacePath: workspaceRoot,
    productPrompt: 'Ship the checkout flow.',
    config: { roleCounts: { developer: 0 } },
  }, {
    commandId: 'cmd_create_config_bad',
    idempotencyKey: 'mobile:device_1:create-config-bad',
  }))
  assert.equal(rejected.ok, false)
  assert.equal(rejected.ok === false ? rejected.error.code : '', 'invalid_payload')
  assert.equal(invocations.length, 2)

  // A create with no roster config stays a single handover call (the architect
  // then picks the team).
  const bareInvocations: Array<{ args: string[]; cwd: string }> = []
  const bareService = new MobileSprintEngineCommandService({
    workspaceRoot,
    now: () => now,
    execute: async (invocation) => {
      bareInvocations.push(invocation)
      return { exitCode: 0, stdout: JSON.stringify({ ok: true, action: 'handover', team: 'plain', statePath }), stderr: '' }
    },
  })
  const bare = await bareService.dispatch(command('sprintengine.create', {
    workspacePath: workspaceRoot,
    productPrompt: 'Ship it.',
  }, {
    commandId: 'cmd_create_plain',
    idempotencyKey: 'mobile:device_1:create-plain',
  }))
  assert.equal(bare.ok, true)
  assert.equal(bareInvocations.length, 1)
  assert.equal(bareInvocations[0].args[0], 'handover')
}

async function assertTaskStartUsesDesktopSessionOrchestration(): Promise<void> {
  const fixture = await writeSprintEngineFixture('task-start-team', '.multi-code/sprintengine/task-start-team/documents/requirements.md', {
    tasks: [
      task('T1', 'architect', 'done'),
      task('T2', 'developer', 'todo', { dependsOn: ['T1'] }),
    ],
  })
  const starts: Parameters<MobileSprintEngineSessionOrchestrator['startTask']>[0][] = []
  const service = new MobileSprintEngineCommandService({
    workspaceRoot: fixture.workspaceRoot,
    statePaths: [fixture.statePath],
    now: () => now,
    execute: async () => {
      throw new Error('Sprint Engine tool should not run for task starts')
    },
    sessionOrchestrator: {
      startTask: async (request) => {
        starts.push(request)
        return {
          sessionId: 'session_1',
          agentId: 'developer-1',
          executionMode: 'current_workspace',
        }
      },
      sendFollowUp: async () => {
        throw new Error('follow-up should not run for task starts')
      },
    },
  })

  const result = await service.dispatch(command('task.start', {
    sprintEngineId: 'task-start-team',
    taskId: 'T2',
    role: 'developer',
    worktreeIsolation: 'preferred',
  }, {
    idempotencyKey: 'mobile:device_1:task-start',
  }))

  assert.equal(result.ok, true)
  assert.equal(starts.length, 1)
  assert.equal(starts[0].statePath, fixture.statePath)
  assert.equal(starts[0].taskId, 'T2')
  assert.equal(starts[0].role, 'developer')
  assert.equal(result.ok === true ? (result.data as { sessionId: string }).sessionId : '', 'session_1')
  assert.equal(service.getAuditLog()[0].status, 'accepted')
}

async function assertTaskStartUsesAuthorizedDiscoveredStateOutsideServiceCwd(): Promise<void> {
  const fixture = await writeSprintEngineFixture('discovered-task-start-team', '.multi-code/sprintengine/discovered-task-start-team/documents/requirements.md', {
    tasks: [
      task('T1', 'architect', 'done'),
      task('T2', 'developer', 'todo', { dependsOn: ['T1'] }),
    ],
  })
  const serviceWorkspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-mobile-command-cwd-'))
  const starts: Parameters<MobileSprintEngineSessionOrchestrator['startTask']>[0][] = []
  const service = new MobileSprintEngineCommandService({
    workspaceRoot: serviceWorkspaceRoot,
    now: () => now,
    sessionOrchestrator: {
      startTask: async (request) => {
        starts.push(request)
        return { sessionId: 'session_discovered', agentId: 'developer-1', executionMode: 'current_workspace' }
      },
      sendFollowUp: async () => {
        throw new Error('follow-up should not run for task starts')
      },
    },
  })

  const result = await service.dispatch(command('task.start', {
    sprintEngineId: 'discovered-task-start-team',
    taskId: 'T2',
    role: 'developer',
    worktreeIsolation: 'preferred',
  }, {
    commandId: 'cmd_discovered_task_start',
    idempotencyKey: 'mobile:device_1:discovered-task-start',
  }), {
    statePaths: [fixture.statePath],
    allowedWorkspaceRoots: [fixture.workspaceRoot],
  })

  assert.equal(result.ok, true)
  assert.equal(starts.length, 1)
  assert.equal(starts[0].statePath, fixture.statePath)
  assert.equal(starts[0].workspaceRoot, fixture.workspaceRoot)
}

async function assertTaskStartRejectsBlockedDependencies(): Promise<void> {
  const fixture = await writeSprintEngineFixture('task-blocked-team', '.multi-code/sprintengine/task-blocked-team/documents/requirements.md', {
    tasks: [
      task('T1', 'architect', 'todo'),
      task('T2', 'developer', 'todo', { dependsOn: ['T1'] }),
    ],
  })
  let startCount = 0
  const service = new MobileSprintEngineCommandService({
    workspaceRoot: fixture.workspaceRoot,
    statePaths: [fixture.statePath],
    now: () => now,
    sessionOrchestrator: {
      startTask: async () => {
        startCount += 1
        return { sessionId: 'session_1', agentId: 'developer-1', executionMode: 'current_workspace' }
      },
      sendFollowUp: async () => {
        throw new Error('follow-up should not run for blocked task starts')
      },
    },
  })

  const result = await service.dispatch(command('task.start', {
    sprintEngineId: 'task-blocked-team',
    taskId: 'T2',
    role: 'developer',
    worktreeIsolation: 'preferred',
  }, {
    idempotencyKey: 'mobile:device_1:task-blocked',
  }))

  assert.equal(result.ok, false)
  assert.equal(result.ok === false ? result.error.code : '', 'task_not_ready')
  assert.equal(startCount, 0)
}

async function assertTaskStartConsultsProjectionWhenRunYamlGraphMirrorIsStale(): Promise<void> {
  // The run.yaml graph mirror can lag behind projection.json. The mobile
  // command service must read readiness from projection.json so it observes the
  // up-to-date board, not a stale graph mirror.
  const fixture = await writeSprintEngineFixture(
    'task-projection-team',
    '.multi-code/sprintengine/task-projection-team/documents/requirements.md',
    {
      // run.yaml says T2 is still blocked by an unfinished T1.
      tasks: [
        task('T1', 'architect', 'todo'),
        task('T2', 'developer', 'todo', { dependsOn: ['T1'] }),
      ],
    },
  )

  // Folder-store projection.json says T1 is done and T2 is ready (its
  // status mirrors the board column while stateStatus carries the semantic
  // value the readiness check needs).
  await writeFile(join(dirname(fixture.statePath), 'projection.json'), JSON.stringify({
    tasks: [
      { id: 'T1', role: 'architect', status: 'done', stateStatus: 'done', dependsOn: [], ownerAgentId: null },
      { id: 'T2', role: 'developer', status: 'ready', stateStatus: 'todo', dependsOn: ['T1'], ownerAgentId: null },
    ],
    artifacts: [],
    workers: {},
  }), 'utf8')

  const starts: Parameters<MobileSprintEngineSessionOrchestrator['startTask']>[0][] = []
  const service = new MobileSprintEngineCommandService({
    workspaceRoot: fixture.workspaceRoot,
    statePaths: [fixture.statePath],
    now: () => now,
    execute: async () => {
      throw new Error('Sprint Engine tool should not run for task starts')
    },
    sessionOrchestrator: {
      startTask: async (request) => {
        starts.push(request)
        return { sessionId: 'session_projection', agentId: 'developer-1', executionMode: 'current_workspace' }
      },
      sendFollowUp: async () => {
        throw new Error('follow-up should not run for task starts')
      },
    },
  })

  const result = await service.dispatch(command('task.start', {
    sprintEngineId: 'task-projection-team',
    taskId: 'T2',
    role: 'developer',
    worktreeIsolation: 'preferred',
  }, {
    idempotencyKey: 'mobile:device_1:task-projection',
  }))

  assert.equal(result.ok, true, result.ok === false ? result.error.message : undefined)
  assert.equal(starts.length, 1)
  assert.equal(starts[0].taskId, 'T2')
}

async function assertFollowUpUsesKnownAgentSessionOrchestration(): Promise<void> {
  const fixture = await writeSprintEngineFixture('follow-up-team', '.multi-code/sprintengine/follow-up-team/documents/requirements.md', {
    tasks: [
      task('T1', 'developer', 'in_progress', { ownerAgentId: 'developer-1' }),
    ],
    sprintEngineAgents: {
      'developer-1': { role: 'developer', status: 'running', currentTaskId: 'T1' },
    },
  })
  const followUps: Parameters<MobileSprintEngineSessionOrchestrator['sendFollowUp']>[0][] = []
  const service = new MobileSprintEngineCommandService({
    workspaceRoot: fixture.workspaceRoot,
    statePaths: [fixture.statePath],
    now: () => now,
    sessionOrchestrator: {
      startTask: async () => {
        throw new Error('task start should not run for follow-up')
      },
      sendFollowUp: async (request) => {
        followUps.push(request)
        return { sessionId: 'session_2', agentId: request.agentId, acceptedAt: now.toISOString() }
      },
    },
  })

  const result = await service.dispatch(command('agent.followUp', {
    sprintEngineId: 'follow-up-team',
    agentId: 'developer-1',
    text: 'Please include the failing command output in your evidence.',
  }, {
    idempotencyKey: 'mobile:device_1:follow-up',
  }))

  assert.equal(result.ok, true)
  assert.equal(followUps.length, 1)
  assert.equal(followUps[0].agentId, 'developer-1')
  assert.equal(followUps[0].text, 'Please include the failing command output in your evidence.')
}

async function assertFollowUpUsesAuthorizedDiscoveredStateOutsideServiceCwd(): Promise<void> {
  const fixture = await writeSprintEngineFixture('discovered-follow-up-team', '.multi-code/sprintengine/discovered-follow-up-team/documents/requirements.md', {
    tasks: [
      task('T1', 'developer', 'in_progress', { ownerAgentId: 'developer-1' }),
    ],
    sprintEngineAgents: {
      'developer-1': { role: 'developer', status: 'running', currentTaskId: 'T1' },
    },
  })
  const serviceWorkspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-mobile-command-cwd-'))
  const followUps: Parameters<MobileSprintEngineSessionOrchestrator['sendFollowUp']>[0][] = []
  const service = new MobileSprintEngineCommandService({
    workspaceRoot: serviceWorkspaceRoot,
    now: () => now,
    sessionOrchestrator: {
      startTask: async () => {
        throw new Error('task start should not run for follow-up')
      },
      sendFollowUp: async (request) => {
        followUps.push(request)
        return { sessionId: 'session_discovered_follow_up', agentId: request.agentId, acceptedAt: now.toISOString() }
      },
    },
  })

  const result = await service.dispatch(command('agent.followUp', {
    sprintEngineId: 'discovered-follow-up-team',
    agentId: 'developer-1',
    text: 'Continue with the latest approved plan.',
  }, {
    commandId: 'cmd_discovered_follow_up',
    idempotencyKey: 'mobile:device_1:discovered-follow-up',
  }), {
    statePaths: [fixture.statePath],
    allowedWorkspaceRoots: [fixture.workspaceRoot],
  })

  assert.equal(result.ok, true)
  assert.equal(followUps.length, 1)
  assert.equal(followUps[0].statePath, fixture.statePath)
  assert.equal(followUps[0].workspaceRoot, fixture.workspaceRoot)
}

async function assertFollowUpRejectsTerminalControlCharacters(): Promise<void> {
  const fixture = await writeSprintEngineFixture('follow-up-control-team', '.multi-code/sprintengine/follow-up-control-team/documents/requirements.md', {
    tasks: [
      task('T1', 'developer', 'in_progress', { ownerAgentId: 'developer-1' }),
    ],
    sprintEngineAgents: {
      'developer-1': { role: 'developer', status: 'running', currentTaskId: 'T1' },
    },
  })
  let followUpCount = 0
  const service = new MobileSprintEngineCommandService({
    workspaceRoot: fixture.workspaceRoot,
    statePaths: [fixture.statePath],
    now: () => now,
    sessionOrchestrator: {
      startTask: async () => {
        throw new Error('task start should not run for control character rejection')
      },
      sendFollowUp: async () => {
        followUpCount += 1
        return { sessionId: 'session_2', agentId: 'developer-1', acceptedAt: now.toISOString() }
      },
    },
  })

  for (const [text, suffix] of [
    ['hello\nthere', 'newline'],
    ['hello\rthere', 'carriage-return'],
    ['hello\u001B[2J', 'escape'],
  ] as const) {
    const result = await service.dispatch(command('agent.followUp', {
      sprintEngineId: 'follow-up-control-team',
      agentId: 'developer-1',
      text,
    }, {
      commandId: `cmd_follow_up_${suffix}`,
      idempotencyKey: `mobile:device_1:follow-up-control-${suffix}`,
    }))

    assert.equal(result.ok, false)
    assert.equal(result.ok === false ? result.error.code : '', 'invalid_payload')
  }
  assert.equal(followUpCount, 0)
}

async function assertUnsupportedCommandIsRejected(): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-mobile-command-unsupported-'))
  const service = new MobileSprintEngineCommandService({
    workspaceRoot,
    now: () => now,
    execute: async () => {
      throw new Error('tool should not run for unsupported commands')
    },
  })

  const result = await service.dispatch(command('task.start', {
    sprintEngineId: 'team',
    taskId: 'T1',
    role: 'developer',
    worktreeIsolation: 'preferred',
  }))

  assert.equal(result.ok, false)
  assert.equal(result.ok === false ? result.error.code : '', 'command_not_supported')
}

async function assertBacklogUpdateWritesFrontmatter(): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-mobile-backlog-update-'))
  await mkdir(join(workspaceRoot, 'backlog'), { recursive: true })
  const body = '# A rough idea\n\nDo the thing.\n'
  await writeFile(join(workspaceRoot, 'backlog', 'idea.md'), body, 'utf8')
  const service = new MobileSprintEngineCommandService({
    workspaceRoot,
    now: () => now,
    execute: async () => {
      throw new Error('Sprint Engine tool should not run for backlog updates')
    },
  })

  const result = await service.dispatch(command('backlog.update', {
    workspacePath: workspaceRoot,
    relativePath: 'backlog/idea.md',
    status: 'ready',
    difficulty: 'm',
    criticality: 'high',
  }, {
    commandId: 'cmd_backlog_update',
    idempotencyKey: 'mobile:device_1:backlog-update',
  }))

  assert.equal(result.ok, true)
  // Lifecycle/triage now live in the item's markdown frontmatter (v2), not the
  // sidecar; the body is preserved byte-for-byte and items.json is never created.
  const updated = parseBacklogFrontmatter(await readFile(join(workspaceRoot, 'backlog', 'idea.md'), 'utf8'))
  assert.equal(updated.fields.status, 'ready')
  assert.equal(updated.fields.difficulty, 'm')
  assert.equal(updated.fields.criticality, 'high')
  assert.equal(updated.body, body, 'backlog.update must preserve the document body')
  await assert.rejects(
    () => readFile(join(workspaceRoot, '.multi-code', 'backlog', 'items.json'), 'utf8'),
    /ENOENT/,
    'backlog.update must not write the sidecar for lifecycle/triage',
  )

  const invalid = await service.dispatch(command('backlog.update', {
    workspacePath: workspaceRoot,
    relativePath: 'backlog/idea.md',
    // @ts-expect-error deliberately invalid status to exercise the dispatcher's runtime invalid_payload rejection
    status: 'not-a-status',
  }, {
    commandId: 'cmd_backlog_update_invalid',
    idempotencyKey: 'mobile:device_1:backlog-update-invalid',
  }))
  assert.equal(invalid.ok, false)
  assert.equal(invalid.ok === false ? invalid.error.code : '', 'invalid_payload')
}

type BacklogStoreItem = {
  source: { relativePath: string }
  status?: string
  metadata?: Record<string, unknown>
  links?: Array<{ id: string; type: string; label: string; target: { kind: string; id: string; path?: string; url?: string } }>
}

async function readBacklogStoreItems(workspaceRoot: string): Promise<BacklogStoreItem[]> {
  const store = JSON.parse(
    await readFile(join(workspaceRoot, '.multi-code', 'backlog', 'items.json'), 'utf8')
  ) as { items: BacklogStoreItem[] }
  return store.items
}

function argValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}

async function assertBacklogStartSprintEngineUsesHandoverAndMarksItem(): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-mobile-backlog-start-'))
  await mkdir(join(workspaceRoot, 'backlog'), { recursive: true })
  // Git-backed, so worktree mode is possible and therefore the default.
  await mkdir(join(workspaceRoot, '.git'), { recursive: true })
  await writeFile(
    join(workspaceRoot, 'backlog', 'feature.md'),
    '---\ntype: feature\n---\n\n# Ship the widget\n\nUsers need the widget.\n',
    'utf8'
  )
  const statePath = join(workspaceRoot, '.multi-code', 'sprintengine', 'backlog-cmd_backlog_start', 'run.yaml')
  const invocations: Array<{ args: string[]; cwd: string }> = []
  const service = new MobileSprintEngineCommandService({
    workspaceRoot,
    now: () => now,
    execute: async (invocation) => {
      invocations.push(invocation)
      return { exitCode: 0, stdout: JSON.stringify({ ok: true, action: 'handover', statePath }), stderr: '' }
    },
  })

  const result = await service.dispatch(command('backlog.startSprintEngine', {
    workspacePath: workspaceRoot,
    relativePath: 'backlog/feature.md',
  }, {
    commandId: 'cmd_backlog_start',
    idempotencyKey: 'mobile:device_1:backlog-start',
  }))

  assert.equal(result.ok, true)
  // Two steps: `handover` bootstraps the run store, `init` establishes worktree
  // mode. `handover` accepts --use-worktrees but its handler ignores it — only
  // `init` calls ensure_run_worktree — so a one-step start could never branch,
  // and so could never open a pull request.
  assert.equal(invocations.length, 2)
  assert.equal(invocations[0].cwd, workspaceRoot)
  const args = invocations[0].args
  assert.deepEqual(args.slice(0, 3), ['handover', '--name', 'backlog-cmd_backlog_start'])
  assert.equal(argValue(args, '--goal'), 'Ship the widget')

  // The item is referenced in place, never inlined: only a source path under
  // backlog/ makes the run backlog-sourced, which is what grants the agent the
  // lifecycle skill that keeps this item's status truthful.
  assert.equal(argValue(args, '--handover'), join(workspaceRoot, 'backlog', 'feature.md'))
  assert.equal(args.includes('--reference-sources'), true)
  assert.equal(args.includes('--handover-text'), false)

  assert.deepEqual(invocations[1].args, ['--state', statePath, 'init', '--use-worktrees', 'true'])

  // A leaf item is not an epic launch.
  assert.equal(args.includes('--source-plan-kind'), false)
  assert.equal(args.includes('--source'), false)

  // Status moves to the item's frontmatter (v2), while module metadata stays
  // app-owned churn in the sidecar.
  const marked = parseBacklogFrontmatter(await readFile(join(workspaceRoot, 'backlog', 'feature.md'), 'utf8'))
  assert.equal(marked.fields.status, 'in_progress')
  const items = await readBacklogStoreItems(workspaceRoot)
  const record = items.find((item) => item.source.relativePath === 'backlog/feature.md')
  const moduleMetadata = record?.metadata?.['mobile-companion'] as Record<string, unknown> | undefined
  assert.equal(moduleMetadata?.['teamName'], 'backlog-cmd_backlog_start')

  // The execution link is the only backlog -> run correspondence there is; the PR
  // write later finds this item by scanning for it.
  const runLink = record?.links?.find((link) => link.type === 'execution')
  assert.equal(runLink?.target.kind, 'sprintengine.run')
  assert.equal(runLink?.target.id, 'backlog-cmd_backlog_start')
  assert.equal(runLink?.target.path, '.multi-code/sprintengine/backlog-cmd_backlog_start/run.yaml')
}

async function assertBacklogStartLaunchesAnEpicWithItsChildren(): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-mobile-backlog-epic-'))
  await mkdir(join(workspaceRoot, 'backlog'), { recursive: true })
  // The epic container points at its own slug, exactly as its children do.
  await writeFile(
    join(workspaceRoot, 'backlog', 'goal-runs.md'),
    '---\ntype: epic\nepic: goal-runs\n---\n\n# Work it with an agent\n\nThe whole epic.\n',
    'utf8'
  )
  await writeFile(
    join(workspaceRoot, 'backlog', 'child-a.md'),
    '---\ntype: feature\nstatus: ready\nepic: goal-runs\n---\n\n# Child A\n\nFirst.\n',
    'utf8'
  )
  await writeFile(
    join(workspaceRoot, 'backlog', 'child-done.md'),
    '---\ntype: feature\nstatus: completed\nepic: goal-runs\n---\n\n# Child Done\n\nAlready finished.\n',
    'utf8'
  )
  await writeFile(
    join(workspaceRoot, 'backlog', 'unrelated.md'),
    '---\ntype: feature\nstatus: ready\n---\n\n# Unrelated\n\nOther work.\n',
    'utf8'
  )

  const statePath = join(workspaceRoot, '.multi-code', 'sprintengine', 'backlog-cmd_epic', 'run.yaml')
  const invocations: Array<{ args: string[]; cwd: string }> = []
  const service = new MobileSprintEngineCommandService({
    workspaceRoot,
    now: () => now,
    execute: async (invocation) => {
      invocations.push(invocation)
      return { exitCode: 0, stdout: JSON.stringify({ ok: true, action: 'handover', statePath }), stderr: '' }
    },
  })

  const result = await service.dispatch(command('backlog.startSprintEngine', {
    workspacePath: workspaceRoot,
    relativePath: 'backlog/goal-runs.md',
  }, {
    commandId: 'cmd_epic',
    idempotencyKey: 'mobile:device_1:backlog-epic',
  }))

  assert.equal(result.ok, true)
  const args = invocations[0].args
  // The epic is the root source; its children ride as the source bundle.
  assert.equal(argValue(args, '--handover'), join(workspaceRoot, 'backlog', 'goal-runs.md'))
  assert.equal(argValue(args, '--source-plan-kind'), 'epic')

  const sources = args.filter((_arg, index) => args[index - 1] === '--source').sort()
  assert.deepEqual(sources, [
    `generic_context:${join(workspaceRoot, 'backlog', 'child-a.md')}`,
    `generic_context:${join(workspaceRoot, 'backlog', 'child-done.md')}`,
  ])
  // The epic container is never a child of itself.
  assert.equal(sources.some((source) => source.includes('goal-runs.md')), false)
  assert.equal(sources.some((source) => source.includes('unrelated.md')), false)

  // MC-2017: launching links every child to the run and moves NONE of them. A
  // child goes `in_progress` when its own task claims, which is the projection
  // tick's job — the launch only records where each child started, so an
  // abandoned sprint can put it back.
  const childA = parseBacklogFrontmatter(await readFile(join(workspaceRoot, 'backlog', 'child-a.md'), 'utf8'))
  assert.equal(childA.fields.status, 'ready', 'a child does not move just because the epic launched')
  const childDone = parseBacklogFrontmatter(await readFile(join(workspaceRoot, 'backlog', 'child-done.md'), 'utf8'))
  assert.equal(childDone.fields.status, 'completed', 'a finished child is never dragged backwards')
  const unrelated = parseBacklogFrontmatter(await readFile(join(workspaceRoot, 'backlog', 'unrelated.md'), 'utf8'))
  assert.equal(unrelated.fields.status, 'ready')
  // The epic container derives its status from its children and is never written one.
  const epic = parseBacklogFrontmatter(await readFile(join(workspaceRoot, 'backlog', 'goal-runs.md'), 'utf8'))
  assert.equal(epic.fields.status, undefined, 'an epic file never gains a status line')

  const store = await readBacklogObjectStore(workspaceRoot)
  assert.equal(store.ok, true)
  const childLinks = (store.ok ? store.store.items : [])
    .filter((item) => item.source.relativePath.startsWith('backlog/child'))
    .map((item) => [item.source.relativePath, item.links?.[0]?.status, item.links?.[0]?.priorStatus])
    .sort()
  assert.deepEqual(
    childLinks,
    [
      ['backlog/child-a.md', 'pending', 'ready'],
      ['backlog/child-done.md', 'pending', 'completed'],
    ],
    'each child carries a pending run link remembering the status it held before the sprint',
  )
}

async function assertBacklogStartHonoursExplicitWorktreeOptOut(): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-mobile-backlog-noworktree-'))
  await mkdir(join(workspaceRoot, 'backlog'), { recursive: true })
  await mkdir(join(workspaceRoot, '.git'), { recursive: true })
  await writeFile(join(workspaceRoot, 'backlog', 'feature.md'), '---\ntype: feature\n---\n\n# Thing\n\nBody.\n', 'utf8')
  const statePath = join(workspaceRoot, '.multi-code', 'sprintengine', 'backlog-cmd_no_worktree', 'run.yaml')
  const invocations: Array<{ args: string[]; cwd: string }> = []
  const service = new MobileSprintEngineCommandService({
    workspaceRoot,
    now: () => now,
    execute: async (invocation) => {
      invocations.push(invocation)
      return { exitCode: 0, stdout: JSON.stringify({ ok: true, action: 'handover', statePath }), stderr: '' }
    },
  })

  const result = await service.dispatch(command('backlog.startSprintEngine', {
    workspacePath: workspaceRoot,
    relativePath: 'backlog/feature.md',
    useWorktrees: false,
  }, {
    commandId: 'cmd_no_worktree',
    idempotencyKey: 'mobile:device_1:backlog-no-worktree',
  }))

  assert.equal(result.ok, true)
  // Explicit opt-out beats the git-backed default.
  assert.equal(argValue(invocations[1].args, '--use-worktrees'), 'false')
}

async function assertBacklogStartLinksTheRunThroughASymlinkedWorkspaceRoot(): Promise<void> {
  // The engine resolves symlinks on its way out (`state_path.resolve()`), while
  // the workspace root arrives from the payload merely normalized. On macOS that
  // alone splits them (/var -> /private/var). If the containment test is done on
  // the raw strings it fails, no execution link is written, and the item silently
  // loses its status, its run reference and — later — its pull request.
  const realRoot = await mkdtemp(join(tmpdir(), 'multicode-mobile-backlog-real-'))
  await mkdir(join(realRoot, 'backlog'), { recursive: true })
  await mkdir(join(realRoot, '.git'), { recursive: true })
  await writeFile(join(realRoot, 'backlog', 'feature.md'), '---\ntype: feature\n---\n\n# Thing\n\nBody.\n', 'utf8')

  // A symlinked alias for the same workspace; the phone starts through the alias.
  const linkRoot = join(await mkdtemp(join(tmpdir(), 'multicode-mobile-backlog-link-')), 'workspace')
  await symlink(realRoot, linkRoot, 'dir')

  // The tool answers with the RESOLVED state path, as the real engine does.
  const resolvedStatePath = join(await realpath(realRoot), '.multi-code', 'sprintengine', 'backlog-cmd_symlink', 'run.yaml')
  const service = new MobileSprintEngineCommandService({
    workspaceRoot: linkRoot,
    now: () => now,
    execute: async () => ({
      exitCode: 0,
      stdout: JSON.stringify({ ok: true, action: 'handover', statePath: resolvedStatePath }),
      stderr: '',
    }),
  })

  const result = await service.dispatch(command('backlog.startSprintEngine', {
    workspacePath: linkRoot,
    relativePath: 'backlog/feature.md',
  }, {
    commandId: 'cmd_symlink',
    idempotencyKey: 'mobile:device_1:backlog-symlink',
  }))

  assert.equal(result.ok, true)
  const items = await readBacklogStoreItems(linkRoot)
  const record = items.find((item) => item.source.relativePath === 'backlog/feature.md')
  const runLink = record?.links?.find((link) => link.type === 'execution')
  assert.equal(runLink?.target.path, '.multi-code/sprintengine/backlog-cmd_symlink/run.yaml')
  assert.equal(runLink?.target.id, 'backlog-cmd_symlink')
  const frontmatter = parseBacklogFrontmatter(await readFile(join(realRoot, 'backlog', 'feature.md'), 'utf8'))
  assert.equal(frontmatter.fields.status, 'in_progress')
}

async function assertBacklogStartRollsBackTheRunStoreWhenInitFails(): Promise<void> {
  // `handover` refuses to write over existing bootstrap files without --force, so
  // a half-built team left on disk would wedge every retry that reuses its name.
  // The failed start must leave nothing behind.
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-mobile-backlog-initfail-'))
  await mkdir(join(workspaceRoot, 'backlog'), { recursive: true })
  await mkdir(join(workspaceRoot, '.git'), { recursive: true })
  await writeFile(join(workspaceRoot, 'backlog', 'feature.md'), '---\ntype: feature\n---\n\n# Thing\n\nBody.\n', 'utf8')

  const teamDirectory = join(workspaceRoot, '.multi-code', 'sprintengine', 'backlog-cmd_initfail')
  const statePath = join(teamDirectory, 'run.yaml')

  const service = new MobileSprintEngineCommandService({
    workspaceRoot,
    now: () => now,
    execute: async (invocation) => {
      if (invocation.args[0] === 'handover') {
        // Bootstrap the run store on disk, exactly as the engine would.
        await mkdir(teamDirectory, { recursive: true })
        await writeFile(statePath, 'sprintengine: {}\n', 'utf8')
        return { exitCode: 0, stdout: JSON.stringify({ ok: true, action: 'handover', statePath }), stderr: '' }
      }
      return {
        exitCode: 1,
        stdout: JSON.stringify({ ok: false, error: 'fatal: not a valid object name: main' }),
        stderr: '',
      }
    },
  })

  const result = await service.dispatch(command('backlog.startSprintEngine', {
    workspacePath: workspaceRoot,
    relativePath: 'backlog/feature.md',
  }, {
    commandId: 'cmd_initfail',
    idempotencyKey: 'mobile:device_1:backlog-initfail',
  }))

  // The engine's real reason reaches the phone, not a false success.
  assert.equal(result.ok, false)
  assert.equal(result.ok === false ? result.error.code : '', 'python_tool_failed')

  // And the orphan is gone, so a retry is clean.
  await assert.rejects(access(teamDirectory), 'the half-built run store must be rolled back')

  // The item was never told about a run that does not exist.
  const frontmatter = parseBacklogFrontmatter(await readFile(join(workspaceRoot, 'backlog', 'feature.md'), 'utf8'))
  assert.notEqual(frontmatter.fields.status, 'in_progress')
}

async function assertBacklogStartSkipsWorktreesInANonGitWorkspace(): Promise<void> {
  // A run worktree branches from the workspace root, so worktree mode is simply
  // not possible without a repository there. Defaulting it on would turn a start
  // that used to work into a hard failure for those workspaces.
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-mobile-backlog-nogit-'))
  await mkdir(join(workspaceRoot, 'backlog'), { recursive: true })
  await writeFile(join(workspaceRoot, 'backlog', 'feature.md'), '---\ntype: feature\n---\n\n# Thing\n\nBody.\n', 'utf8')
  const statePath = join(workspaceRoot, '.multi-code', 'sprintengine', 'backlog-cmd_nogit', 'run.yaml')
  const invocations: Array<{ args: string[]; cwd: string }> = []
  const service = new MobileSprintEngineCommandService({
    workspaceRoot,
    now: () => now,
    execute: async (invocation) => {
      invocations.push(invocation)
      return { exitCode: 0, stdout: JSON.stringify({ ok: true, action: 'handover', statePath }), stderr: '' }
    },
  })

  const result = await service.dispatch(command('backlog.startSprintEngine', {
    workspacePath: workspaceRoot,
    relativePath: 'backlog/feature.md',
  }, {
    commandId: 'cmd_nogit',
    idempotencyKey: 'mobile:device_1:backlog-nogit',
  }))

  assert.equal(result.ok, true)
  assert.equal(argValue(invocations[1].args, '--use-worktrees'), 'false')
}

async function assertBacklogStartRejectsPathOutsideBacklogFolder(): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-mobile-backlog-escape-'))
  const service = new MobileSprintEngineCommandService({
    workspaceRoot,
    now: () => now,
    execute: async () => {
      throw new Error('Sprint Engine tool should not run for rejected backlog paths')
    },
  })

  const result = await service.dispatch(command('backlog.startSprintEngine', {
    workspacePath: workspaceRoot,
    relativePath: 'backlog/../run.yaml',
  }, {
    commandId: 'cmd_backlog_escape',
    idempotencyKey: 'mobile:device_1:backlog-escape',
  }))

  assert.equal(result.ok, false)
  assert.equal(result.ok === false ? result.error.code : '', 'path_not_allowed')
}

async function assertBacklogCreateWritesFileAndRecord(): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-mobile-backlog-create-'))
  const service = new MobileSprintEngineCommandService({
    workspaceRoot,
    now: () => now,
    execute: async () => {
      throw new Error('Sprint Engine tool should not run for backlog create')
    },
  })

  const result = await service.dispatch(command('backlog.create', {
    workspacePath: workspaceRoot,
    title: 'Ship the phone widget',
    description: 'Users need the widget on the phone.',
    type: 'spike',
    difficulty: 'm',
    criticality: 'high',
  }, {
    commandId: 'cmd_backlog_create',
    idempotencyKey: 'mobile:device_1:backlog-create',
  }))

  assert.equal(result.ok, true)
  const data = result.ok ? (result.data as { id: string; relativePath: string }) : null
  assert.ok(data?.relativePath?.startsWith('backlog/'), 'create returns a backlog/-relative path')
  assert.match(data!.relativePath, /^backlog\/\d{4}-\d{2}-\d{2}-ship-the-phone-widget\.md$/)
  assert.ok(data!.id.startsWith('backlog_'), 'create returns a stable backlog id')

  // v2-native create: lifecycle/triage live in the new file's frontmatter (the
  // source of truth), the sidecar record stays minimal app-owned churn.
  const fileBody = await readFile(join(workspaceRoot, data!.relativePath), 'utf8')
  // Main-owned create allocates the item number and stamps `updated` inside
  // the create transaction, so a fresh workspace's first item is id 1 with a
  // wall-clock timestamp — match the frontmatter structurally.
  assert.match(
    fileBody,
    /^---\nid: 1\ntype: spike\nstatus: idea\ndifficulty: m\ncriticality: high\nupdated: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\n---\n\n# Ship the phone widget\n\nUsers need the widget on the phone\.\n$/
  )

  const store = JSON.parse(await readFile(join(workspaceRoot, '.multi-code', 'backlog', 'items.json'), 'utf8')) as {
    items: Array<{ id: string; source: { relativePath: string }; status?: string; type?: string; difficulty?: string; criticality?: string }>
  }
  const record = store.items.find((item) => item.source.relativePath === data!.relativePath)
  assert.ok(record, 'backlog.create should upsert a real items.json record')
  assert.equal(record?.status, undefined, 'lifecycle must not be seeded into the sidecar record')
  assert.equal(record?.type, undefined)
  assert.equal(record?.difficulty, undefined)
  assert.equal(record?.criticality, undefined)
  assert.equal(record?.id, data!.id)
}

async function assertBacklogCreateRejectsEmptyTitle(): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-mobile-backlog-create-empty-'))
  const service = new MobileSprintEngineCommandService({
    workspaceRoot,
    now: () => now,
    execute: async () => {
      throw new Error('Sprint Engine tool should not run for rejected backlog create')
    },
  })

  const result = await service.dispatch(command('backlog.create', {
    workspacePath: workspaceRoot,
    title: '   ',
  }, {
    commandId: 'cmd_backlog_create_empty',
    idempotencyKey: 'mobile:device_1:backlog-create-empty',
  }))

  assert.equal(result.ok, false)
  assert.equal(result.ok === false ? result.error.code : '', 'invalid_payload')
}

async function assertBacklogCreateKeepsGeneratedPathUnderBacklog(): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-mobile-backlog-create-escape-'))
  const service = new MobileSprintEngineCommandService({
    workspaceRoot,
    now: () => now,
    execute: async () => {
      throw new Error('Sprint Engine tool should not run for backlog create')
    },
  })

  // A title full of path-traversal characters must not escape backlog/.
  const result = await service.dispatch(command('backlog.create', {
    workspacePath: workspaceRoot,
    title: '../../etc/passwd',
  }, {
    commandId: 'cmd_backlog_create_escape',
    idempotencyKey: 'mobile:device_1:backlog-create-escape',
  }))

  assert.equal(result.ok, true)
  const data = result.ok ? (result.data as { relativePath: string }) : null
  assert.ok(data?.relativePath?.startsWith('backlog/'), 'title traversal is slugified under backlog/')
  assert.equal(data!.relativePath.includes('..'), false, 'generated path cannot escape the backlog folder')
  await readFile(join(workspaceRoot, data!.relativePath), 'utf8')
}

async function assertFilesystemMutationHandlersProtectSprintEngineStateAliases(): Promise<void> {
  const handlers = await importMainProcessIpcHandlers()
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-fs-guard-'))
  const sprintEngineDirectory = join(workspaceRoot, '.multi-code', 'sprintengine')
  const teamDirectory = join(sprintEngineDirectory, 'team')
  await mkdir(teamDirectory, { recursive: true })
  const statePath = join(teamDirectory, 'run.yaml')
  await writeFile(statePath, 'canonical Sprint Engine run\n', 'utf8')

  const stateSymlinkPath = join(workspaceRoot, 'state-link.yaml')
  const teamSymlinkPath = join(workspaceRoot, 'team-link')
  const hasStateSymlink = await tryCreateSymlink(statePath, stateSymlinkPath, 'file')
  const hasTeamSymlink = await tryCreateSymlink(
    teamDirectory,
    teamSymlinkPath,
    platform() === 'win32' ? 'junction' : 'dir'
  )

  await assertRejectsSprintEngineStateMutation(() => handlers.writeFile(statePath, 'blocked'))
  await assertRejectsSprintEngineStateMutation(() => handlers.writeFile(join(teamDirectory, '..', 'team', 'run.yaml'), 'blocked'))
  if (hasStateSymlink) {
    await assertRejectsSprintEngineStateMutation(() => handlers.writeFile(stateSymlinkPath, 'blocked'))
  }
  if (hasTeamSymlink) {
    await assertRejectsSprintEngineStateMutation(() => handlers.writeFile(join(teamSymlinkPath, 'run.yaml'), 'blocked'))
  }

  if (hasStateSymlink) {
    await assertRejectsSprintEngineStateMutation(() => handlers.rename(stateSymlinkPath, 'renamed-link.yaml'))
  }
  if (hasTeamSymlink) {
    const renameSourceThroughAlias = join(teamSymlinkPath, 'rename-source.txt')
    await writeFile(renameSourceThroughAlias, 'safe source\n', 'utf8')
    await assertRejectsSprintEngineStateMutation(() => handlers.rename(renameSourceThroughAlias, 'run.yaml'))
  }

  const copyDestination = join(workspaceRoot, 'copy-destination')
  await mkdir(copyDestination)
  if (hasStateSymlink) {
    await assertRejectsSprintEngineStateMutation(() => handlers.copy(stateSymlinkPath, copyDestination))
  }
  await assertRejectsSprintEngineStateMutation(() => handlers.rename(teamDirectory, 'team-renamed'))
  await assertRejectsSprintEngineStateMutation(() => handlers.copy(teamDirectory, copyDestination))
  await assertRejectsSprintEngineStateMutation(() => handlers.rename(sprintEngineDirectory, 'sprintengine-renamed'))
  await assertRejectsSprintEngineStateMutation(() => handlers.copy(sprintEngineDirectory, copyDestination))
  if (hasTeamSymlink) {
    await assertRejectsSprintEngineStateMutation(() => handlers.rename(teamSymlinkPath, 'team-link-renamed'))
    await assertRejectsSprintEngineStateMutation(() => handlers.copy(teamSymlinkPath, copyDestination))
  }

  assert.equal(await readFile(statePath, 'utf8'), 'canonical Sprint Engine run\n')

  if (hasStateSymlink) {
    await handlers.delete(stateSymlinkPath)
    await assert.rejects(() => access(stateSymlinkPath))
  }
  if (hasTeamSymlink) {
    await handlers.delete(teamSymlinkPath)
    await assert.rejects(() => access(teamSymlinkPath))
  }
  await handlers.delete(sprintEngineDirectory)
  await assert.rejects(() => access(sprintEngineDirectory))

  const safeDirectory = join(workspaceRoot, 'safe')
  const safeCopyDestination = join(workspaceRoot, 'safe-copy')
  await mkdir(safeDirectory)
  await mkdir(safeCopyDestination)

  const safeFilePath = join(safeDirectory, 'notes.txt')
  await handlers.writeFile(safeFilePath, 'safe write\n')
  assert.equal(await readFile(safeFilePath, 'utf8'), 'safe write\n')

  const renamedSafeFilePath = await handlers.rename(safeFilePath, 'renamed.txt')
  assert.equal(renamedSafeFilePath, join(safeDirectory, 'renamed.txt'))
  assert.equal(await readFile(renamedSafeFilePath, 'utf8'), 'safe write\n')

  const copiedSafeFilePath = await handlers.copy(renamedSafeFilePath, safeCopyDestination)
  assert.equal(await readFile(copiedSafeFilePath, 'utf8'), 'safe write\n')

  await handlers.delete(copiedSafeFilePath)
  await assert.rejects(() => access(copiedSafeFilePath))

  const safeNestedDirectory = join(workspaceRoot, 'safe-dir')
  await mkdir(join(safeNestedDirectory, 'nested'), { recursive: true })
  await writeFile(join(safeNestedDirectory, 'nested', 'notes.txt'), 'safe nested write\n', 'utf8')

  const renamedSafeDirectoryPath = await handlers.rename(safeNestedDirectory, 'safe-dir-renamed')
  assert.equal(await readFile(join(renamedSafeDirectoryPath, 'nested', 'notes.txt'), 'utf8'), 'safe nested write\n')

  const copiedSafeDirectoryPath = await handlers.copy(renamedSafeDirectoryPath, safeCopyDestination)
  assert.equal(await readFile(join(copiedSafeDirectoryPath, 'nested', 'notes.txt'), 'utf8'), 'safe nested write\n')

  await handlers.delete(copiedSafeDirectoryPath)
  await assert.rejects(() => access(copiedSafeDirectoryPath))
  await handlers.delete(renamedSafeDirectoryPath)
  await assert.rejects(() => access(renamedSafeDirectoryPath))
}

async function tryCreateSymlink(targetPath: string, linkPath: string, type: 'file' | 'dir' | 'junction'): Promise<boolean> {
  try {
    await symlink(targetPath, linkPath, type)
    return true
  } catch (error) {
    if (
      error instanceof Error
      && 'code' in error
      && (error.code === 'EPERM' || error.code === 'EACCES')
    ) {
      return false
    }
    throw error
  }
}

type FilesystemMutationHandlers = {
  writeFile: (filePath: string, content: string) => Promise<void>
  rename: (sourcePath: string, nextName: string) => Promise<string>
  copy: (sourcePath: string, destinationDir: string) => Promise<string>
  delete: (targetPath: string) => Promise<void>
}

async function importMainProcessIpcHandlers(): Promise<FilesystemMutationHandlers> {
  const ipcHandlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const nodeRequire = createRequire(__filename)
  const moduleLoader = nodeRequire('node:module') as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown
  }
  const originalLoad = moduleLoader._load

  moduleLoader._load = (request, parent, isMain) => {
    if (request === 'electron') {
      return {
        app: {
          defaultApp: false,
          getAppPath: () => process.cwd(),
          getPath: (name: string) => join(tmpdir(), `multicode-electron-${name}`),
          getVersion: () => '0.0.0',
          isPackaged: false,
          on: () => undefined,
          quit: () => undefined,
          requestSingleInstanceLock: () => true,
          setAppLogsPath: () => undefined,
          setAppUserModelId: () => undefined,
          setAsDefaultProtocolClient: () => true,
          whenReady: () => new Promise(() => undefined),
        },
        BrowserWindow: class {
          static getAllWindows(): unknown[] {
            return []
          }
        },
        dialog: {},
        ipcMain: {
          handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
            ipcHandlers.set(channel, handler)
          },
          on: () => undefined,
        },
        Menu: {
          buildFromTemplate: () => ({}),
          setApplicationMenu: () => undefined,
        },
        safeStorage: {
          decryptString: () => '',
          encryptString: (value: string) => Buffer.from(value),
          isEncryptionAvailable: () => true,
        },
        shell: {
          openExternal: async () => undefined,
          openPath: async () => '',
          showItemInFolder: () => undefined,
          trashItem: async (targetPath: string) => {
            await rm(targetPath, { force: true, recursive: true })
          },
        },
      }
    }
    if (request === 'electron-updater') {
      return { autoUpdater: { checkForUpdatesAndNotify: async () => undefined } }
    }
    if (request === 'node-pty') {
      return { spawn: () => { throw new Error('node-pty should not be used in filesystem IPC tests') } }
    }
    if (request === '@vscode/ripgrep') {
      return { rgPath: 'rg' }
    }
    return originalLoad(request, parent, isMain)
  }

  try {
    await import('../../index')
  } finally {
    moduleLoader._load = originalLoad
  }

  const getHandler = (channel: string): ((...args: unknown[]) => Promise<unknown>) => {
    const handler = ipcHandlers.get(channel)
    assert.ok(handler, `${channel} handler should be registered`)
    return async (...args) => handler(null, ...args) as Promise<unknown>
  }

  return {
    writeFile: async (filePath, content) => {
      await getHandler('fs:writefile')(filePath, content)
    },
    rename: async (sourcePath, nextName) => {
      return await getHandler('fs:rename')(sourcePath, nextName) as string
    },
    copy: async (sourcePath, destinationDir) => {
      return await getHandler('fs:copy')(sourcePath, destinationDir) as string
    },
    delete: async (targetPath) => {
      await getHandler('fs:delete')(targetPath)
    },
  }
}

async function assertRejectsSprintEngineStateMutation(action: () => Promise<unknown>): Promise<void> {
  await assert.rejects(
    action,
    (error) => error instanceof Error && error.message === 'Sprint run-store files must be updated through the Sprint Engine tool.'
  )
}

async function writeSprintEngineFixture(
  sprintEngineId: string,
  artifactPath: string,
  options: {
    tasks?: unknown[]
    sprintEngineAgents?: Record<string, unknown>
  } = {}
): Promise<{ workspaceRoot: string; statePath: string }> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-mobile-command-'))
  const teamDirectory = join(workspaceRoot, '.multi-code', 'sprintengine', sprintEngineId)
  await mkdir(join(teamDirectory, 'documents'), { recursive: true })
  await writeFile(join(teamDirectory, 'documents', 'requirements.md'), '# Requirements\n', 'utf8')
  const statePath = join(teamDirectory, 'run.yaml')
  const runState = {
    sprintengine: {
      name: sprintEngineId,
      updatedAt: '2026-04-28T19:44:00.000Z',
    },
    tasks: options.tasks ?? [],
    sprintEngineAgents: options.sprintEngineAgents ?? {},
    artifacts: [
      {
        id: 'A1',
        kind: 'requirements',
        title: 'Requirements',
        path: artifactPath,
        status: 'ready_for_review',
        taskId: 'T1',
      },
    ],
  }
  await writeFile(statePath, `${JSON.stringify(runState, null, 2)}\n`, 'utf8')
  await writeFile(join(teamDirectory, 'projection.json'), `${JSON.stringify({
    run: {
      name: sprintEngineId,
      updatedAt: '2026-04-28T19:44:00.000Z',
    },
    tasks: runState.tasks,
    artifacts: runState.artifacts,
    // The canonical workers view (MC-1591/MC-1594) — command-level agent
    // resolution must work from `workers`, not the deleted `roster` bridge.
    workers: runState.sprintEngineAgents,
  }, null, 2)}\n`, 'utf8')
  await readSprintEngineSnapshot(statePath)
  return { workspaceRoot, statePath }
}

function task(
  id: string,
  role: string,
  status: 'todo' | 'in_progress' | 'needs_input' | 'done',
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id,
    title: `Task ${id}`,
    role,
    status,
    ownerAgentId: null,
    dependsOn: [],
    ...overrides,
  }
}

function command(
  type: MobileControlCommand['type'],
  payload: MobileControlCommand['payload'],
  overrides: Partial<MobileControlCommand> = {}
): MobileControlCommand {
  return {
    protocolVersion: mobileControlProtocolVersion,
    commandId: 'cmd_1',
    type,
    issuedAt: now.toISOString(),
    deviceId: 'device_1',
    idempotencyKey: 'mobile:device_1:cmd_1',
    payload,
    ...overrides,
  } as MobileControlCommand
}
