import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { defaultMobileSnapshotCommands, MobileControlSnapshotService, sanitizeMobileSnapshotForRelay } from './snapshot'
import { deriveWorkspaceId } from './workspace-id'
import { relayResultSummaryMaxBytes, relaySummaryByteLength, summarizeCommandResult } from '../bridge/command-results'
import { dispatchSnapshotRequest } from '../bridge/snapshot-request'
import { AutomationsStore } from '../../automations/store'
import { createBacklogItem } from '../../backlog-service'
import { stableBacklogObjectId } from '../../../shared/backlog/object-id'
import {
  automationRecentRunsMax,
  automationRunTextMaxChars,
  automationsPerProjectMax,
  mobileControlProtocolVersion,
  mobileSnapshotCollections,
  validateMobileControlSnapshot,
  type MobileControlAutomationSnapshot,
  type MobileControlSnapshot,
} from '../../../../packages/mobile-control-protocol/src/index'
import { test } from 'vitest'

test('snapshot', async () => {
  const generatedAt = '2026-04-28T19:30:00.000Z'

  // The nine commands that left with the Sprint Engine and then left the
  // wire (protocol v3). They are plain strings now, not `MobileControlCommandType`
  // members — the `satisfies` that used to sit here would no longer compile, which
  // is itself the strongest statement this file can make about them.
  const retiredSprintCommands: readonly string[] = [
    'sprintengine.create',
    'task.start',
    'agent.followUp',
    'artifact.read',
    'artifact.approve',
    'artifact.requestChanges',
    'backlog.startSprintEngine',
    'sprintengine.openPullRequest',
    'sprintengine.setAutomationMode',
  ]

  const suiteRun = main()

  async function main(): Promise<void> {
    await assertSnapshotCarriesNoSprintEngineCollection()
    await assertSnapshotAdvertisesNoSprintCommand()
    await assertSnapshotIncludesWorkspaceBacklog()
    await assertSnapshotCarriesNoRoleCatalogue()
    await assertTopLevelSnapshotVersionIsContentStableAcrossReads()
    await assertBacklogOnlyChangeBumpsTopLevelSnapshotVersion()
    await assertAutomationsOnlyChangeBumpsTopLevelSnapshotVersion()
    await assertCappedAutomationsFitTheRelayResultBudget()
    await assertShedDropsRecentRunsWhenTheSnapshotIsOversized()
    await assertSnapshotSurfacesCreatedSpikeBacklogItem()
    await assertSnapshotOmitsBacklogWhenWorkspaceHasNone()
    await assertSnapshotCarriesNoWorkspacesCollection()
    await assertUnscopedDefaultSnapshotIsValidForOldClients()
    await assertWorkspacePathScopingReturnsOnlyThatRoot()
    await assertScopedRequestSkipsSheddingLadder()
    await assertIncludeScopingOmitsUnrequestedCollections()
    await assertPublishingIsThrottled()
    assertMobileProtocolCopyHasNotDrifted()
    console.log('mobile/control/snapshot.test.ts: ok')
  }

  // Drift guard (T10). The wire schema now lives in
  // packages/mobile-control-protocol, which this repo compiles from source and
  // publishes as @sprintengine/mobile-control-protocol — so this desktop no
  // longer keeps a copy of it. The phone still does: its build reaches a store
  // review this repository does not control, so until a released phone build
  // depends on the package there is exactly one hand-maintained copy left, over
  // there, and this pin is still the only thing that catches it drifting.
  //
  // Protocol v3 (2026-09-16) changed this file for the first time since the
  // extraction: `sprintEngines`, `roleCatalogs`, the sprint commands, capabilities,
  // relay scopes and the `sprintengine` workspace kind are gone, and the wire
  // version moved 2 -> 3. Both repositories were edited together and both pins were
  // set to the hash below in the same change, which is the procedure in
  // docs/compatibility.md step 5.
  //
  // Protocol v4 (2026-09-16) changed it again, the same way: the `workspaces`
  // collection, `desktopWorkspaces`, the `roadmaps` rider and `python_tool_failed`
  // are gone, and the wire version moved 3 -> 4.
  //
  // Retire this once the phone ships against the package: at that point there is
  // no second copy to compare and the phone's own pin becomes an assertion about
  // which package version it resolved. docs/mobile-protocol-package.md has the
  // order of operations.
  const mobileProtocolSourceSha256 = 'ca7db9da218ca3cfa91d74a009808a24c6d5d573808e9c9d0e6db340bfdcf543'

  function assertMobileProtocolCopyHasNotDrifted(): void {
    const source = readFileSync(join(process.cwd(), 'packages/mobile-control-protocol/src/index.ts'))
    const digest = createHash('sha256').update(source).digest('hex')
    assert.equal(
      digest,
      mobileProtocolSourceSha256,
      'the protocol package source changed — mirror the edit into the sprintengine-mobile copy and update both pinned hashes to the new shared value',
    )
  }

  // INVERTED at protocol v3, and this is the assertion the whole change turns on.
  //
  // At v2 this read `Object.hasOwn(snapshot, 'sprintEngines') === true`, because
  // `sprintEngines` was a REQUIRED member: a desktop that dropped the key made
  // every snapshot read on the phone fail `invalid_payload`, losing backlog and
  // automations along with the runs. That is why the removal emitted `[]` forever
  // instead of removing it — the right call while a paired phone demanded it.
  //
  // Pre-release there is no such phone, so the collection is gone from the wire
  // rather than hollowed out, and the key must now be ABSENT. The validator is run
  // over the whole payload, twice, to prove that absence is well-formed.
  async function assertSnapshotCarriesNoSprintEngineCollection(): Promise<void> {
    const workspaceRoot = await makeWorkspaceRoot('sprints-absent')
    await writeBacklogFixture(workspaceRoot, 'backlog_absent', 'Something to read')
    const service = new MobileControlSnapshotService()

    const snapshot = await service.readSnapshot({
      desktopSessionId: 'desktop_1',
      workspaceRoots: [workspaceRoot],
      generatedAt,
    })

    assert.equal(Object.hasOwn(snapshot, 'sprintEngines'), false, 'the collection is gone, not emptied')
    assert.equal(Object.hasOwn(snapshot, 'snapshotLimits'), false, 'its shedding report went with it')
    assert.equal(snapshot.protocolVersion, mobileControlProtocolVersion)
    // v3 removed `sprintEngines`; v4 removed `workspaces` and `roadmaps`.
    assert.equal(mobileControlProtocolVersion, 4, 'a removed member is a wire bump')
    // The rest of the snapshot is untouched by the cut.
    assert.equal(snapshot.backlog?.length, 1)
    assert.equal(validateMobileControlSnapshot(snapshot).ok, true)
    // And the relay-safe copy the phone actually receives is valid too.
    assert.equal(validateMobileControlSnapshot(sanitizeMobileSnapshotForRelay(snapshot)).ok, true)
    service.shutdown()
  }

  async function assertSnapshotAdvertisesNoSprintCommand(): Promise<void> {
    const workspaceRoot = await makeWorkspaceRoot('commands')
    const service = new MobileControlSnapshotService()
    const snapshot = await service.readSnapshot({
      desktopSessionId: 'desktop_1',
      workspaceRoots: [workspaceRoot],
      generatedAt,
    })

    for (const retired of retiredSprintCommands) {
      assert.equal(snapshot.commands?.includes(retired), false, `${retired} must not be advertised`)
      assert.equal(
        (defaultMobileSnapshotCommands as readonly string[]).includes(retired),
        false,
        `${retired} must not be in the default set`,
      )
    }
    // What survives still is.
    assert.equal(snapshot.commands?.includes('snapshot.request'), true)
    assert.equal(snapshot.commands?.includes('backlog.update'), true)
    assert.equal(snapshot.commands?.includes('backlog.create'), true)
    assert.equal(snapshot.commands?.includes('automations.control'), true)
    service.shutdown()
  }

  async function assertSnapshotIncludesWorkspaceBacklog(): Promise<void> {
    const workspaceRoot = await makeWorkspaceRoot('backlog')
    await mkdir(join(workspaceRoot, 'backlog'), { recursive: true })
    await writeFile(
      join(workspaceRoot, 'backlog', '2026-06-11-widget.md'),
      '---\ntype: feature\n---\n\n# Ship the widget\n\nUsers need the widget on the phone.\n',
      'utf8',
    )
    await mkdir(join(workspaceRoot, '.sprintengine', 'backlog'), { recursive: true })
    await writeFile(
      join(workspaceRoot, '.sprintengine', 'backlog', 'items.json'),
      JSON.stringify({
        schemaVersion: 1,
        items: [
          {
            // The object id is always the canonical path hash; the store loader
            // re-keys any legacy/mismatched id onto it (reconcileBacklogObjectRecordIds).
            id: stableBacklogObjectId('backlog/2026-06-11-widget.md'),
            source: { type: 'file', relativePath: 'backlog/2026-06-11-widget.md' },
            status: 'ready',
            type: 'feature',
            difficulty: 'm',
            criticality: 'high',
            metadata: {},
            links: [],
            createdAt: generatedAt,
            updatedAt: generatedAt,
          },
          {
            id: stableBacklogObjectId('backlog/archived/old.md'),
            source: { type: 'file', relativePath: 'backlog/archived/old.md' },
            status: 'archived',
            metadata: {},
            links: [],
            createdAt: generatedAt,
            updatedAt: generatedAt,
          },
        ],
      }),
      'utf8',
    )
    const service = new MobileControlSnapshotService()

    const snapshot = await service.readSnapshot({
      desktopSessionId: 'desktop_1',
      workspaceRoots: [workspaceRoot],
      generatedAt,
    })

    assert.equal(snapshot.commands?.includes('backlog.update'), true)
    assert.equal(snapshot.backlog?.length, 1)
    const backlogWorkspace = snapshot.backlog?.[0]
    assert.equal(backlogWorkspace?.workspacePath, workspaceRoot)
    assert.equal(backlogWorkspace?.items.length, 1)
    const item = backlogWorkspace?.items[0]
    assert.equal(item?.itemId, stableBacklogObjectId('backlog/2026-06-11-widget.md'))
    assert.equal(item?.title, 'Ship the widget')
    assert.equal(item?.status, 'ready')
    assert.equal(item?.type, 'feature')
    assert.equal(item?.difficulty, 'm')
    assert.equal(item?.criticality, 'high')
    assert.equal(item?.excerpt?.includes('Users need the widget'), true)
    assert.equal(item?.excerpt?.includes('type: feature'), false)
    assert.equal(validateMobileControlSnapshot(snapshot).ok, true)
    service.shutdown()
  }

  // The workspace's role registry once rode on its backlog workspace so the
  // phone's launch picker could offer roles it was never compiled to know about.
  // Reading that registry meant spawning the engine's Python, and the picker it
  // fed was the first screen of a sprint launch — both left with the engine.
  // `roles` stays optional on the wire and is simply never attached,
  // which is the case the phone already handles by falling back to its own list.
  async function assertSnapshotCarriesNoRoleCatalogue(): Promise<void> {
    const workspaceRoot = await makeWorkspaceRoot('no-roles')
    await writeBacklogFixture(workspaceRoot, 'backlog_roles', 'An item in a workspace with roles installed')
    const service = new MobileControlSnapshotService()

    const snapshot = await service.readSnapshot({
      desktopSessionId: 'desktop_1',
      workspaceRoots: [workspaceRoot],
      generatedAt,
      // INVERTED at protocol v3: `roleCatalogs` used to be a nameable collection
      // with no producer. It is not a collection at all now, so naming it is a
      // payload error rather than a request the desktop quietly answers empty.
      include: ['backlog'],
    })

    assert.equal(
      (mobileSnapshotCollections as readonly string[]).includes('roleCatalogs'),
      false,
      'roleCatalogs is no longer a snapshot collection',
    )
    assert.equal(
      (mobileSnapshotCollections as readonly string[]).includes('sprintEngines'),
      false,
      'sprintEngines is no longer a snapshot collection',
    )

    const backlogWorkspace = snapshot.backlog?.[0]
    assert.equal(backlogWorkspace?.items.length, 1)
    assert.equal('roles' in (backlogWorkspace ?? {}), false, 'roles is omitted, never an empty catalogue')
    assert.equal('rolesUnavailable' in (backlogWorkspace ?? {}), false)
    assert.equal(validateMobileControlSnapshot(snapshot).ok, true)
    service.shutdown()
  }

  async function assertTopLevelSnapshotVersionIsContentStableAcrossReads(): Promise<void> {
    const workspaceRoot = await makeWorkspaceRoot('stable-version')
    await writeBacklogFixture(workspaceRoot, 'backlog_stable', 'Stable backlog item')
    const store = new AutomationsStore(workspaceRoot)
    await store.createDefinition({
      id: 'nightly',
      name: 'Nightly sweep',
      status: 'enabled',
      // Interval cadence renders with no timezone suffix, so even the cadence string
      // carries no wall-clock — the whole automation projection is content-only.
      trigger: {
        kind: 'schedule',
        config: { kind: 'schedule', cadence: { type: 'interval', everyMinutes: 90 }, timezone: 'UTC' },
      },
      action: { kind: 'agent-run', config: { prompt: 'sweep' } },
      nextRunAt: null,
      lastRunAt: generatedAt,
      lastRunId: null,
      createdAt: generatedAt,
      updatedAt: generatedAt,
    })
    const service = new MobileControlSnapshotService()

    const first = await service.readSnapshot({ desktopSessionId: 'desktop_1', workspaceRoots: [workspaceRoot] })
    const second = await service.readSnapshot({ desktopSessionId: 'desktop_1', workspaceRoots: [workspaceRoot] })
    // The two reads stamped different `generatedAt` values (proving the read is
    // live), yet the content-derived version is byte-identical.
    assert.notEqual(first.generatedAt, second.generatedAt)
    assert.equal(
      second.snapshotVersion,
      first.snapshotVersion,
      'the top-level snapshotVersion is content-derived and stable across idle reads',
    )
    service.shutdown()
  }

  // A backlog-only change must move the top-level version, or the fast path would
  // serve a phone stale backlog. The read-time `generatedAt` is held fixed so the
  // only moving part is the item's status.
  async function assertBacklogOnlyChangeBumpsTopLevelSnapshotVersion(): Promise<void> {
    const workspaceRoot = await makeWorkspaceRoot('backlog-bump')
    await writeBacklogFixture(workspaceRoot, 'backlog_bump', 'Backlog bump item')
    const service = new MobileControlSnapshotService()

    const before = await service.readSnapshot({
      desktopSessionId: 'desktop_1',
      workspaceRoots: [workspaceRoot],
      generatedAt,
    })
    await writeFile(
      join(workspaceRoot, '.sprintengine', 'backlog', 'items.json'),
      JSON.stringify({
        schemaVersion: 1,
        items: [
          {
            id: 'backlog_bump',
            source: { type: 'file', relativePath: 'backlog/backlog_bump.md' },
            status: 'in_progress',
            type: 'feature',
            metadata: {},
            links: [],
            createdAt: generatedAt,
            updatedAt: generatedAt,
          },
        ],
      }),
      'utf8',
    )
    const after = await service.readSnapshot({
      desktopSessionId: 'desktop_1',
      workspaceRoots: [workspaceRoot],
      generatedAt,
    })

    assert.notEqual(
      after.snapshotVersion,
      before.snapshotVersion,
      'a backlog-only change produces a new top-level snapshotVersion',
    )
    service.shutdown()
  }

  // An automations-only change must move the top-level version for the same reason.
  async function assertAutomationsOnlyChangeBumpsTopLevelSnapshotVersion(): Promise<void> {
    const workspaceRoot = await makeWorkspaceRoot('automations-bump')
    const store = new AutomationsStore(workspaceRoot)
    await store.createDefinition({
      id: 'nightly',
      name: 'Nightly sweep',
      status: 'enabled',
      trigger: {
        kind: 'schedule',
        config: { kind: 'schedule', cadence: { type: 'interval', everyMinutes: 90 }, timezone: 'UTC' },
      },
      action: { kind: 'agent-run', config: { prompt: 'sweep' } },
      nextRunAt: null,
      lastRunAt: generatedAt,
      lastRunId: null,
      createdAt: generatedAt,
      updatedAt: generatedAt,
    })
    const service = new MobileControlSnapshotService()

    const before = await service.readSnapshot({
      desktopSessionId: 'desktop_1',
      workspaceRoots: [workspaceRoot],
      generatedAt,
    })
    const paused = await store.updateDefinition({
      id: 'nightly',
      name: 'Nightly sweep',
      status: 'paused',
      trigger: {
        kind: 'schedule',
        config: { kind: 'schedule', cadence: { type: 'interval', everyMinutes: 90 }, timezone: 'UTC' },
      },
      action: { kind: 'agent-run', config: { prompt: 'sweep' } },
      nextRunAt: null,
      lastRunAt: generatedAt,
      lastRunId: null,
      createdAt: generatedAt,
      updatedAt: generatedAt,
    })
    assert.equal(paused.ok, true)
    const after = await service.readSnapshot({
      desktopSessionId: 'desktop_1',
      workspaceRoots: [workspaceRoot],
      generatedAt,
    })

    assert.notEqual(
      after.snapshotVersion,
      before.snapshotVersion,
      'an automations-only change produces a new top-level snapshotVersion',
    )
    service.shutdown()
  }

  // One project's automations, seeded PAST every cap, must still ride the on-demand
  // snapshot.request path inside the relay's 256 KB result-summary budget — and must
  // still be there at the far end, unshed. This drives the real producer through the
  // real bridge path, so it is the caps and the size budget measured together rather
  // than either one asserted in isolation.
  async function assertCappedAutomationsFitTheRelayResultBudget(): Promise<void> {
    const workspaceRoot = await makeWorkspaceRoot('capped-automations')
    const store = new AutomationsStore(workspaceRoot)
    // Every automation is seeded at worst case: past both caps, and with run text
    // well past the truncation limit, so the wire payload is the largest one project
    // can produce.
    const seededAutomations = automationsPerProjectMax + 2
    const seededRuns = automationRecentRunsMax + 2
    for (let index = 0; index < seededAutomations; index += 1) {
      const automationId = `automation-${String(index).padStart(2, '0')}`
      await store.createDefinition({
        id: automationId,
        name: `Automation ${index}`,
        status: 'enabled',
        trigger: {
          kind: 'schedule',
          config: { kind: 'schedule', cadence: { type: 'interval', everyMinutes: 30 }, timezone: 'UTC' },
        },
        action: { kind: 'agent-run', config: { prompt: 'sweep' } },
        nextRunAt: null,
        lastRunAt: generatedAt,
        lastRunId: `${automationId}-run-0`,
        createdAt: generatedAt,
        updatedAt: `2026-06-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
      })
      for (let runIndex = 0; runIndex < seededRuns; runIndex += 1) {
        const minute = String(runIndex).padStart(2, '0')
        await store.recordRun({
          id: `${automationId}-run-${runIndex}`,
          automationId,
          status: 'blocked',
          dueAt: `2026-07-13T10:${minute}:00.000Z`,
          startedAt: `2026-07-13T10:${minute}:01.000Z`,
          completedAt: `2026-07-13T10:${minute}:30.000Z`,
          blockedReason: 'b'.repeat(automationRunTextMaxChars * 3),
          summary: 's'.repeat(automationRunTextMaxChars * 3),
        })
      }
    }

    const service = new MobileControlSnapshotService()
    const result = await dispatchSnapshotRequest({
      command: { type: 'snapshot.request', commandId: 'c1', deviceId: 'd1', payload: {} } as never,
      snapshotService: service,
      desktopSessionId: 'desktop_1',
      workspaceRootsProvider: async () => [workspaceRoot],
    })
    assert.equal(result.ok, true)
    const snapshot = (result.ok ? result.data : null) as MobileControlSnapshot

    const automations = snapshot.automations ?? []
    assert.equal(automations.length, automationsPerProjectMax)
    for (const automation of automations) {
      assert.equal(automation.recentRuns?.length, automationRecentRunsMax)
      const [latest] = automation.recentRuns ?? []
      assert.equal(latest.summary?.length, automationRunTextMaxChars)
      assert.equal(latest.summary?.endsWith('…'), true)
      assert.equal(latest.blockedReason?.length, automationRunTextMaxChars)
    }

    // The whole point of the caps: a project at full cap fits, so the ladder never
    // has to shed anything for one project's automations.
    assert.equal(
      relaySummaryByteLength(summarizeCommandResult(result)) <= relayResultSummaryMaxBytes,
      true,
      'a project at full automations cap must fit the relay result-summary budget',
    )
    assert.equal(validateMobileControlSnapshot(snapshot).ok, true)
    service.shutdown()
  }

  // Four workspace roots at full automations cap exceed the budget on automations
  // alone (~110% of 256 KB, measured), which is exactly the case the per-project
  // caps cannot prevent. Run history is monitor detail on an automation the phone
  // can still see, so it is what the ladder drops. Since the Sprint Engine left it is the only
  // rung: the role catalogues above it and the sprint engines below it are gone.
  async function assertShedDropsRecentRunsWhenTheSnapshotIsOversized(): Promise<void> {
    const workspaceRoot = await makeWorkspaceRoot('crowded')
    const service = new MobileControlSnapshotService()
    const base = sanitizeMobileSnapshotForRelay(
      await service.readSnapshot({ desktopSessionId: 'desktop_1', workspaceRoots: [workspaceRoot], generatedAt }),
    )
    const oversized: MobileControlSnapshot = {
      ...base,
      automations: ['ws_alpha', 'ws_beta', 'ws_gamma', 'ws_delta'].flatMap(automationsAtFullCap),
    }
    assert.equal(
      relaySummaryByteLength(oversized) > relayResultSummaryMaxBytes,
      true,
      'fixture must actually exceed the budget, or the ladder is never exercised',
    )

    const result = await dispatchSnapshotRequest({
      command: { type: 'snapshot.request', commandId: 'c2', deviceId: 'd1', payload: {} } as never,
      snapshotService: { readSnapshot: async () => oversized } as never,
      desktopSessionId: 'desktop_1',
    })
    assert.equal(result.ok, true)
    const shed = (result.ok ? result.data : null) as MobileControlSnapshot

    // Every automation is still on the wire — only its run history went.
    assert.equal(shed.automations?.length, oversized.automations?.length)
    assert.equal(
      shed.automations?.some((automation) => automation.recentRuns !== undefined),
      false,
    )
    // Shedding is omission, not an empty array: the wire field is optional and the
    // validator would reject a nulled one.
    assert.equal(
      shed.automations?.every((automation) => !('recentRuns' in automation)),
      true,
    )
    assert.equal(shed.automations?.[0]?.name, oversized.automations?.[0]?.name)

    assert.equal(
      relaySummaryByteLength(summarizeCommandResult(result)) <= relayResultSummaryMaxBytes,
      true,
      'dropping recentRuns must be enough to bring four capped projects back inside the budget',
    )
    assert.equal(validateMobileControlSnapshot(shed).ok, true)
    service.shutdown()
  }

  // One project's automations exactly as the producer emits them at full cap: capped
  // count, capped runs, run text at the truncation limit.
  function automationsAtFullCap(projectKey: string): MobileControlAutomationSnapshot[] {
    return Array.from({ length: automationsPerProjectMax }, (_automation, index) => ({
      automationId: `${projectKey}-automation-${index}`,
      projectKey,
      name: `Automation ${index}`,
      status: 'enabled' as const,
      triggerKind: 'schedule',
      cadence: 'Every 30 min',
      nextRunAt: generatedAt,
      lastRunAt: generatedAt,
      lastRunStatus: 'blocked' as const,
      recentRuns: Array.from({ length: automationRecentRunsMax }, (_run, runIndex) => ({
        runId: `${projectKey}-automation-${index}-run-${runIndex}`,
        status: 'blocked' as const,
        startedAt: generatedAt,
        completedAt: generatedAt,
        blockedReason: 'b'.repeat(automationRunTextMaxChars),
        summary: 's'.repeat(automationRunTextMaxChars),
      })),
    }))
  }

  async function assertSnapshotSurfacesCreatedSpikeBacklogItem(): Promise<void> {
    const workspaceRoot = await makeWorkspaceRoot('spike-backlog')

    // Use the real create path the mobile backlog.create command calls.
    const created = await createBacklogItem({
      workspaceRoot,
      title: 'Probe the relay timeout',
      description: 'Spike how the relay behaves under a 30s stall.',
      type: 'spike',
    })
    assert.equal(created.ok, true)

    const service = new MobileControlSnapshotService()
    const snapshot = await service.readSnapshot({
      desktopSessionId: 'desktop_1',
      workspaceRoots: [workspaceRoot],
      generatedAt,
    })

    assert.equal(snapshot.commands?.includes('backlog.create'), true)
    const backlogWorkspace = snapshot.backlog?.find((entry) => entry.workspacePath === workspaceRoot)
    assert.equal(backlogWorkspace?.items.length, 1)
    const item = backlogWorkspace?.items[0]
    assert.equal(item?.title, 'Probe the relay timeout')
    assert.equal(item?.status, 'idea')
    assert.equal(item?.type, 'spike')
    assert.equal(item?.excerpt?.includes('30s stall'), true)
    service.shutdown()
  }

  async function assertSnapshotOmitsBacklogWhenWorkspaceHasNone(): Promise<void> {
    const workspaceRoot = await makeWorkspaceRoot('no-backlog')
    const service = new MobileControlSnapshotService()

    const snapshot = await service.readSnapshot({
      desktopSessionId: 'desktop_1',
      workspaceRoots: [workspaceRoot],
      generatedAt,
    })

    assert.equal(snapshot.backlog, undefined)
    service.shutdown()
  }

  // Protocol v4. Until then this desktop emitted `workspaces: []` on every
  // snapshot — no producer had projected into it since the Switchboard and
  // Watchtower modules were retired — and declared a `desktopWorkspaces`
  // collection that claimed to serve those monitors and served nothing. The key is
  // now absent, not emptied, and the collection is no longer nameable.
  async function assertSnapshotCarriesNoWorkspacesCollection(): Promise<void> {
    const workspaceRoot = await makeWorkspaceRoot('no-workspaces')
    await writeBacklogFixture(workspaceRoot, 'backlog_no_workspaces', 'Still here')
    const service = new MobileControlSnapshotService()

    const snapshot = await service.readSnapshot({
      desktopSessionId: 'desktop_1',
      workspaceRoots: [workspaceRoot],
      generatedAt,
    })

    for (const retired of ['workspaces', 'roadmaps', 'sprintEngines']) {
      assert.equal(Object.hasOwn(snapshot, retired), false, `${retired} is gone, not emptied`)
    }
    assert.deepEqual([...mobileSnapshotCollections].sort(), ['automations', 'backlog'])
    assert.equal(snapshot.backlog?.length, 1)
    const relaySafe = sanitizeMobileSnapshotForRelay(snapshot)
    assert.equal(Object.hasOwn(relaySafe, 'workspaces'), false)
    assert.equal(validateMobileControlSnapshot(relaySafe).ok, true)
    service.shutdown()
  }

  async function assertUnscopedDefaultSnapshotIsValidForOldClients(): Promise<void> {
    const workspaceRoot = await makeWorkspaceRoot('unscoped-default')
    await writeBacklogFixture(workspaceRoot, 'backlog_default', 'Default snapshot item')
    const service = new MobileControlSnapshotService()
    const result = await dispatchSnapshotRequest({
      command: { type: 'snapshot.request', commandId: 'c-default', deviceId: 'd1', payload: {} } as never,
      snapshotService: service,
      desktopSessionId: 'desktop_1',
      workspaceRootsProvider: async () => [workspaceRoot],
    })
    assert.equal(result.ok, true)
    const snapshot = (result.ok ? result.data : null) as MobileControlSnapshot
    assert.equal(validateMobileControlSnapshot(snapshot).ok, true)
    assert.equal(Object.hasOwn(snapshot, 'sprintEngines'), false)
    assert.equal(snapshot.backlog?.length, 1)
    service.shutdown()
  }

  // Item 1600 acceptance: a scoped request keeps skipping the size-shedding ladder,
  // so an oversized scoped result is returned whole rather than shed.
  async function assertScopedRequestSkipsSheddingLadder(): Promise<void> {
    const workspaceRoot = await makeWorkspaceRoot('scoped-shed')
    const oversized: MobileControlSnapshot = {
      protocolVersion: mobileControlProtocolVersion,
      generatedAt,
      desktopSessionId: 'desktop_1',
      snapshotVersion: 'snap_scoped',
      commands: [],
      automations: ['ws_alpha', 'ws_beta', 'ws_gamma', 'ws_delta'].flatMap(automationsAtFullCap),
    }
    assert.equal(relaySummaryByteLength(oversized) > relayResultSummaryMaxBytes, true, 'fixture must exceed the budget')

    const result = await dispatchSnapshotRequest({
      command: {
        type: 'snapshot.request',
        commandId: 'c-scoped',
        deviceId: 'd1',
        payload: { workspacePath: deriveWorkspaceId(workspaceRoot) },
      } as never,
      snapshotService: { readSnapshot: async () => oversized } as never,
      desktopSessionId: 'desktop_1',
      workspaceRootsProvider: async () => [workspaceRoot],
    })
    assert.equal(result.ok, true)
    const returned = (result.ok ? result.data : null) as MobileControlSnapshot
    // No shedding: every automation keeps its run history despite the over-budget size.
    assert.equal(returned.automations?.length, oversized.automations?.length)
    assert.equal(
      returned.automations?.every((automation) => automation.recentRuns !== undefined),
      true,
    )
  }

  // Item 1600 part 2: a `workspacePath`-scoped request (the phone sends the relay-safe
  // projectKey token) narrows the snapshot to that one root.
  async function assertWorkspacePathScopingReturnsOnlyThatRoot(): Promise<void> {
    const rootA = await makeWorkspaceRoot('scope-a')
    const rootB = await makeWorkspaceRoot('scope-b')
    await writeBacklogFixture(rootB, 'backlog_root_b', 'Only in root B')

    const service = new MobileControlSnapshotService()
    const result = await dispatchSnapshotRequest({
      command: {
        type: 'snapshot.request',
        commandId: 'c-ws',
        deviceId: 'd1',
        payload: { workspacePath: deriveWorkspaceId(rootA) },
      } as never,
      snapshotService: service,
      desktopSessionId: 'desktop_1',
      workspaceRootsProvider: async () => [rootA, rootB],
    })
    assert.equal(result.ok, true)
    const snapshot = (result.ok ? result.data : null) as MobileControlSnapshot
    // None of root B's backlog.
    assert.equal(snapshot.backlog, undefined)
    service.shutdown()
  }

  // Item 1600 part 3: `include` restricts the payload to the named collections.
  async function assertIncludeScopingOmitsUnrequestedCollections(): Promise<void> {
    const workspaceRoot = await makeWorkspaceRoot('include-scoping')
    await writeBacklogFixture(workspaceRoot, 'backlog_inc', 'Include-scoped item')
    const store = new AutomationsStore(workspaceRoot)
    await store.createDefinition({
      id: 'nightly',
      name: 'Nightly sweep',
      status: 'enabled',
      trigger: {
        kind: 'schedule',
        config: { kind: 'schedule', cadence: { type: 'interval', everyMinutes: 90 }, timezone: 'UTC' },
      },
      action: { kind: 'agent-run', config: { prompt: 'sweep' } },
      nextRunAt: null,
      lastRunAt: generatedAt,
      lastRunId: null,
      createdAt: generatedAt,
      updatedAt: generatedAt,
    })
    const service = new MobileControlSnapshotService()

    const onlyBacklog = await service.readSnapshot({
      desktopSessionId: 'desktop_1',
      workspaceRoots: [workspaceRoot],
      generatedAt,
      include: ['backlog'],
    })
    assert.equal(onlyBacklog.backlog?.length, 1)
    assert.equal(onlyBacklog.automations, undefined)

    const onlyAutomations = await service.readSnapshot({
      desktopSessionId: 'desktop_1',
      workspaceRoots: [workspaceRoot],
      generatedAt,
      include: ['automations'],
    })
    assert.equal(onlyAutomations.automations?.length, 1)
    assert.equal(onlyAutomations.backlog, undefined)
    service.shutdown()
  }

  async function assertPublishingIsThrottled(): Promise<void> {
    const workspaceRoot = await makeWorkspaceRoot('throttle')
    const service = new MobileControlSnapshotService({ publishThrottleMs: 60 })
    const published: string[] = []
    service.subscribe((snapshot) => {
      published.push(snapshot.generatedAt)
    })

    const first = await service.publishSnapshot({
      desktopSessionId: 'desktop_1',
      workspaceRoots: [workspaceRoot],
      generatedAt,
    })
    const second = await service.publishSnapshot({
      desktopSessionId: 'desktop_1',
      workspaceRoots: [workspaceRoot],
      generatedAt: '2026-04-28T19:30:01.000Z',
    })
    const flushed = await service.flushPendingSnapshot()

    assert.equal(first?.generatedAt, generatedAt)
    assert.equal(second, null)
    assert.equal(flushed?.generatedAt, '2026-04-28T19:30:01.000Z')
    assert.deepEqual(published, [generatedAt, '2026-04-28T19:30:01.000Z'])
    service.shutdown()
  }

  async function makeWorkspaceRoot(label: string): Promise<string> {
    return mkdtemp(join(tmpdir(), `sprintengine-mobile-${label}-`))
  }

  async function writeBacklogFixture(workspaceRoot: string, itemId: string, title: string): Promise<void> {
    await mkdir(join(workspaceRoot, 'backlog'), { recursive: true })
    await writeFile(
      join(workspaceRoot, 'backlog', `${itemId}.md`),
      `---\ntype: feature\n---\n\n# ${title}\n\nBody.\n`,
      'utf8',
    )
    await mkdir(join(workspaceRoot, '.sprintengine', 'backlog'), { recursive: true })
    await writeFile(
      join(workspaceRoot, '.sprintengine', 'backlog', 'items.json'),
      JSON.stringify({
        schemaVersion: 1,
        items: [
          {
            id: itemId,
            source: { type: 'file', relativePath: `backlog/${itemId}.md` },
            status: 'ready',
            type: 'feature',
            metadata: {},
            links: [],
            createdAt: generatedAt,
            updatedAt: generatedAt,
          },
        ],
      }),
      'utf8',
    )
  }

  await suiteRun
})
