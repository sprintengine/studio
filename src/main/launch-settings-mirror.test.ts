/**
 * MC-2154 — the main-owned launch settings store. Real tmpdir, no Electron and
 * no window: every case here is the headless read path the scheduler and the
 * boot-time discovery sweep take.
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { AgentLaunchSettings } from '../shared/sprintengine/launch-settings'
import { parseAgentLaunchSettingsRecord } from '../shared/sprintengine/launch-settings'
import { createAgentLaunchSettingsMirror } from './launch-settings-mirror'

const FILE_NAME = 'agent-launch-settings.json'

function settings(overrides: Partial<AgentLaunchSettings> = {}): AgentLaunchSettings {
  return {
    cliRuntimes: { claude: { command: 'claude', useWsl: false } },
    mcp: { syncEnabled: true, servers: {} },
    projectKnowledgeRoots: { '/repo': 'knowledge' },
    lastSelectedCli: 'claude-code',
    lastAgentSpawnPermissionPreset: 'auto',
    sprintEngineRoleSettings: {
      enabled: {},
      savedRosters: [
        {
          id: 'roster-1',
          name: 'Pair',
          roleCounts: { developer: 2 },
          roleCliDefaults: { developer: 'claude-code' },
          createdAt: 1,
          updatedAt: 2,
        },
      ],
      lastSelectedRosterId: 'roster-1',
    },
    ...overrides,
  } as AgentLaunchSettings
}

type Harness = {
  userDataDir: string
  filePath: string
  diagnostics: Array<{ title: string; details?: string }>
  create: () => ReturnType<typeof createAgentLaunchSettingsMirror>
}

async function withHarness(body: (harness: Harness) => Promise<void>): Promise<void> {
  const userDataDir = await mkdtemp(join(tmpdir(), 'multicode-launch-settings-'))
  const diagnostics: Array<{ title: string; details?: string }> = []
  try {
    await body({
      userDataDir,
      filePath: join(userDataDir, FILE_NAME),
      diagnostics,
      // A fresh instance with the same userData dir is an app restart: no
      // in-memory state survives, only the file.
      create: () => createAgentLaunchSettingsMirror({
        resolveUserDataDir: () => userDataDir,
        logDiagnostic: (input) => diagnostics.push({ title: input.title, details: input.details }),
      }),
    })
  } finally {
    await rm(userDataDir, { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  await assertHeadlessReadSurvivesRestart()
  await assertRevisionMathAndIdempotentPushes()
  await assertAtomicWriteLeavesNoTempFile()
  await assertHydrateHappensExactlyOnce()
  await assertFreshInstallReadsDefaults()
  await assertLegacyBareSettingsFileStillReads()
  await assertUnwritableStoreKeepsInMemoryValues()
  await assertHalfFormedRostersAreDropped()
  console.log('sprintengine-launch-settings-mirror tests passed')
}

// (1) The acceptance case: main reads every launch input with zero windows,
// across a restart.
async function assertHeadlessReadSurvivesRestart(): Promise<void> {
  await withHarness(async (harness) => {
    const written = harness.create().set(settings())
    await written.persisted

    const afterRestart = harness.create()
    const read = afterRestart.get()
    assert.equal(read.lastSelectedCli, 'claude-code')
    assert.equal(read.lastAgentSpawnPermissionPreset, 'auto')
    assert.equal(read.mcp.syncEnabled, true)
    assert.equal(read.cliRuntimes.claude?.command, 'claude')
    assert.equal(read.sprintEngineRoleSettings.savedRosters?.[0]?.id, 'roster-1')
    assert.equal(read.sprintEngineRoleSettings.lastSelectedRosterId, 'roster-1')
    assert.equal(afterRestart.getRecord()?.revision, 1)
  })
}

// (2) Every content change is a new revision; an unchanged push is not.
async function assertRevisionMathAndIdempotentPushes(): Promise<void> {
  await withHarness(async (harness) => {
    const store = harness.create()
    const seen: string[] = []
    store.subscribe((next) => seen.push(next.lastSelectedCli ?? 'null'))

    const first = store.set(settings())
    assert.equal(first.record.revision, 1)
    assert.equal(first.changed, true)
    assert.equal(first.record.lastWrite.actor, 'ui')

    const repeat = store.set(settings())
    assert.equal(repeat.changed, false)
    assert.equal(repeat.record.revision, 1, 'an identical push must not bump the revision')

    const changed = store.set(settings({ lastSelectedCli: 'codex' }))
    assert.equal(changed.changed, true)
    assert.equal(changed.record.revision, 2)
    await changed.persisted

    assert.deepEqual(seen, ['claude-code', 'codex'], 'subscribers wake only on real changes')

    // The revision survives a restart, so a later writer never restarts the
    // counter and re-uses a revision a subscriber already applied.
    const afterRestart = harness.create()
    assert.equal(afterRestart.getRecord()?.revision, 2)
    const third = afterRestart.set(settings({ lastSelectedCli: 'claude-code' }))
    assert.equal(third.record.revision, 3)
    // Every write is awaited before the harness tears its directory down: a
    // write still in flight would race the cleanup.
    await third.persisted
  })
}

// (3) The write is atomic (tmp + rename) and leaves the target parseable.
async function assertAtomicWriteLeavesNoTempFile(): Promise<void> {
  await withHarness(async (harness) => {
    await harness.create().set(settings()).persisted
    const raw: unknown = JSON.parse(await readFile(harness.filePath, 'utf8'))
    const record = parseAgentLaunchSettingsRecord(raw)
    assert.ok(record, 'the persisted file parses as a current-schema record')
    assert.equal(record.settings.lastSelectedCli, 'claude-code')
    assert.deepEqual(await readdir(harness.userDataDir), [FILE_NAME], 'no temp file survives the write')
  })
}

// (4) Hydration seeds once and never overwrites main's own record — including
// across a restart, where a window's stale value must not win.
async function assertHydrateHappensExactlyOnce(): Promise<void> {
  await withHarness(async (harness) => {
    const store = harness.create()
    const seeded = store.hydrate(settings())
    assert.equal(seeded.changed, true)
    assert.equal(seeded.record.revision, 1)
    assert.equal(seeded.record.lastWrite.actor, 'system', 'a seed is not a user write')
    await seeded.persisted

    const again = store.hydrate(settings({ lastSelectedCli: 'stale' }))
    assert.equal(again.changed, false)
    assert.equal(again.record.settings.lastSelectedCli, 'claude-code')

    const afterRestart = harness.create()
    const rehydrate = afterRestart.hydrate(settings({ lastSelectedCli: 'stale' }))
    assert.equal(rehydrate.changed, false, 'hydration is once per store, not once per session')
    assert.equal(afterRestart.get().lastSelectedCli, 'claude-code')
  })
}

// (5) A fresh install (no file at all) reads sane defaults rather than throwing.
async function assertFreshInstallReadsDefaults(): Promise<void> {
  await withHarness(async (harness) => {
    const store = harness.create()
    const read = store.get()
    assert.equal(store.getRecord(), null)
    assert.equal(read.lastSelectedCli, null)
    assert.equal(read.lastAgentSpawnPermissionPreset, null)
    assert.deepEqual(read.cliRuntimes, {})
    assert.deepEqual(read.mcp, { syncEnabled: false, servers: {} })
    assert.deepEqual(read.sprintEngineRoleSettings, { enabled: {} })
  })
}

// (6) The pre-MC-2154 file held bare settings with no revision: it still reads
// (no regression for a scheduler booting straight after the upgrade), and the
// first push replaces it with a real record.
async function assertLegacyBareSettingsFileStillReads(): Promise<void> {
  await withHarness(async (harness) => {
    await writeFile(
      harness.filePath,
      JSON.stringify({
        cliRuntimes: { legacy: { command: 'legacy-cli', useWsl: false } },
        mcp: { syncEnabled: true, servers: {} },
        projectKnowledgeRoots: {},
      }),
      'utf8',
    )
    const store = harness.create()
    assert.equal(store.getRecord(), null, 'a bare settings file is readable but not authoritative')
    assert.equal(store.get().cliRuntimes.legacy?.command, 'legacy-cli')

    const upgraded = store.hydrate(settings())
    assert.equal(upgraded.changed, true)
    assert.equal(upgraded.record.revision, 1)
    await upgraded.persisted
    assert.equal(harness.create().get().lastSelectedCli, 'claude-code')
  })
}

// (7) A write failure is fail-soft: the in-memory value still serves reads and
// the failure is reported rather than swallowed.
async function assertUnwritableStoreKeepsInMemoryValues(): Promise<void> {
  await withHarness(async (harness) => {
    const store = createAgentLaunchSettingsMirror({
      // A path whose parent is a FILE, so mkdir/write cannot succeed.
      resolveUserDataDir: () => join(harness.filePath, 'nested'),
      logDiagnostic: (input) => harness.diagnostics.push({ title: input.title, details: input.details }),
    })
    await writeFile(harness.filePath, 'not a directory', 'utf8')
    const result = store.set(settings())
    await result.persisted
    assert.equal(store.get().lastSelectedCli, 'claude-code', 'in-memory values still apply')
    assert.equal(harness.diagnostics.length, 1)
    assert.equal(harness.diagnostics[0]?.title, 'Agent launch settings not persisted')
  })
}

// (8) A roster missing what resolution reads is dropped, not passed through:
// a headless launch resolving one would staff a phantom team.
async function assertHalfFormedRostersAreDropped(): Promise<void> {
  await withHarness(async (harness) => {
    const store = harness.create()
    const written = store.set({
      ...settings(),
      sprintEngineRoleSettings: {
        enabled: {},
        savedRosters: [
          { id: 'good', name: 'Good', roleCounts: { developer: 1 }, roleCliDefaults: { developer: 'claude-code' } },
          { id: 'no-clis', name: 'Half', roleCounts: { developer: 1 } },
          { name: 'No id', roleCounts: {}, roleCliDefaults: {} },
          'not an object',
        ],
      },
    })
    await written.persisted
    const rosters = store.get().sprintEngineRoleSettings.savedRosters
    assert.deepEqual(rosters?.map((roster) => roster.id), ['good'])
  })
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})
