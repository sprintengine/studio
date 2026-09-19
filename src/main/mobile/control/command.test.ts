import assert from 'node:assert/strict'
import { standIn } from '../../../../tests/stand-in'
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { mobileControlProtocolVersion, MobileControlCommandService, type MobileControlCommand } from './command'
import { createMobileAutomationsController } from './automations-controller'
import { defaultMobileSnapshotCommands } from './snapshot'
import { deriveWorkspaceId } from './workspace-id'
import type { AutomationDefinition, AutomationDefinitionDraft } from '../../../shared/automations/contracts'
import type { WorkspaceSyncSnapshot } from '../../../shared/workspace-sync'
import type { Workspace } from '../../../renderer/src/types/workspace'
import { createAutomationsEngine } from '../../automations/engine'
import { createBuiltInAutomationProviderRegistry } from '../../automations/provider-registry'
import { AutomationsStore } from '../../automations/store'
import { WEBHOOK_TRIGGER_KIND } from '../../automations/triggers/webhook'
import { registerAutomationsIpc } from '../../ipc/automations-ipc'
import type { IpcInvokeHandler } from '../../module-host/main-host'
import { parseBacklogFrontmatter } from '../../../shared/backlog/frontmatter'
import { test } from 'vitest'

test('command', async () => {
  const now = new Date('2026-04-28T19:45:00.000Z')

  const suiteRun = main()

  async function main(): Promise<void> {
    await assertRetiredSprintCommandIsRefusedCleanly()
    await assertEveryRetiredSprintCommandIsRefusedCleanly()
    await assertSameIdempotencyKeyAndBodyReplaysCachedResult()
    await assertSameIdempotencyKeyWithDifferentBodyIsRejected()
    await assertIdempotencyReplaySurvivesServiceRecreation()
    await assertBacklogUpdateWritesFrontmatter()
    await assertBacklogCreateWritesFileAndRecord()
    await assertBacklogCreateRejectsEmptyTitle()
    await assertBacklogCreateKeepsGeneratedPathUnderBacklog()
    await assertFilesystemMutationHandlersRoundTripOrdinaryPaths()
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

  // INVERTED at protocol v3. MC-2575 required these to be refused as
  // `command_not_supported` — the envelope validator had to ACCEPT them so a phone
  // paired before the Sprint Engine left got an honest refusal from the service
  // rather than a "malformed" answer to a message that was not malformed.
  //
  // The wire no longer defines them, so that is no longer the truth to tell. A
  // sender of one is speaking a version outside the window, and `invalid_payload`
  // from the envelope validator is now the accurate answer: this build cannot read
  // the message. What must NOT change is that something comes back at all — a
  // dropped command is a phone spinning until its own timeout, which was the real
  // failure MC-2575 was guarding against, and it is still guarded here.
  async function assertRetiredSprintCommandIsRefusedCleanly(): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-mobile-command-retired-'))
    const service = new MobileControlCommandService({ workspaceRoot, now: () => now })

    const result = await service.dispatch(
      command(
        'task.start' as MobileControlCommand['type'],
        {
          sprintEngineId: 'team',
          taskId: 'T1',
          role: 'developer',
          worktreeIsolation: 'preferred',
        } as MobileControlCommand['payload'],
      ),
    )

    assert.equal(result.ok, false)
    assert.equal(result.ok === false ? result.error.code : '', 'invalid_payload')
    assert.equal(result.ok === false ? result.error.retryable : true, false)
    // Still audited, so the desktop's own log says a phone asked for something the
    // wire no longer carries.
    const audit = service.getAuditLog()[0]
    assert.equal(audit.status, 'rejected')
    assert.equal(audit.code, 'invalid_payload')
  }

  async function assertEveryRetiredSprintCommandIsRefusedCleanly(): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-mobile-command-retired-all-'))
    const service = new MobileControlCommandService({ workspaceRoot, now: () => now })

    // Every payload here is one a live phone really sent at v2. None of the nine
    // types is a member of `MobileControlCommandType` any more, which is why each
    // is cast in rather than declared — the cast IS the assertion.
    const retired: Array<[string, Record<string, unknown>]> = [
      ['sprintengine.create', { workspacePath: workspaceRoot, productPrompt: 'Build it' }],
      ['task.start', { sprintEngineId: 'team', taskId: 'T1', role: 'developer', worktreeIsolation: 'preferred' }],
      ['agent.followUp', { sprintEngineId: 'team', agentId: 'developer-1', text: 'carry on' }],
      ['artifact.approve', { sprintEngineId: 'team', artifactId: 'A1' }],
      ['artifact.requestChanges', { sprintEngineId: 'team', artifactId: 'A1', feedback: 'more detail' }],
      ['artifact.read', { sprintEngineId: 'team', artifactId: 'A1', previewMode: 'markdown' }],
      ['backlog.startSprintEngine', { workspacePath: workspaceRoot, relativePath: 'backlog/idea.md' }],
      ['sprintengine.openPullRequest', { sprintEngineId: 'team' }],
      ['sprintengine.setAutomationMode', { sprintEngineId: 'team', mode: 'run_agents' }],
    ]

    for (const [type, payload] of retired) {
      const result = await service.dispatch(
        command(type as MobileControlCommand['type'], payload as MobileControlCommand['payload'], {
          commandId: `cmd_${type}`,
          idempotencyKey: `mobile:device_1:${type}`,
        }),
      )
      assert.equal(result.ok, false, `${type} must be refused`)
      assert.equal(
        result.ok === false ? result.error.code : '',
        'invalid_payload',
        `${type} is no longer a command this wire defines`,
      )
    }

    // And none of them is advertised, so no phone draws the control.
    for (const [type] of retired) {
      assert.equal(
        (defaultMobileSnapshotCommands as readonly string[]).includes(type),
        false,
        `${type} must not be advertised`,
      )
    }
  }

  // The idempotency ledger used to be exercised through `artifact.approve`. Its
  // vehicle is now `backlog.create`, which has the same property that made the
  // artifact command a good one: a visible side effect on disk, so a replay that
  // re-executed would be caught by the item count rather than by a spy.
  async function assertSameIdempotencyKeyAndBodyReplaysCachedResult(): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-mobile-command-replay-'))
    const service = new MobileControlCommandService({ workspaceRoot, now: () => now })
    const mobileCommand = command(
      'backlog.create',
      {
        workspacePath: workspaceRoot,
        title: 'Replay me once',
      },
      {
        idempotencyKey: 'mobile:device_1:replay',
      },
    )

    const first = await service.dispatch(mobileCommand)
    const second = await service.dispatch({ ...mobileCommand, commandId: 'cmd_replay' })

    assert.equal(first.ok, true)
    assert.equal(second.ok, true)
    // The cached replay is a JSON clone, so compare the serialized bodies: a key
    // whose value was `undefined` does not survive the round trip and never
    // reached the phone in the first place.
    assert.equal(JSON.stringify(second.ok ? second.data : null), JSON.stringify(first.ok ? first.data : null))
    assert.equal((await readBacklogStoreItems(workspaceRoot)).length, 1)
    assert.equal(service.getAuditLog()[0].status, 'accepted')
    assert.equal(service.getAuditLog()[0].deviceId, 'device_1')
    assert.equal(service.getAuditLog()[0].commandId, 'cmd_replay')
  }

  async function assertSameIdempotencyKeyWithDifferentBodyIsRejected(): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-mobile-command-replay-conflict-'))
    const service = new MobileControlCommandService({ workspaceRoot, now: () => now })

    const first = await service.dispatch(
      command(
        'backlog.create',
        {
          workspacePath: workspaceRoot,
          title: 'The first body',
        },
        {
          idempotencyKey: 'mobile:device_1:replay-conflict',
        },
      ),
    )
    const second = await service.dispatch(
      command(
        'backlog.create',
        {
          workspacePath: workspaceRoot,
          title: 'This different body must not be executed',
        },
        {
          commandId: 'cmd_replay_conflict',
          idempotencyKey: 'mobile:device_1:replay-conflict',
        },
      ),
    )

    assert.equal(first.ok, true)
    assert.equal(second.ok, false)
    assert.equal(second.ok === false ? second.error.code : '', 'duplicate_idempotency_key')
    assert.equal((await readBacklogStoreItems(workspaceRoot)).length, 1)
    const audit = service.getAuditLog()[0]
    assert.equal(audit.status, 'rejected')
    assert.equal(audit.deviceId, 'device_1')
    assert.equal(audit.commandId, 'cmd_replay_conflict')
    assert.equal(audit.code, 'duplicate_idempotency_key')
    assert.equal(JSON.stringify(audit).includes('This different body'), false)
  }

  async function assertIdempotencyReplaySurvivesServiceRecreation(): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-mobile-command-replay-recreate-'))
    const mobileCommand = command(
      'backlog.create',
      {
        workspacePath: workspaceRoot,
        title: 'Survive a restart',
      },
      {
        idempotencyKey: 'mobile:device_1:replay-recreate',
      },
    )

    const first = await new MobileControlCommandService({ workspaceRoot, now: () => now }).dispatch(mobileCommand)
    const second = await new MobileControlCommandService({ workspaceRoot, now: () => now }).dispatch({
      ...mobileCommand,
      commandId: 'cmd_replay_recreate',
    })

    assert.equal(first.ok, true)
    assert.equal(second.ok, true)
    assert.equal(JSON.stringify(second.ok ? second.data : null), JSON.stringify(first.ok ? first.data : null))
    assert.equal((await readBacklogStoreItems(workspaceRoot)).length, 1)
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

    const paused = await fixture.service.dispatch(
      command('automations.control', {
        workspacePath: deriveWorkspaceId(fixture.workspaceRoot),
        automationId: 'nightly-review',
        action: 'pause',
      }),
    )

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

    const enabled = await fixture.service.dispatch(
      command(
        'automations.control',
        {
          workspacePath: deriveWorkspaceId(fixture.workspaceRoot),
          automationId: 'nightly-review',
          action: 'enable',
        },
        { commandId: 'cmd_2', idempotencyKey: 'mobile:device_1:cmd_2' },
      ),
    )

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

    const result = await fixture.service.dispatch(
      command('automations.control', {
        workspacePath: deriveWorkspaceId(fixture.workspaceRoot),
        automationId: 'nightly-review',
        action: 'runNow',
      }),
    )

    assert.equal(result.ok, true)
    assert.equal(fixture.runs.length, 1, 'run-now must actually fire the automation, not just report success')
    const data = result.ok === true ? (result.data as { runId?: string; runStatus?: string; status?: string }) : null
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

    const result = await fixture.service.dispatch(
      command('automations.control', {
        workspacePath: deriveWorkspaceId(fixture.workspaceRoot),
        automationId: 'on-webhook',
        action: 'runNow',
      }),
    )

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
    const paused = await fixture.service.dispatch(
      command(
        'automations.control',
        {
          workspacePath: deriveWorkspaceId(fixture.workspaceRoot),
          automationId: 'on-webhook',
          action: 'pause',
        },
        { commandId: 'cmd_2', idempotencyKey: 'mobile:device_1:cmd_2' },
      ),
    )
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
    const firstRun = fixture.service.dispatch(
      command('automations.control', {
        workspacePath,
        automationId: 'nightly-review',
        action: 'runNow',
      }),
    )
    await firstRunStarted

    const secondRun = await fixture.service.dispatch(
      command(
        'automations.control',
        {
          workspacePath,
          automationId: 'nightly-review',
          action: 'runNow',
        },
        { commandId: 'cmd_2', idempotencyKey: 'mobile:device_1:cmd_2' },
      ),
    )

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
    const afterItFinished = await fixture.service.dispatch(
      command(
        'automations.control',
        {
          workspacePath,
          automationId: 'nightly-review',
          action: 'runNow',
        },
        { commandId: 'cmd_3', idempotencyKey: 'mobile:device_1:cmd_3' },
      ),
    )
    assert.equal(afterItFinished.ok, true, 'run-now must be accepted once nothing is in flight')
    assert.equal(fixture.runs.length, 2)
  }

  async function assertAutomationsControlRejectsAnUnknownWorkspaceToken(): Promise<void> {
    // Fail closed: a workspace token this desktop cannot resolve never reaches the
    // automations store.
    const fixture = await automationsFixture()
    await fixture.createAutomation()

    const result = await fixture.service.dispatch(
      command('automations.control', {
        workspacePath: deriveWorkspaceId(join(tmpdir(), 'multicode-not-this-workspace')),
        automationId: 'nightly-review',
        action: 'pause',
      }),
    )

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
      const result = await fixture.service.dispatch(
        command('automations.control', payload as MobileControlCommand['payload'], {
          commandId: `cmd_bad_${index}`,
          idempotencyKey: `mobile:device_1:cmd_bad_${index}`,
        }),
      )
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
      id: 'needs-integration',
      name: 'Needs a connector this build lacks',
      status: 'blocked',
      trigger: {
        kind: 'schedule',
        config: { kind: 'schedule', cadence: { type: 'interval', everyMinutes: 30 }, timezone: 'UTC' },
      },
      action: { kind: 'acme.unregistered-action', config: {} },
      nextRunAt: null,
      lastRunAt: null,
      lastRunId: null,
      createdAt: '2026-06-18T00:00:00.000Z',
      updatedAt: '2026-06-18T00:00:00.000Z',
    })

    const result = await fixture.service.dispatch(
      command('automations.control', {
        workspacePath: deriveWorkspaceId(fixture.workspaceRoot),
        automationId: 'needs-integration',
        action: 'enable',
      }),
    )

    assert.equal(result.ok, false)
    assert.equal(result.ok === false ? result.error.code : '', 'command_not_supported')
    // The provider's own reason reaches the phone, not a generic failure.
    assert.match(result.ok === false ? result.error.message : '', /acme\.unregistered-action/)
    // And it stays blocked: a refused enable must not half-apply.
    assert.equal((await fixture.readDefinition('needs-integration')).status, 'blocked')
  }

  async function assertAutomationsControlRejectsAnAutomationTheDesktopNoLongerHas(): Promise<void> {
    // The phone acted on a snapshot listing an automation that has since been deleted.
    // That is a stale view, not an internal fault, and not a malformed payload.
    const fixture = await automationsFixture()
    await fixture.createAutomation()

    const result = await fixture.service.dispatch(
      command('automations.control', {
        workspacePath: deriveWorkspaceId(fixture.workspaceRoot),
        automationId: 'deleted-yesterday',
        action: 'pause',
      }),
    )

    assert.equal(result.ok, false)
    assert.equal(result.ok === false ? result.error.code : '', 'stale_snapshot')
  }

  async function assertAutomationsControlRetryDoesNotFireASecondRun(): Promise<void> {
    // Run-now spawns an agent. A phone that retries on a lost response (the exact case
    // idempotencyKey exists for) must NOT fire a second agent run: that costs real money
    // and can collide with the run already going.
    const fixture = await automationsFixture()
    await fixture.createAutomation()

    const runNow = () =>
      fixture.service.dispatch(
        command('automations.control', {
          workspacePath: deriveWorkspaceId(fixture.workspaceRoot),
          automationId: 'nightly-review',
          action: 'runNow',
        }),
      )

    const first = await runNow()
    const replayed = await runNow()

    assert.equal(first.ok, true)
    assert.equal(replayed.ok, true)
    assert.equal(
      fixture.runs.length,
      1,
      'a retried run-now must replay the cached result, not spawn a second agent run',
    )
    assert.deepEqual(
      replayed.ok === true ? replayed.data : null,
      first.ok === true ? first.data : undefined,
      'the retry must return the original run, not a new one',
    )
  }

  async function assertAutomationsControlRejectsWhenTheModuleIsAbsent(): Promise<void> {
    // A desktop build with no Automations module must reject honestly rather than
    // report a success nobody applied.
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-mobile-automations-absent-'))
    const service = new MobileControlCommandService({
      workspaceRoot,
      now: () => now,
      automationsController: createMobileAutomationsController(() => null),
    })

    const result = await service.dispatch(
      command('automations.control', {
        workspacePath: deriveWorkspaceId(workspaceRoot),
        automationId: 'nightly-review',
        action: 'enable',
      }),
    )

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
      'automations.control must be advertised now that the desktop can execute it',
    )
  }

  // A real automations stack over a temp workspace: real store on disk, real engine,
  // real IPC front door, and the production controller adapter.
  let pendingRunGate: { started: () => void; gate: Promise<void> } | null = null

  async function automationsFixture(): Promise<{
    workspaceRoot: string
    service: MobileControlCommandService
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
      },
    )

    const service = new MobileControlCommandService({
      workspaceRoot,
      now: () => now,
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
            ...overrides,
          },
        })
        assert.equal(
          created.ok,
          true,
          `automation fixture must be created: ${created.ok === false ? created.message : ''}`,
        )
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
        workspaces: [
          {
            id: 'ws-1',
            name: 'Automations',
            folderPath: workspaceRoot,
          } as Workspace,
        ],
      },
    }
  }

  async function assertBacklogUpdateWritesFrontmatter(): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-mobile-backlog-update-'))
    await mkdir(join(workspaceRoot, 'backlog'), { recursive: true })
    const body = '# A rough idea\n\nDo the thing.\n'
    await writeFile(join(workspaceRoot, 'backlog', 'idea.md'), body, 'utf8')
    const service = new MobileControlCommandService({
      workspaceRoot,
      now: () => now,
    })

    const result = await service.dispatch(
      command(
        'backlog.update',
        {
          workspacePath: workspaceRoot,
          relativePath: 'backlog/idea.md',
          status: 'ready',
          difficulty: 'm',
          criticality: 'high',
        },
        {
          commandId: 'cmd_backlog_update',
          idempotencyKey: 'mobile:device_1:backlog-update',
        },
      ),
    )

    assert.equal(result.ok, true)
    // Lifecycle/triage now live in the item's markdown frontmatter (v2), not the
    // sidecar; the body is preserved byte-for-byte and the link cache is never created.
    const updated = parseBacklogFrontmatter(await readFile(join(workspaceRoot, 'backlog', 'idea.md'), 'utf8'))
    assert.equal(updated.fields.status, 'ready')
    assert.equal(updated.fields.difficulty, 'm')
    assert.equal(updated.fields.criticality, 'high')
    assert.equal(updated.body, body, 'backlog.update must preserve the document body')
    await assert.rejects(
      () => readFile(join(workspaceRoot, '.sprintengine', 'backlog', 'cache', 'links.json'), 'utf8'),
      /ENOENT/,
      'backlog.update must not write the link cache for lifecycle/triage',
    )

    const invalid = await service.dispatch(
      command(
        'backlog.update',
        {
          workspacePath: workspaceRoot,
          relativePath: 'backlog/idea.md',
          // @ts-expect-error deliberately invalid status to exercise the dispatcher's runtime invalid_payload rejection
          status: 'not-a-status',
        },
        {
          commandId: 'cmd_backlog_update_invalid',
          idempotencyKey: 'mobile:device_1:backlog-update-invalid',
        },
      ),
    )
    assert.equal(invalid.ok, false)
    assert.equal(invalid.ok === false ? invalid.error.code : '', 'invalid_payload')
  }

  type BacklogStoreItem = {
    source: { relativePath: string }
    status?: string
    metadata?: Record<string, unknown>
    links?: Array<{
      id: string
      type: string
      label: string
      target: { kind: string; id: string; path?: string; url?: string }
    }>
  }

  async function readBacklogStoreItems(workspaceRoot: string): Promise<BacklogStoreItem[]> {
    const store = JSON.parse(
      await readFile(join(workspaceRoot, '.sprintengine', 'backlog', 'cache', 'links.json'), 'utf8'),
    ) as { items: BacklogStoreItem[] }
    return store.items
  }

  async function assertBacklogCreateWritesFileAndRecord(): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-mobile-backlog-create-'))
    const service = new MobileControlCommandService({
      workspaceRoot,
      now: () => now,
    })

    const result = await service.dispatch(
      command(
        'backlog.create',
        {
          workspacePath: workspaceRoot,
          title: 'Ship the phone widget',
          description: 'Users need the widget on the phone.',
          type: 'spike',
          difficulty: 'm',
          criticality: 'high',
        },
        {
          commandId: 'cmd_backlog_create',
          idempotencyKey: 'mobile:device_1:backlog-create',
        },
      ),
    )

    assert.equal(result.ok, true)
    const data = result.ok ? (result.data as { id: string; relativePath: string }) : null
    assert.ok(data?.relativePath?.startsWith('backlog/'), 'create returns a backlog/-relative path')
    // A folder under `backlog/` is an epic, so an item created without one is filed
    // in `unfiled/` rather than landing at the top level among the epic folders.
    assert.match(data!.relativePath, /^backlog\/unfiled\/\d{4}-\d{2}-\d{2}-ship-the-phone-widget\.md$/)
    assert.ok(data!.id.startsWith('backlog_'), 'create returns a stable backlog id')

    // v2-native create: lifecycle/triage live in the new file's frontmatter (the
    // source of truth), the sidecar record stays minimal app-owned churn.
    const fileBody = await readFile(join(workspaceRoot, data!.relativePath), 'utf8')
    // Main-owned create allocates the item number and stamps `updated` inside
    // the create transaction, so a fresh workspace's first item is id 1 with a
    // wall-clock timestamp — match the frontmatter structurally.
    assert.match(
      fileBody,
      /^---\nid: 1\ntype: spike\nstatus: idea\ndifficulty: m\ncriticality: high\nupdated: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\n---\n\n# Ship the phone widget\n\nUsers need the widget on the phone\.\n$/,
    )

    const store = JSON.parse(
      await readFile(join(workspaceRoot, '.sprintengine', 'backlog', 'cache', 'links.json'), 'utf8'),
    ) as {
      items: Array<{
        id: string
        source: { relativePath: string }
        status?: string
        type?: string
        difficulty?: string
        criticality?: string
      }>
    }
    const record = store.items.find((item) => item.source.relativePath === data!.relativePath)
    assert.ok(record, 'backlog.create should upsert a real link-cache record')
    assert.equal(record?.status, undefined, 'lifecycle must not be seeded into the sidecar record')
    assert.equal(record?.type, undefined)
    assert.equal(record?.difficulty, undefined)
    assert.equal(record?.criticality, undefined)
    assert.equal(record?.id, data!.id)
  }

  async function assertBacklogCreateRejectsEmptyTitle(): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-mobile-backlog-create-empty-'))
    const service = new MobileControlCommandService({
      workspaceRoot,
      now: () => now,
    })

    const result = await service.dispatch(
      command(
        'backlog.create',
        {
          workspacePath: workspaceRoot,
          title: '   ',
        },
        {
          commandId: 'cmd_backlog_create_empty',
          idempotencyKey: 'mobile:device_1:backlog-create-empty',
        },
      ),
    )

    assert.equal(result.ok, false)
    assert.equal(result.ok === false ? result.error.code : '', 'invalid_payload')
  }

  async function assertBacklogCreateKeepsGeneratedPathUnderBacklog(): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-mobile-backlog-create-escape-'))
    const service = new MobileControlCommandService({
      workspaceRoot,
      now: () => now,
    })

    // A title full of path-traversal characters must not escape backlog/.
    const result = await service.dispatch(
      command(
        'backlog.create',
        {
          workspacePath: workspaceRoot,
          title: '../../etc/passwd',
        },
        {
          commandId: 'cmd_backlog_create_escape',
          idempotencyKey: 'mobile:device_1:backlog-create-escape',
        },
      ),
    )

    assert.equal(result.ok, true)
    const data = result.ok ? (result.data as { relativePath: string }) : null
    assert.ok(data?.relativePath?.startsWith('backlog/'), 'title traversal is slugified under backlog/')
    assert.equal(data!.relativePath.includes('..'), false, 'generated path cannot escape the backlog folder')
    await readFile(join(workspaceRoot, data!.relativePath), 'utf8')
  }

  // The filesystem mutation IPC is what the file tree and the phone both write
  // through, so its write/rename/copy/delete round trip is asserted end to end on
  // real paths rather than mocked: a handler that silently resolved a path
  // somewhere else would still return a plausible-looking string.
  async function assertFilesystemMutationHandlersRoundTripOrdinaryPaths(): Promise<void> {
    const handlers = await importMainProcessIpcHandlers()
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'multicode-fs-guard-'))

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

  type FilesystemMutationHandlers = {
    writeFile: (filePath: string, content: string) => Promise<void>
    rename: (sourcePath: string, nextName: string) => Promise<string>
    copy: (sourcePath: string, destinationDir: string) => Promise<string>
    delete: (targetPath: string) => Promise<void>
  }

  async function importMainProcessIpcHandlers(): Promise<FilesystemMutationHandlers> {
    const ipcHandlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
    const restoreModules = standIn({
      electron: {
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
        protocol: {
          registerSchemesAsPrivileged: () => undefined,
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
      },
      'electron-updater': { autoUpdater: { checkForUpdatesAndNotify: async () => undefined } },
      'node-pty': {
        spawn: () => {
          throw new Error('node-pty should not be used in filesystem IPC tests')
        },
      },
      '@vscode/ripgrep': { rgPath: 'rg' },
      // The build stamp is minted by a Vite plugin at build time, so there is no
      // module on disk for the test bundle's `require` to find. Stubbing it here
      // keeps this test's existing interception the single place main's build-only
      // dependencies are stood in for.
      'virtual:multicode-build-stamp': {
        buildStamp: {
          commit: null,
          source: 'unavailable' as const,
          builtAt: '2026-01-01T00:00:00.000Z',
          mode: 'development' as const,
        },
      },
    })

    try {
      await import('../../index')
    } finally {
      restoreModules()
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
        return (await getHandler('fs:rename')(sourcePath, nextName)) as string
      },
      copy: async (sourcePath, destinationDir) => {
        return (await getHandler('fs:copy')(sourcePath, destinationDir)) as string
      },
      delete: async (targetPath) => {
        await getHandler('fs:delete')(targetPath)
      },
    }
  }

  function command(
    type: MobileControlCommand['type'],
    payload: MobileControlCommand['payload'],
    overrides: Partial<MobileControlCommand> = {},
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

  await suiteRun
})
