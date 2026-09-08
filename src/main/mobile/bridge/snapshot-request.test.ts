import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { tmpdir } from 'os'
import { MobileSprintEngineSnapshotService, type MobileControlSnapshot } from '../sprintengine/snapshot'
import { AutomationsStore } from '../../automations/store'
import type { AutomationDefinition } from '../../../shared/automations/contracts'
import { dispatchSnapshotRequest } from './snapshot-request'
import { relaySummaryByteLength, summarizeCommandResult } from './command-results'
import { validateMobileControlSnapshot } from '../../../shared/mobile-control/protocol'
import type { MobileControlCommand, MobileSprintEngineCommandResult } from '../sprintengine/command'

// Two read-time wall-clock stamps that differ. `snapshot.ts` folds neither into the
// top-level version after item 1605; these prove that by moving only the wall-clock.
const generatedAtA = '2026-04-28T19:30:00.000Z'
const generatedAtB = '2026-05-14T04:12:57.000Z'

void main()

async function main(): Promise<void> {
  await assertConsecutiveIdleReadsShareTheTopLevelVersion()
  await assertWallClockCadenceAutomationStaysStableAcrossIdleReads()
  await assertBacklogAutomationsAndEngineChangesEachBumpTheVersion()
  await assertMatchingKnownVersionYieldsTheUnchangedFastPath()
  await assertStaleKnownVersionFallsThroughToTheFullSnapshot()
  await assertUnchangedResultCollapsesIdleReadTraffic()
}

// Acceptance (T2 #2, builder half): the top-level snapshotVersion is content-derived,
// so two idle reads of the SAME on-disk fleet — each stamping its own distinct
// `generatedAt` — produce a byte-identical version. This is the precondition the item
// 1599 fast path needs; without it the phone's If-None-Match could never match.
async function assertConsecutiveIdleReadsShareTheTopLevelVersion(): Promise<void> {
  const statePath = await writeIdleFleetFixture()
  const service = emptyDesktopService()

  const first = await service.readSnapshot({ desktopSessionId: 'desktop_1', statePaths: [statePath], generatedAt: generatedAtA })
  const second = await service.readSnapshot({ desktopSessionId: 'desktop_1', statePaths: [statePath], generatedAt: generatedAtB })

  assert.notEqual(first.generatedAt, second.generatedAt, 'the two reads must carry different read-time stamps')
  assert.equal(second.snapshotVersion, first.snapshotVersion,
    'the top-level snapshotVersion is content-derived and stable across idle reads')
  // The fleet really is non-trivial (engine + backlog + automation), so stability is
  // not an artifact of an empty snapshot.
  assert.equal(first.sprintEngines.length >= 1, true)
  assert.equal((first.backlog ?? []).length >= 1, true)
  assert.equal((first.automations ?? []).length >= 1, true)
  service.shutdown()
}

// Regression guard for a leak the interval-cadence tests cannot see: the automations
// projection pre-renders a WALL-CLOCK-bearing cadence (daily/weekly) with a timezone
// label derived from the read's `generatedAt` (snapshot.ts folds `automations` whole,
// unstripped). That label is offset-dependent, so it must not vary between two idle
// reads on the same side of a DST transition — or the fast path would silently never
// fire for any project holding a scheduled automation. Both stamps below sit inside the
// same DST period, so the rendered cadence ("Daily at 09:00 PDT") is identical and the
// version stays stable.
async function assertWallClockCadenceAutomationStaysStableAcrossIdleReads(): Promise<void> {
  const statePath = await writeStateFixture({ sprintengine: { name: 'Daily Cadence', updatedAt: generatedAtA }, tasks: [task('T1', 'done')], artifacts: [] })
  const store = new AutomationsStore(workspaceRootForStatePath(statePath))
  await store.createDefinition({
    ...automationDefinition('daily', 'enabled'),
    trigger: { kind: 'schedule', config: { kind: 'schedule', cadence: { type: 'daily', timeLocal: '09:00' }, timezone: 'America/Los_Angeles' } },
  })
  const service = emptyDesktopService()

  const first = await service.readSnapshot({ desktopSessionId: 'd', statePaths: [statePath], generatedAt: generatedAtA })
  const second = await service.readSnapshot({ desktopSessionId: 'd', statePaths: [statePath], generatedAt: generatedAtB })

  // The cadence really did render a wall-clock string, so this is not a vacuous pass.
  assert.equal((first.automations ?? [])[0]?.cadence?.startsWith('Daily at 09:00'), true, 'the daily cadence must be pre-rendered')
  assert.equal(second.snapshotVersion, first.snapshotVersion,
    'a wall-clock cadence must not destabilise the version between same-DST-period idle reads')
  service.shutdown()
}

// Acceptance (T2 #3): change detection is intact after dropping wall-clock — a
// backlog-only, an automations-only, and a sprint-engine-state change EACH still move
// the top-level version. Read-time `generatedAt` is held fixed so the only variable is
// the mutated collection.
async function assertBacklogAutomationsAndEngineChangesEachBumpTheVersion(): Promise<void> {
  // Backlog-only.
  {
    const statePath = await writeStateFixture({ sprintengine: { name: 'Backlog Bump', updatedAt: generatedAtA }, tasks: [task('T1', 'done')], artifacts: [] })
    const root = workspaceRootForStatePath(statePath)
    await writeBacklogFixture(root, 'backlog_x', 'Backlog item', 'ready')
    const service = emptyDesktopService()
    const before = await service.readSnapshot({ desktopSessionId: 'd', statePaths: [statePath], generatedAt: generatedAtA })
    await writeBacklogFixture(root, 'backlog_x', 'Backlog item', 'in_progress')
    const after = await service.readSnapshot({ desktopSessionId: 'd', statePaths: [statePath], generatedAt: generatedAtA })
    assert.notEqual(after.snapshotVersion, before.snapshotVersion, 'a backlog-only change bumps the top-level version')
    service.shutdown()
  }
  // Automations-only.
  {
    const statePath = await writeStateFixture({ sprintengine: { name: 'Automations Bump', updatedAt: generatedAtA }, tasks: [task('T1', 'done')], artifacts: [] })
    const store = new AutomationsStore(workspaceRootForStatePath(statePath))
    await store.createDefinition(automationDefinition('nightly', 'enabled'))
    const service = emptyDesktopService()
    const before = await service.readSnapshot({ desktopSessionId: 'd', statePaths: [statePath], generatedAt: generatedAtA })
    const paused = await store.updateDefinition(automationDefinition('nightly', 'paused'))
    assert.equal(paused.ok, true)
    const after = await service.readSnapshot({ desktopSessionId: 'd', statePaths: [statePath], generatedAt: generatedAtA })
    assert.notEqual(after.snapshotVersion, before.snapshotVersion, 'an automations-only change bumps the top-level version')
    service.shutdown()
  }
  // Sprint-engine task-status change (MC-1567 invariant preserved).
  {
    const statePath = await writeStateFixture({ sprintengine: { name: 'Engine Bump', updatedAt: generatedAtA }, tasks: [task('T1', 'in_progress')], artifacts: [] })
    const service = emptyDesktopService()
    const before = await service.readSnapshot({ desktopSessionId: 'd', statePaths: [statePath], generatedAt: generatedAtA })
    await writeFile(statePath, `${JSON.stringify({ sprintengine: { name: 'Engine Bump', updatedAt: generatedAtA }, tasks: [task('T1', 'done')], artifacts: [] }, null, 2)}\n`, 'utf8')
    const after = await service.readSnapshot({ desktopSessionId: 'd', statePaths: [statePath], generatedAt: generatedAtA })
    assert.notEqual(after.snapshotVersion, before.snapshotVersion, 'a sprint-engine task change bumps the top-level version (MC-1567)')
    service.shutdown()
  }
}

// Acceptance (T2 #2, handler half): the real on-demand handler fires the item 1599
// fast path. A snapshot.request carrying a matching `knownSnapshotVersion` returns the
// tiny change-token result — `{ unchanged: true, snapshotVersion }` and NOTHING
// content-bearing — instead of the full payload.
async function assertMatchingKnownVersionYieldsTheUnchangedFastPath(): Promise<void> {
  const statePath = await writeIdleFleetFixture()
  const service = emptyDesktopService()

  const full = await dispatchSnapshotRequest({
    command: snapshotRequestCommand('c-full', {}),
    snapshotService: service,
    desktopSessionId: 'desktop_1',
    statePathsProvider: async () => [statePath],
  })
  const knownVersion = requireVersion(okData<MobileControlSnapshot>(full))
  assert.equal(knownVersion.startsWith('snap_'), true)

  const unchanged = await dispatchSnapshotRequest({
    command: snapshotRequestCommand('c-unchanged', { knownSnapshotVersion: knownVersion }),
    snapshotService: service,
    desktopSessionId: 'desktop_1',
    statePathsProvider: async () => [statePath],
  })
  const data = okData<Record<string, unknown>>(unchanged)
  assert.deepEqual(data, { unchanged: true, snapshotVersion: knownVersion },
    'a matching knownSnapshotVersion returns only the change-token, no snapshot content')
  // No content-bearing keys leaked into the fast-path result.
  for (const key of ['sprintEngines', 'workspaces', 'backlog', 'automations', 'commands']) {
    assert.equal(key in data, false, `fast-path result must not carry ${key}`)
  }
  service.shutdown()
}

// Fallback discipline: a stale (non-matching) knownSnapshotVersion must NOT shortcut —
// the handler returns the full snapshot exactly as for a client that sent none, so a
// changed fleet or an old client is never starved.
async function assertStaleKnownVersionFallsThroughToTheFullSnapshot(): Promise<void> {
  const statePath = await writeIdleFleetFixture()
  const service = emptyDesktopService()

  const result = await dispatchSnapshotRequest({
    command: snapshotRequestCommand('c-stale', { knownSnapshotVersion: 'snap_staleversion0000000' }),
    snapshotService: service,
    desktopSessionId: 'desktop_1',
    statePathsProvider: async () => [statePath],
  })
  const data = okData<MobileControlSnapshot>(result)
  assert.equal('unchanged' in (data as unknown as Record<string, unknown>), false, 'a stale version must not trigger the fast path')
  assert.equal(data.sprintEngines.length >= 1, true, 'the full snapshot is returned')
  assert.equal(validateMobileControlSnapshot(data).ok, true, 'the fallback full snapshot still validates on the wire')
  service.shutdown()
}

// Acceptance (T2 #1): the measured before/after idle-read traffic. Both sizes are the
// real relay result-summary bytes (`relaySummaryByteLength(summarizeCommandResult(...))`)
// — what the relay actually stores and ships — for one idle foregrounded phone. The
// full read is the current steady-state cost; the unchanged read is the cost after
// item 1605 activates the item 1599 fast path.
async function assertUnchangedResultCollapsesIdleReadTraffic(): Promise<void> {
  const statePath = await writeIdleFleetFixture()
  const service = emptyDesktopService()

  const full = await dispatchSnapshotRequest({
    command: snapshotRequestCommand('c-measure-full', {}),
    snapshotService: service,
    desktopSessionId: 'desktop_1',
    statePathsProvider: async () => [statePath],
  })
  const knownVersion = requireVersion(okData<MobileControlSnapshot>(full))
  const unchanged = await dispatchSnapshotRequest({
    command: snapshotRequestCommand('c-measure-unchanged', { knownSnapshotVersion: knownVersion }),
    snapshotService: service,
    desktopSessionId: 'desktop_1',
    statePathsProvider: async () => [statePath],
  })

  const fullBytes = relaySummaryByteLength(summarizeCommandResult(full))
  const unchangedBytes = relaySummaryByteLength(summarizeCommandResult(unchanged))
  const pollsPerHour = 3600 / 20 // the phone's 20 s foreground re-pull cadence
  const savedPctPerRead = ((fullBytes - unchangedBytes) / fullBytes) * 100

  // Evidence line (T2 acceptance requires reported numbers, not a claim).
  console.log(`[1605-traffic] idle read: full=${fullBytes}B unchanged=${unchangedBytes}B ` +
    `saved=${savedPctPerRead.toFixed(1)}%/read ` +
    `perHour@20s: full=${Math.round((fullBytes * pollsPerHour) / 1024)}KiB/h ` +
    `unchanged=${Math.round((unchangedBytes * pollsPerHour) / 1024)}KiB/h`)

  // Regression assertions: the fast path must be a small constant, and a large cut.
  assert.equal(unchangedBytes < 700, true, `unchanged result should be tiny, was ${unchangedBytes}B`)
  assert.equal(fullBytes > unchangedBytes * 4, true, 'the full idle read must be several times the unchanged read')
  assert.equal(savedPctPerRead > 80, true, `item 1605 should cut >80% of per-read idle bytes, cut ${savedPctPerRead.toFixed(1)}%`)
  service.shutdown()
}

// A snapshot service whose desktop-workspace readers all report empty, so the snapshot
// is driven only by the on-disk fleet fixture (engine + backlog + automations).
function emptyDesktopService(): MobileSprintEngineSnapshotService {
  return new MobileSprintEngineSnapshotService({
    stateReaders: {
      readRoleCatalog: async () => [],
    },
  })
}

// One idle foregrounded phone's steady-state fleet: a live sprint engine with a handful
// of tasks/artifacts, a couple of backlog items, and one scheduled automation — the
// shape a phone re-pulls every 20 s while nothing changes.
async function writeIdleFleetFixture(): Promise<string> {
  const statePath = await writeStateFixture({
    sprintengine: { name: 'Idle Fleet Sprint Engine', updatedAt: generatedAtA },
    tasks: [task('T1', 'done'), task('T2', 'in_progress'), task('T3', 'todo'), task('T4', 'todo')],
    artifacts: [artifact('A1', 'architect_plan', 'approved', 'T1'), artifact('A2', 'code_review', 'approved', 'T2')],
  })
  const root = workspaceRootForStatePath(statePath)
  await writeBacklogFixture(root, 'backlog_alpha', 'Alpha backlog item', 'ready')
  await writeBacklogFixture(root, 'backlog_beta', 'Beta backlog item', 'in_progress')
  const store = new AutomationsStore(root)
  await store.createDefinition(automationDefinition('nightly', 'enabled'))
  return statePath
}

async function writeStateFixture(state: Record<string, unknown>): Promise<string> {
  const workspacePath = await mkdtemp(join(tmpdir(), 'multicode-snapshot-request-'))
  const teamDirectory = join(workspacePath, '.multi-code', 'sprintengine', 'team')
  await mkdir(teamDirectory, { recursive: true })
  const statePath = join(teamDirectory, 'run.yaml')
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  return statePath
}

// Overwrites the item record so a second call with a new status is a real backlog-only
// change (idempotent on id).
async function writeBacklogFixture(workspaceRoot: string, itemId: string, title: string, status: string): Promise<void> {
  await mkdir(join(workspaceRoot, 'backlog'), { recursive: true })
  await writeFile(join(workspaceRoot, 'backlog', `${itemId}.md`), `---\ntype: feature\n---\n\n# ${title}\n\nBody.\n`, 'utf8')
  await mkdir(join(workspaceRoot, '.multi-code', 'backlog'), { recursive: true })
  await writeFile(
    join(workspaceRoot, '.multi-code', 'backlog', 'items.json'),
    JSON.stringify({
      schemaVersion: 1,
      items: [{
        id: itemId,
        source: { type: 'file', relativePath: `backlog/${itemId}.md` },
        status,
        type: 'feature',
        metadata: {},
        links: [],
        createdAt: generatedAtA,
        updatedAt: generatedAtA,
      }],
    }),
    'utf8'
  )
}

function automationDefinition(id: string, status: 'enabled' | 'paused'): AutomationDefinition {
  return {
    id,
    name: 'Nightly sweep',
    status,
    // Interval cadence renders with no timezone suffix, so the automation projection
    // carries no wall-clock — the whole projection is content-only.
    trigger: { kind: 'schedule', config: { kind: 'schedule', cadence: { type: 'interval', everyMinutes: 90 }, timezone: 'UTC' } },
    action: { kind: 'agent-run', config: { prompt: 'sweep' } },
    nextRunAt: null,
    lastRunAt: generatedAtA,
    lastRunId: null,
    createdAt: generatedAtA,
    updatedAt: generatedAtA,
  }
}

function task(id: string, status: string): Record<string, unknown> {
  return {
    id,
    title: `Task ${id}`,
    role: 'developer',
    status,
    ownerAgentId: status === 'in_progress' ? 'developer-1' : null,
    dependsOn: [],
  }
}

function artifact(id: string, kind: string, status: string, taskId: string): Record<string, unknown> {
  return {
    id,
    kind,
    title: `Artifact ${id}`,
    path: '.multi-code/sprintengine/team/product-requirements.md',
    status,
    createdBy: 'product',
    taskId,
  }
}

function workspaceRootForStatePath(statePath: string): string {
  return dirname(dirname(dirname(dirname(statePath))))
}

function snapshotRequestCommand(commandId: string, payload: Record<string, unknown>): MobileControlCommand {
  return { type: 'snapshot.request', commandId, deviceId: 'device_1', payload } as never
}

function okData<T>(result: MobileSprintEngineCommandResult): T {
  assert.equal(result.ok, true, `command result must be ok: ${result.ok ? '' : JSON.stringify(result)}`)
  return (result.ok ? result.data : null) as T
}

function requireVersion(snapshot: MobileControlSnapshot): string {
  const version = snapshot.snapshotVersion
  assert.ok(typeof version === 'string' && version.length > 0, 'the full snapshot must carry a snapshotVersion')
  return version
}
