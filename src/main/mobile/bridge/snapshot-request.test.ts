import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { MobileControlSnapshotService, type MobileControlSnapshot } from '../control/snapshot'
import { AutomationsStore } from '../../automations/store'
import type { AutomationDefinition } from '../../../shared/automations/contracts'
import { dispatchSnapshotRequest } from './snapshot-request'
import { relaySummaryByteLength, summarizeCommandResult } from './command-results'
import { validateMobileControlSnapshot } from '../../../../packages/mobile-control-protocol/src/index'
import type { MobileControlCommand, MobileControlCommandResult } from '../control/command'

// Two read-time wall-clock stamps that differ. `snapshot.ts` folds neither into the
// top-level version after item 1605; these prove that by moving only the wall-clock.
const generatedAtA = '2026-04-28T19:30:00.000Z'
const generatedAtB = '2026-05-14T04:12:57.000Z'

void main()

async function main(): Promise<void> {
  await assertConsecutiveIdleReadsShareTheTopLevelVersion()
  await assertWallClockCadenceAutomationStaysStableAcrossIdleReads()
  await assertBacklogAndAutomationsChangesEachBumpTheVersion()
  await assertMatchingKnownVersionYieldsTheUnchangedFastPath()
  await assertStaleKnownVersionFallsThroughToTheFullSnapshot()
  await assertUnchangedResultCollapsesIdleReadTraffic()
}

// Acceptance (T2 #2, builder half): the top-level snapshotVersion is content-derived,
// so two idle reads of the SAME on-disk fleet — each stamping its own distinct
// `generatedAt` — produce a byte-identical version. This is the precondition the item
// 1599 fast path needs; without it the phone's If-None-Match could never match.
async function assertConsecutiveIdleReadsShareTheTopLevelVersion(): Promise<void> {
  const workspaceRoot = await writeIdleFleetFixture()
  const service = new MobileControlSnapshotService()

  const first = await service.readSnapshot({
    desktopSessionId: 'desktop_1',
    workspaceRoots: [workspaceRoot],
    generatedAt: generatedAtA,
  })
  const second = await service.readSnapshot({
    desktopSessionId: 'desktop_1',
    workspaceRoots: [workspaceRoot],
    generatedAt: generatedAtB,
  })

  assert.notEqual(first.generatedAt, second.generatedAt, 'the two reads must carry different read-time stamps')
  assert.equal(
    second.snapshotVersion,
    first.snapshotVersion,
    'the top-level snapshotVersion is content-derived and stable across idle reads',
  )
  // The fleet really is non-trivial (backlog + automation), so stability is not an
  // artifact of an empty snapshot.
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
  const workspaceRoot = await makeWorkspaceRoot()
  const store = new AutomationsStore(workspaceRoot)
  await store.createDefinition({
    ...automationDefinition('daily', 'enabled'),
    trigger: {
      kind: 'schedule',
      config: { kind: 'schedule', cadence: { type: 'daily', timeLocal: '09:00' }, timezone: 'America/Los_Angeles' },
    },
  })
  const service = new MobileControlSnapshotService()

  const first = await service.readSnapshot({
    desktopSessionId: 'd',
    workspaceRoots: [workspaceRoot],
    generatedAt: generatedAtA,
  })
  const second = await service.readSnapshot({
    desktopSessionId: 'd',
    workspaceRoots: [workspaceRoot],
    generatedAt: generatedAtB,
  })

  // The cadence really did render a wall-clock string, so this is not a vacuous pass.
  assert.equal(
    (first.automations ?? [])[0]?.cadence?.startsWith('Daily at 09:00'),
    true,
    'the daily cadence must be pre-rendered',
  )
  assert.equal(
    second.snapshotVersion,
    first.snapshotVersion,
    'a wall-clock cadence must not destabilise the version between same-DST-period idle reads',
  )
  service.shutdown()
}

// Acceptance (T2 #3): change detection is intact after dropping wall-clock — a
// backlog-only and an automations-only change EACH still move the top-level version.
// Read-time `generatedAt` is held fixed so the only variable is the mutated
// collection. The sprint-engine-state arm went with the engine (MC-2575).
async function assertBacklogAndAutomationsChangesEachBumpTheVersion(): Promise<void> {
  // Backlog-only.
  {
    const root = await makeWorkspaceRoot()
    await writeBacklogFixture(root, 'backlog_x', 'Backlog item', 'ready')
    const service = new MobileControlSnapshotService()
    const before = await service.readSnapshot({
      desktopSessionId: 'd',
      workspaceRoots: [root],
      generatedAt: generatedAtA,
    })
    await writeBacklogFixture(root, 'backlog_x', 'Backlog item', 'in_progress')
    const after = await service.readSnapshot({
      desktopSessionId: 'd',
      workspaceRoots: [root],
      generatedAt: generatedAtA,
    })
    assert.notEqual(after.snapshotVersion, before.snapshotVersion, 'a backlog-only change bumps the top-level version')
    service.shutdown()
  }
  // Automations-only.
  {
    const root = await makeWorkspaceRoot()
    const store = new AutomationsStore(root)
    await store.createDefinition(automationDefinition('nightly', 'enabled'))
    const service = new MobileControlSnapshotService()
    const before = await service.readSnapshot({
      desktopSessionId: 'd',
      workspaceRoots: [root],
      generatedAt: generatedAtA,
    })
    const paused = await store.updateDefinition(automationDefinition('nightly', 'paused'))
    assert.equal(paused.ok, true)
    const after = await service.readSnapshot({
      desktopSessionId: 'd',
      workspaceRoots: [root],
      generatedAt: generatedAtA,
    })
    assert.notEqual(
      after.snapshotVersion,
      before.snapshotVersion,
      'an automations-only change bumps the top-level version',
    )
    service.shutdown()
  }
}

// Acceptance (T2 #2, handler half): the real on-demand handler fires the item 1599
// fast path. A snapshot.request carrying a matching `knownSnapshotVersion` returns the
// tiny change-token result — `{ unchanged: true, snapshotVersion }` and NOTHING
// content-bearing — instead of the full payload.
async function assertMatchingKnownVersionYieldsTheUnchangedFastPath(): Promise<void> {
  const workspaceRoot = await writeIdleFleetFixture()
  const service = new MobileControlSnapshotService()

  const full = await dispatchSnapshotRequest({
    command: snapshotRequestCommand('c-full', {}),
    snapshotService: service,
    desktopSessionId: 'desktop_1',
    workspaceRootsProvider: async () => [workspaceRoot],
  })
  const knownVersion = requireVersion(okData<MobileControlSnapshot>(full))
  assert.equal(knownVersion.startsWith('snap_'), true)

  const unchanged = await dispatchSnapshotRequest({
    command: snapshotRequestCommand('c-unchanged', { knownSnapshotVersion: knownVersion }),
    snapshotService: service,
    desktopSessionId: 'desktop_1',
    workspaceRootsProvider: async () => [workspaceRoot],
  })
  const data = okData<Record<string, unknown>>(unchanged)
  assert.deepEqual(
    data,
    { unchanged: true, snapshotVersion: knownVersion },
    'a matching knownSnapshotVersion returns only the change-token, no snapshot content',
  )
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
  const workspaceRoot = await writeIdleFleetFixture()
  const service = new MobileControlSnapshotService()

  const result = await dispatchSnapshotRequest({
    command: snapshotRequestCommand('c-stale', { knownSnapshotVersion: 'snap_staleversion0000000' }),
    snapshotService: service,
    desktopSessionId: 'desktop_1',
    workspaceRootsProvider: async () => [workspaceRoot],
  })
  const data = okData<MobileControlSnapshot>(result)
  assert.equal(
    'unchanged' in (data as unknown as Record<string, unknown>),
    false,
    'a stale version must not trigger the fast path',
  )
  assert.equal((data.backlog ?? []).length >= 1, true, 'the full snapshot is returned')
  assert.equal(validateMobileControlSnapshot(data).ok, true, 'the fallback full snapshot still validates on the wire')
  service.shutdown()
}

// Acceptance (T2 #1): the measured before/after idle-read traffic. Both sizes are the
// real relay result-summary bytes (`relaySummaryByteLength(summarizeCommandResult(...))`)
// — what the relay actually stores and ships — for one idle foregrounded phone. The
// full read is the current steady-state cost; the unchanged read is the cost after
// item 1605 activates the item 1599 fast path.
async function assertUnchangedResultCollapsesIdleReadTraffic(): Promise<void> {
  const workspaceRoot = await writeIdleFleetFixture()
  const service = new MobileControlSnapshotService()

  const full = await dispatchSnapshotRequest({
    command: snapshotRequestCommand('c-measure-full', {}),
    snapshotService: service,
    desktopSessionId: 'desktop_1',
    workspaceRootsProvider: async () => [workspaceRoot],
  })
  const knownVersion = requireVersion(okData<MobileControlSnapshot>(full))
  const unchanged = await dispatchSnapshotRequest({
    command: snapshotRequestCommand('c-measure-unchanged', { knownSnapshotVersion: knownVersion }),
    snapshotService: service,
    desktopSessionId: 'desktop_1',
    workspaceRootsProvider: async () => [workspaceRoot],
  })

  const fullBytes = relaySummaryByteLength(summarizeCommandResult(full))
  const unchangedBytes = relaySummaryByteLength(summarizeCommandResult(unchanged))
  const pollsPerHour = 3600 / 20 // the phone's 20 s foreground re-pull cadence
  const savedPctPerRead = ((fullBytes - unchangedBytes) / fullBytes) * 100

  // Evidence line (T2 acceptance requires reported numbers, not a claim).
  console.log(
    `[1605-traffic] idle read: full=${fullBytes}B unchanged=${unchangedBytes}B ` +
      `saved=${savedPctPerRead.toFixed(1)}%/read ` +
      `perHour@20s: full=${Math.round((fullBytes * pollsPerHour) / 1024)}KiB/h ` +
      `unchanged=${Math.round((unchangedBytes * pollsPerHour) / 1024)}KiB/h`,
  )

  // Regression assertions: the fast path must be a small constant, and a large cut.
  assert.equal(unchangedBytes < 700, true, `unchanged result should be tiny, was ${unchangedBytes}B`)
  assert.equal(fullBytes > unchangedBytes * 4, true, 'the full idle read must be several times the unchanged read')
  assert.equal(
    savedPctPerRead > 80,
    true,
    `item 1605 should cut >80% of per-read idle bytes, cut ${savedPctPerRead.toFixed(1)}%`,
  )
  service.shutdown()
}

// One idle foregrounded phone's steady-state fleet: a working backlog and one
// scheduled automation — the shape a phone re-pulls every 20 s while nothing
// changes. It used to carry a live sprint run as well, which was the bulk of the
// payload; since MC-2575 the backlog is the bulk, so the fixture seeds a
// realistic number of items rather than the two that only ever existed to prove
// the collection was non-empty.
const idleFleetBacklogItems = 10

async function writeIdleFleetFixture(): Promise<string> {
  const root = await makeWorkspaceRoot()
  await mkdir(join(root, 'backlog'), { recursive: true })
  await mkdir(join(root, '.sprintengine', 'backlog'), { recursive: true })
  const items: Record<string, unknown>[] = []
  for (let index = 0; index < idleFleetBacklogItems; index += 1) {
    const itemId = `backlog_${String(index).padStart(2, '0')}`
    await writeFile(
      join(root, 'backlog', `${itemId}.md`),
      `---\ntype: feature\n---\n\n# Backlog item ${index}\n\nA sentence of body text the excerpt is cut from.\n`,
      'utf8',
    )
    items.push({
      id: itemId,
      source: { type: 'file', relativePath: `backlog/${itemId}.md` },
      status: index % 2 === 0 ? 'ready' : 'in_progress',
      type: 'feature',
      metadata: {},
      links: [],
      createdAt: generatedAtA,
      updatedAt: generatedAtA,
    })
  }
  await writeFile(
    join(root, '.sprintengine', 'backlog', 'items.json'),
    JSON.stringify({ schemaVersion: 1, items }),
    'utf8',
  )
  const store = new AutomationsStore(root)
  await store.createDefinition(automationDefinition('nightly', 'enabled'))
  return root
}

async function makeWorkspaceRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'multicode-snapshot-request-'))
}

// Overwrites the item record so a second call with a new status is a real backlog-only
// change (idempotent on id).
async function writeBacklogFixture(
  workspaceRoot: string,
  itemId: string,
  title: string,
  status: string,
): Promise<void> {
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
          status,
          type: 'feature',
          metadata: {},
          links: [],
          createdAt: generatedAtA,
          updatedAt: generatedAtA,
        },
      ],
    }),
    'utf8',
  )
}

function automationDefinition(id: string, status: 'enabled' | 'paused'): AutomationDefinition {
  return {
    id,
    name: 'Nightly sweep',
    status,
    // Interval cadence renders with no timezone suffix, so the automation projection
    // carries no wall-clock — the whole projection is content-only.
    trigger: {
      kind: 'schedule',
      config: { kind: 'schedule', cadence: { type: 'interval', everyMinutes: 90 }, timezone: 'UTC' },
    },
    action: { kind: 'agent-run', config: { prompt: 'sweep' } },
    nextRunAt: null,
    lastRunAt: generatedAtA,
    lastRunId: null,
    createdAt: generatedAtA,
    updatedAt: generatedAtA,
  }
}

function snapshotRequestCommand(commandId: string, payload: Record<string, unknown>): MobileControlCommand {
  return { type: 'snapshot.request', commandId, deviceId: 'device_1', payload } as never
}

function okData<T>(result: MobileControlCommandResult): T {
  assert.equal(result.ok, true, `command result must be ok: ${result.ok ? '' : JSON.stringify(result)}`)
  return (result.ok ? result.data : null) as T
}

function requireVersion(snapshot: MobileControlSnapshot): string {
  const version = snapshot.snapshotVersion
  assert.ok(typeof version === 'string' && version.length > 0, 'the full snapshot must carry a snapshotVersion')
  return version
}
