import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  defaultMobileSnapshotCommands,
  MobileControlSnapshotService,
  sanitizeMobileSnapshotForTransport,
} from './snapshot'
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
} from './protocol'
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
    await assertProducerCapsAutomations()
    await assertSnapshotSurfacesCreatedSpikeBacklogItem()
    await assertSnapshotOmitsBacklogWhenWorkspaceHasNone()
    await assertSnapshotCarriesNoWorkspacesCollection()
    await assertUnscopedDefaultSnapshotIsValidOnceSanitized()
    await assertIncludeScopingOmitsUnrequestedCollections()
    console.log('mobile/control/snapshot.test.ts: ok')
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
    // And the sanitized copy the phone actually receives is valid too.
    assert.equal(validateMobileControlSnapshot(sanitizeMobileSnapshotForTransport(snapshot)).ok, true)
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
  }

  // One project's automations, seeded PAST every cap, must come out of the
  // producer capped: no more automations than the per-project cap, no more runs
  // than the recent-runs cap, and run text truncated. This drives the real store
  // through the real producer, so it is the caps measured on what the phone reads.
  async function assertProducerCapsAutomations(): Promise<void> {
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
    const snapshot = sanitizeMobileSnapshotForTransport(
      await service.readSnapshot({ desktopSessionId: 'desktop_1', workspaceRoots: [workspaceRoot], generatedAt }),
    )

    const automations = snapshot.automations ?? []
    assert.equal(automations.length, automationsPerProjectMax)
    for (const automation of automations) {
      assert.equal(automation.recentRuns?.length, automationRecentRunsMax)
      const [latest] = automation.recentRuns ?? []
      assert.equal(latest.summary?.length, automationRunTextMaxChars)
      assert.equal(latest.summary?.endsWith('…'), true)
      assert.equal(latest.blockedReason?.length, automationRunTextMaxChars)
    }

    assert.equal(validateMobileControlSnapshot(snapshot).ok, true)
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
    const phoneCopy = sanitizeMobileSnapshotForTransport(snapshot)
    assert.equal(Object.hasOwn(phoneCopy, 'workspaces'), false)
    assert.equal(validateMobileControlSnapshot(phoneCopy).ok, true)
  }

  async function assertUnscopedDefaultSnapshotIsValidOnceSanitized(): Promise<void> {
    const workspaceRoot = await makeWorkspaceRoot('unscoped-default')
    await writeBacklogFixture(workspaceRoot, 'backlog_default', 'Default snapshot item')
    const service = new MobileControlSnapshotService()
    const snapshot = sanitizeMobileSnapshotForTransport(
      await service.readSnapshot({ desktopSessionId: 'desktop_1', workspaceRoots: [workspaceRoot], generatedAt }),
    )
    assert.equal(validateMobileControlSnapshot(snapshot).ok, true)
    assert.equal(Object.hasOwn(snapshot, 'sprintEngines'), false)
    assert.equal(snapshot.backlog?.length, 1)
  }

  // `include` restricts the payload to the named collections.
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
