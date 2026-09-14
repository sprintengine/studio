import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import type { DiagnosticLogInput } from '../shared/electron-api'
import type { SprintEngineAutomationIntentRecord } from '../shared/sprintengine/automation-intent'
import {
  createSprintEngineAutomationService,
  type SprintEngineAutomationChangedEvent,
} from './sprintengine-automation-service'

type Harness = {
  statePath: string
  intentPath: string
  broadcasts: SprintEngineAutomationChangedEvent[]
  diagnostics: DiagnosticLogInput[]
  runnerWrites: Array<{ statePath: string; cliWatchPolling: 'enabled' | 'disabled' }>
  hydrations: Array<{ statePath: string; record: SprintEngineAutomationIntentRecord }>
  service: ReturnType<typeof createSprintEngineAutomationService>
}

async function createHarness(root: string, options?: {
  failRunnerWrite?: boolean
  now?: () => number
}): Promise<Harness> {
  const teamDirectory = join(root, '.sprintengine', 'sprintengine', 'team')
  await mkdir(teamDirectory, { recursive: true })
  const statePath = join(teamDirectory, 'run.yaml')
  await writeFile(statePath, 'schemaVersion: 2\n', 'utf8')

  const broadcasts: SprintEngineAutomationChangedEvent[] = []
  const diagnostics: DiagnosticLogInput[] = []
  const runnerWrites: Array<{ statePath: string; cliWatchPolling: 'enabled' | 'disabled' }> = []
  const hydrations: Array<{ statePath: string; record: SprintEngineAutomationIntentRecord }> = []

  const service = createSprintEngineAutomationService({
    setRunnerCliWatchPolling: async (input) => {
      runnerWrites.push(input)
      return options?.failRunnerWrite ? { ok: false, message: 'engine unavailable' } : { ok: true }
    },
    logDiagnostic: (input) => diagnostics.push(input),
    broadcast: (event) => broadcasts.push(event),
    notifyHydrated: (statePath, record) => hydrations.push({ statePath, record }),
    ...(options?.now ? { now: options.now } : {}),
  })

  return {
    statePath,
    intentPath: join(teamDirectory, 'automation.json'),
    broadcasts,
    diagnostics,
    runnerWrites,
    hydrations,
    service,
  }
}

async function withTempRoot(body: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'multicode-automation-service-'))
  try {
    await body(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function flushMicrotasks(): Promise<void> {
  // The cliWatchPolling bridge is deliberately fire-and-forget; give its
  // promise chain a couple of turns to settle before asserting on it.
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

async function main(): Promise<void> {
  // set-mode: persists, bumps revision, broadcasts, bridges cliWatchPolling
  await withTempRoot(async (root) => {
    const harness = await createHarness(root)
    const first = await harness.service.setAutomationMode({
      statePath: harness.statePath,
      mode: 'run_agents',
      actor: 'ui',
    })
    assert.ok(first.ok && first.changed)
    assert.equal(first.record.revision, 1)
    assert.equal(first.record.desiredMode, 'run_agents')
    assert.equal(first.record.lastWrite.actor, 'ui')

    const onDisk = JSON.parse(await readFile(harness.intentPath, 'utf8'))
    assert.equal(onDisk.desiredMode, 'run_agents')
    assert.equal(onDisk.revision, 1)

    assert.equal(harness.broadcasts.length, 1)
    assert.equal(harness.broadcasts[0].statePath, harness.statePath)
    assert.equal(harness.broadcasts[0].record.revision, 1)

    await flushMicrotasks()
    assert.deepEqual(harness.runnerWrites, [
      { statePath: harness.statePath, cliWatchPolling: 'enabled' },
    ])

    const second = await harness.service.setAutomationMode({
      statePath: harness.statePath,
      mode: 'run_agents_and_approve_artifacts',
      actor: 'mobile',
      deviceId: 'device-9',
    })
    assert.ok(second.ok && second.changed)
    assert.equal(second.record.revision, 2)
    assert.equal(second.record.lastWrite.actor, 'mobile')
    assert.equal(second.record.lastWrite.deviceId, 'device-9')
    assert.equal(harness.broadcasts.length, 2)
  })

  // set-mode: same-mode write is an idempotent no-op (no revision bump, no
  // broadcast, no audit — an echo must not look like a new transition)
  await withTempRoot(async (root) => {
    const harness = await createHarness(root)
    await harness.service.setAutomationMode({ statePath: harness.statePath, mode: 'run_agents', actor: 'ui' })
    const repeat = await harness.service.setAutomationMode({
      statePath: harness.statePath,
      mode: 'run_agents',
      actor: 'mobile',
    })
    assert.ok(repeat.ok)
    assert.equal(repeat.changed, false)
    assert.equal(repeat.record.revision, 1)
    assert.equal(harness.broadcasts.length, 1)
    await flushMicrotasks()
    assert.equal(harness.runnerWrites.length, 1)
  })

  // audit: emitted only on a non-manual -> manual transition, with the shared
  // title and previous-mode label; suppressed by the flag; never on the way up
  await withTempRoot(async (root) => {
    const harness = await createHarness(root)
    await harness.service.setAutomationMode({ statePath: harness.statePath, mode: 'run_agents', actor: 'ui' })
    assert.equal(harness.diagnostics.filter((d) => d.title === 'Auto-run mode changed').length, 0,
      'enabling automation is not a manual-transition audit')

    await harness.service.setAutomationMode({
      statePath: harness.statePath,
      mode: 'manual',
      actor: 'mobile',
      deviceId: 'device-3',
      reason: 'Paused from the phone.',
    })
    const audits = harness.diagnostics.filter((d) => d.title === 'Auto-run mode changed')
    assert.equal(audits.length, 1)
    assert.equal(audits[0].source, 'sprintengine')
    assert.equal(audits[0].message, 'Manual: Paused from the phone.')
    assert.ok(audits[0].details?.includes('Previous mode: Run agents'))
    assert.ok(audits[0].details?.includes('Writer: mobile (device-3)'))

    // manual -> manual is not audited (already manual)
    await harness.service.setAutomationMode({ statePath: harness.statePath, mode: 'manual', actor: 'ui' })
    assert.equal(harness.diagnostics.filter((d) => d.title === 'Auto-run mode changed').length, 1)

    // suppressed audit
    await harness.service.setAutomationMode({ statePath: harness.statePath, mode: 'run_agents', actor: 'ui' })
    await harness.service.setAutomationMode({
      statePath: harness.statePath,
      mode: 'manual',
      actor: 'ui',
      suppressManualAudit: true,
    })
    assert.equal(harness.diagnostics.filter((d) => d.title === 'Auto-run mode changed').length, 1)
  })

  // cliWatchPolling bridge failure: warn-only (workspace-scoped), mode write
  // still succeeds — and a same-mode re-select RETRIES the bridge (the old UI
  // could retry by re-toggling; a failure must not be unrecoverable).
  await withTempRoot(async (root) => {
    const harness = await createHarness(root, { failRunnerWrite: true })
    const result = await harness.service.setAutomationMode({
      statePath: harness.statePath,
      mode: 'run_agents',
      actor: 'ui',
      workspaceId: 'ws-bridge',
      workspaceName: 'Bridge Test',
    })
    assert.ok(result.ok)
    await flushMicrotasks()
    const warnings = harness.diagnostics.filter((d) => d.title === 'Runner polling flag not updated')
    assert.equal(warnings.length, 1)
    assert.equal(warnings[0].level, 'warning')
    assert.equal(warnings[0].workspaceId, 'ws-bridge')
    assert.equal(warnings[0].workspaceName, 'Bridge Test')

    const repeat = await harness.service.setAutomationMode({
      statePath: harness.statePath,
      mode: 'run_agents',
      actor: 'ui',
    })
    assert.ok(repeat.ok)
    assert.equal(repeat.changed, false)
    await flushMicrotasks()
    assert.equal(harness.runnerWrites.length, 2, 'same-mode write retries a failed bridge')
  })

  // Bridge success is remembered: a same-mode write does not re-run it.
  await withTempRoot(async (root) => {
    const harness = await createHarness(root)
    await harness.service.setAutomationMode({ statePath: harness.statePath, mode: 'run_agents', actor: 'ui' })
    await flushMicrotasks()
    await harness.service.setAutomationMode({ statePath: harness.statePath, mode: 'run_agents', actor: 'ui' })
    await flushMicrotasks()
    assert.equal(harness.runnerWrites.length, 1, 'bridged value is cached after success')
  })

  // clientToken rides the broadcast so the pushing window can drop its echo;
  // absent for writers that don't supply one.
  await withTempRoot(async (root) => {
    const harness = await createHarness(root)
    await harness.service.setAutomationMode({
      statePath: harness.statePath,
      mode: 'run_agents',
      actor: 'ui',
      clientToken: 'window-42',
    })
    await harness.service.setAutomationMode({
      statePath: harness.statePath,
      mode: 'manual',
      actor: 'mobile',
    })
    assert.equal(harness.broadcasts[0].sourceClientToken, 'window-42')
    assert.equal(harness.broadcasts[1].sourceClientToken, undefined)
  })

  // taskId/agentId audit parity: a manual transition carrying task context
  // gets the deep-linkable navigationTarget the old renderer audit offered.
  await withTempRoot(async (root) => {
    const harness = await createHarness(root)
    await harness.service.setAutomationMode({ statePath: harness.statePath, mode: 'run_agents', actor: 'ui' })
    await harness.service.setAutomationMode({
      statePath: harness.statePath,
      mode: 'manual',
      actor: 'ui',
      taskId: 'T7',
      agentId: 'developer-1',
    })
    const audit = harness.diagnostics.find((d) => d.title === 'Auto-run mode changed')
    assert.ok(audit)
    assert.equal(audit.taskId, 'T7')
    assert.equal(audit.agentId, 'developer-1')
    assert.deepEqual(audit.navigationTarget, { kind: 'task', ref: 'T7' })
  })

  // hydrate: seeds only when absent; no audit, no runner bridge, no broadcast
  await withTempRoot(async (root) => {
    const harness = await createHarness(root)
    const seeded = await harness.service.hydrateAutomationMode({
      statePath: harness.statePath,
      mode: 'run_agents_and_approve_artifacts',
    })
    assert.ok(seeded.ok && seeded.changed)
    assert.equal(seeded.record.desiredMode, 'run_agents_and_approve_artifacts')
    assert.equal(seeded.record.lastWrite.actor, 'system')
    assert.equal(harness.broadcasts.length, 0)
    await flushMicrotasks()
    assert.equal(harness.runnerWrites.length, 0)
    assert.equal(harness.diagnostics.length, 0)
    // The scheduler still learns the seeded mode (no window broadcast, but the
    // run must not sit at 'manual' in main forever).
    assert.equal(harness.hydrations.length, 1)
    assert.equal(harness.hydrations[0]?.statePath, harness.statePath)
    assert.equal(harness.hydrations[0]?.record.desiredMode, 'run_agents_and_approve_artifacts')

    const again = await harness.service.hydrateAutomationMode({
      statePath: harness.statePath,
      mode: 'manual',
    })
    assert.ok(again.ok)
    assert.equal(again.changed, false)
    assert.equal(again.record.desiredMode, 'run_agents_and_approve_artifacts',
      'a second hydration never overwrites the first')
    assert.equal(harness.hydrations.length, 1, 'an unchanged hydration never re-notifies the scheduler')
  })

  // set-permission-preset (MC-1799): persists beside the mode, bumps the shared
  // revision, broadcasts, and round-trips through read.
  await withTempRoot(async (root) => {
    const harness = await createHarness(root)
    const written = await harness.service.setCliPermissionPreset({
      statePath: harness.statePath,
      preset: 'bypass',
      actor: 'ui',
      clientToken: 'window-7',
    })
    assert.ok(written.ok && written.changed)
    assert.equal(written.record.revision, 1)
    assert.equal(written.record.cliPermissionPreset, 'bypass')
    assert.equal(written.record.desiredMode, 'manual', 'a preset write never invents a mode')

    const onDisk = JSON.parse(await readFile(harness.intentPath, 'utf8'))
    assert.equal(onDisk.cliPermissionPreset, 'bypass')
    assert.equal(onDisk.schemaVersion, 1, 'an additive optional field is not a schema bump')

    assert.equal(harness.broadcasts.length, 1)
    assert.equal(harness.broadcasts[0].record.cliPermissionPreset, 'bypass')
    assert.equal(harness.broadcasts[0].sourceClientToken, 'window-7')

    const read = await harness.service.readAutomationMode({ statePath: harness.statePath })
    assert.ok(read.ok && read.record)
    assert.equal(read.record.cliPermissionPreset, 'bypass')

    // Same preset again: idempotent, like a same-mode write.
    const repeat = await harness.service.setCliPermissionPreset({
      statePath: harness.statePath,
      preset: 'bypass',
      actor: 'ui',
    })
    assert.ok(repeat.ok)
    assert.equal(repeat.changed, false)
    assert.equal(repeat.record.revision, 1)
    assert.equal(harness.broadcasts.length, 1)

    // A later mode write carries the preset forward untouched.
    const mode = await harness.service.setAutomationMode({
      statePath: harness.statePath,
      mode: 'run_agents',
      actor: 'ui',
    })
    assert.ok(mode.ok && mode.changed)
    assert.equal(mode.record.revision, 2)
    assert.equal(mode.record.cliPermissionPreset, 'bypass')

    const changed = await harness.service.setCliPermissionPreset({
      statePath: harness.statePath,
      preset: 'auto',
      actor: 'ui',
    })
    assert.ok(changed.ok && changed.changed)
    assert.equal(changed.record.revision, 3)
    assert.equal(changed.record.desiredMode, 'run_agents', 'a preset write never moves the mode')
    // Two preset changes + one mode change; the idempotent repeat broadcast nothing.
    assert.equal(harness.broadcasts.length, 3)

    // Neither the manual audit nor the runner bridge belongs to a preset write.
    await flushMicrotasks()
    assert.equal(harness.runnerWrites.length, 1, 'only the mode write bridges cliWatchPolling')
    assert.equal(harness.diagnostics.length, 0)

    const badPreset = await harness.service.setCliPermissionPreset({
      statePath: harness.statePath,
      preset: 'yolo' as never,
      actor: 'ui',
    })
    assert.equal(badPreset.ok, false)
  })

  // A record written before MC-1799 carries no preset: it still loads, the mode
  // still round-trips, and the first preset write adds the field.
  await withTempRoot(async (root) => {
    const harness = await createHarness(root)
    await writeFile(harness.intentPath, `${JSON.stringify({
      schemaVersion: 1,
      revision: 4,
      desiredMode: 'run_agents',
      changedAt: 1700000000000,
      lastWrite: { actor: 'ui', deviceId: null, at: '2026-07-20T00:00:00.000Z' },
    }, null, 2)}\n`, 'utf8')

    const read = await harness.service.readAutomationMode({ statePath: harness.statePath })
    assert.ok(read.ok && read.record)
    assert.equal(read.record.desiredMode, 'run_agents')
    assert.equal(read.record.cliPermissionPreset, undefined)

    // Hydration against an existing record hands the workspace main's record —
    // the path a workspace attaching after a door-mount preset write takes.
    const hydrated = await harness.service.hydrateAutomationMode({
      statePath: harness.statePath,
      mode: 'manual',
    })
    assert.ok(hydrated.ok)
    assert.equal(hydrated.changed, false)
    assert.equal(hydrated.record.cliPermissionPreset, undefined)

    const written = await harness.service.setCliPermissionPreset({
      statePath: harness.statePath,
      preset: 'manual',
      actor: 'ui',
    })
    assert.ok(written.ok && written.changed)
    assert.equal(written.record.revision, 5)
    assert.equal(written.record.desiredMode, 'run_agents')
    assert.equal(written.record.cliPermissionPreset, 'manual')

    const rehydrated = await harness.service.hydrateAutomationMode({
      statePath: harness.statePath,
      mode: 'manual',
    })
    assert.ok(rehydrated.ok)
    assert.equal(rehydrated.record.cliPermissionPreset, 'manual',
      'a workspace attaching later reads the persisted preset back')
  })

  // read: null before any write; the record after
  await withTempRoot(async (root) => {
    const harness = await createHarness(root)
    const empty = await harness.service.readAutomationMode({ statePath: harness.statePath })
    assert.ok(empty.ok)
    assert.equal(empty.record, null)

    await harness.service.setAutomationMode({ statePath: harness.statePath, mode: 'manual', actor: 'ui' })
    // manual as the FIRST write still creates the record (revision 1)
    const read = await harness.service.readAutomationMode({ statePath: harness.statePath })
    assert.ok(read.ok && read.record)
    assert.equal(read.record.desiredMode, 'manual')
    assert.equal(read.record.revision, 1)
  })

  // corrupt sidecar: treated as absent; the next write recreates it
  await withTempRoot(async (root) => {
    const harness = await createHarness(root)
    await writeFile(harness.intentPath, '{not json', 'utf8')
    const read = await harness.service.readAutomationMode({ statePath: harness.statePath })
    assert.ok(read.ok)
    assert.equal(read.record, null)
    const write = await harness.service.setAutomationMode({
      statePath: harness.statePath,
      mode: 'run_agents',
      actor: 'ui',
    })
    assert.ok(write.ok)
    assert.equal(write.record.revision, 1)
  })

  // path validation: rejects non-run.yaml paths and missing team dirs
  await withTempRoot(async (root) => {
    const harness = await createHarness(root)
    const badName = await harness.service.setAutomationMode({
      statePath: join(root, 'not-run.yaml'),
      mode: 'manual',
      actor: 'ui',
    })
    assert.equal(badName.ok, false)
    const missingDir = await harness.service.setAutomationMode({
      statePath: join(root, 'missing', 'run.yaml'),
      mode: 'manual',
      actor: 'ui',
    })
    assert.equal(missingDir.ok, false)
    const badMode = await harness.service.setAutomationMode({
      statePath: harness.statePath,
      mode: 'sprint' as never,
      actor: 'ui',
    })
    assert.equal(badMode.ok, false)
  })

  // write serialization: concurrent writes for one run land as sequential
  // revisions with a valid final record (no interleaved read-modify-write)
  await withTempRoot(async (root) => {
    const harness = await createHarness(root)
    const [a, b, c] = await Promise.all([
      harness.service.setAutomationMode({ statePath: harness.statePath, mode: 'run_agents', actor: 'ui' }),
      harness.service.setAutomationMode({ statePath: harness.statePath, mode: 'manual', actor: 'mobile' }),
      harness.service.setAutomationMode({ statePath: harness.statePath, mode: 'run_agents_and_approve_artifacts', actor: 'ui' }),
    ])
    assert.ok(a.ok && b.ok && c.ok)
    const revisions = [a, b, c].map((result) => (result.ok ? result.record.revision : -1)).sort()
    assert.deepEqual(revisions, [1, 2, 3])
    const final = await harness.service.readAutomationMode({ statePath: harness.statePath })
    assert.ok(final.ok && final.record)
    assert.equal(final.record.revision, 3)
    assert.equal(final.record.desiredMode, 'run_agents_and_approve_artifacts')
  })

  // queue error path: a failed write does not wedge the per-run queue — the
  // next write proceeds and lands cleanly.
  await withTempRoot(async (root) => {
    const harness = await createHarness(root)
    await rm(dirname(harness.intentPath), { recursive: true, force: true })
    // Recreate as a FILE so the sidecar write (into a non-directory) fails
    // while the path-validation existsSync check still passes.
    await writeFile(dirname(harness.intentPath), 'not a directory', 'utf8')
    const failed = await harness.service.setAutomationMode({
      statePath: harness.statePath,
      mode: 'run_agents',
      actor: 'ui',
    })
    assert.equal(failed.ok, false)
    await rm(dirname(harness.intentPath), { force: true })
    await mkdir(dirname(harness.intentPath), { recursive: true })
    const recovered = await harness.service.setAutomationMode({
      statePath: harness.statePath,
      mode: 'run_agents',
      actor: 'ui',
    })
    assert.ok(recovered.ok && recovered.changed)
    assert.equal(recovered.record.revision, 1)
  })

  // concurrent hydrate + set through the queue: the set's write wins the final
  // state; hydrate never overwrites and never audits.
  await withTempRoot(async (root) => {
    const harness = await createHarness(root)
    const [hydrated, set] = await Promise.all([
      harness.service.hydrateAutomationMode({ statePath: harness.statePath, mode: 'run_agents' }),
      harness.service.setAutomationMode({ statePath: harness.statePath, mode: 'manual', actor: 'mobile' }),
    ])
    assert.ok(hydrated.ok && set.ok)
    const final = await harness.service.readAutomationMode({ statePath: harness.statePath })
    assert.ok(final.ok && final.record)
    assert.equal(final.record.desiredMode, 'manual')
    assert.equal(final.record.revision, 2)
  })

  console.log('sprintengine-automation-service tests passed')
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})
