import assert from 'node:assert/strict'
import { readdir } from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SPRINT_ENGINE_RUN_LANDED_TRIGGER_KIND } from '../../shared/automations/contracts'
import { SPRINT_ENGINE_START_ACTION_KIND } from './actions/sprint-engine'
import { createDefinitionWriteCore, parseDefinitionDraft, parseDefinitionPatch } from './definition-write'
import { allowAutomationProvider, createBuiltInAutomationProviderRegistry } from './provider-registry'
import { validateScheduleTriggerConfig } from './schedule'
import { AutomationsStore } from './store'

function draftInput(overrides: {
  triggerKind: string
  actionKind: string
  disableAfterRun?: boolean
}): Record<string, unknown> {
  return {
    name: 'Chain',
    status: 'enabled',
    trigger: { kind: overrides.triggerKind, config: { kind: overrides.triggerKind, team: 'team-a' } },
    action: { kind: overrides.actionKind, config: { backlogItem: 'backlog/next.md' } },
    ...(overrides.disableAfterRun === undefined ? {} : { disableAfterRun: overrides.disableAfterRun }),
  }
}

function assertLandedStartPairDefaultsToRunOnce(): void {
  const result = parseDefinitionDraft(draftInput({
    triggerKind: SPRINT_ENGINE_RUN_LANDED_TRIGGER_KIND,
    actionKind: SPRINT_ENGINE_START_ACTION_KIND,
  }))
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.value.disableAfterRun, true, 'a landed→start chain fires once by default to bound ping-pong')
}

function assertExplicitFalseOptsOut(): void {
  const result = parseDefinitionDraft(draftInput({
    triggerKind: SPRINT_ENGINE_RUN_LANDED_TRIGGER_KIND,
    actionKind: SPRINT_ENGINE_START_ACTION_KIND,
    disableAfterRun: false,
  }))
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.value.disableAfterRun, false, 'an explicit choice wins over the default — opt-out, not a lock')
}

function assertOtherPairsAreUnaffected(): void {
  // A different action under the same trigger keeps the field absent (no default).
  const result = parseDefinitionDraft(draftInput({
    triggerKind: SPRINT_ENGINE_RUN_LANDED_TRIGGER_KIND,
    actionKind: 'spawn-agent',
  }))
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.value.disableAfterRun, undefined, 'only the landed→start pair defaults to run-once')
}

function assertRetiredAutonomyFieldIsIgnoredNotRejected(): void {
  // An MCP caller or module written against the old draft shape still sends
  // `autonomyDefault`. Rejecting would break those callers over a field that no
  // longer means anything, so the parse accepts the draft and drops the key.
  const result = parseDefinitionDraft({
    ...draftInput({ triggerKind: 'schedule', actionKind: 'spawn-agent' }),
    trigger: { kind: 'schedule', config: { kind: 'schedule', cadence: { type: 'interval', everyMinutes: 30 }, timezone: 'UTC' } },
    autonomyDefault: 'review_only',
  })
  assert.equal(result.ok, true, 'a draft carrying the retired field still parses')
  if (!result.ok) return
  assert.equal(Object.hasOwn(result.value, 'autonomyDefault'), false, 'the retired field is not carried into the draft')

  const patch = parseDefinitionPatch({ name: 'Renamed', autonomyDefault: 'allow_changes' })
  assert.equal(patch.ok, true, 'a patch carrying the retired field still parses')
  if (!patch.ok) return
  assert.equal(patch.value.name, 'Renamed', 'the rest of the patch is applied')
  assert.equal(Object.hasOwn(patch.value, 'autonomyDefault'), false, 'the retired field is not carried into the patch')
}

// ── Catalogue install (marketplace "Get") ────────────────────────────────────

const CATALOGUE_PAYLOAD = {
  // The author's own id: it names the template, never the record the store
  // issues, or two projects adding this starter would fight over one file.
  id: 'nightly-dependency-sweep',
  name: 'Nightly dependency sweep',
  // Ships paused; the ruling is that an added automation arrives on.
  status: 'paused',
  trigger: { kind: 'schedule', config: { kind: 'schedule', cadence: { type: 'daily', timeLocal: '03:00' }, timezone: 'UTC' } },
  action: { kind: 'spawn-agent', config: { prompt: 'Check for outdated dependencies.' } },
}

function catalogueWriteCore(now = Date.parse('2026-07-30T12:00:00.000Z'), hostTimeZone?: () => string) {
  const registry = createBuiltInAutomationProviderRegistry()
  const changed: string[] = []
  const core = createDefinitionWriteCore({
    createStore: (workspaceRoot) => new AutomationsStore(workspaceRoot),
    getTriggerProviderRegistrations: () => registry.listTriggerProviderRegistrations(),
    getActionProviderRegistrations: () => registry.listActionProviderRegistrations(),
    checkProviderPermission: allowAutomationProvider,
    now: () => now,
    ...(hostTimeZone ? { hostTimeZone } : {}),
    onDefinitionsChanged: (workspaceRoot) => {
      changed.push(workspaceRoot)
    },
  })
  return { core, changed }
}

async function withProjectRoots<T>(count: number, fn: (roots: string[]) => Promise<T>): Promise<T> {
  const roots: string[] = []
  for (let index = 0; index < count; index += 1) {
    roots.push(await mkdtemp(join(tmpdir(), 'mc-automation-install-')))
  }
  try {
    return await fn(roots)
  } finally {
    for (const root of roots) await rm(root, { recursive: true, force: true })
  }
}

async function definitionFiles(workspaceRoot: string): Promise<string[]> {
  return readdir(join(workspaceRoot, '.multi-code', 'automations', 'definitions')).catch(() => [])
}

async function assertInstallCreatesOneEnabledDefinitionWithProvenance(): Promise<void> {
  await withProjectRoots(1, async ([root]) => {
    const { core, changed } = catalogueWriteCore()
    const installed = await core.installFromCatalogue(root, {
      payload: CATALOGUE_PAYLOAD,
      sourceCatalogueId: 'multicode.nightly-sweep',
      sourcePublisher: 'Multicode Labs',
    })

    assert.equal(installed.ok, true, installed.ok ? '' : installed.message)
    if (!installed.ok) return
    const definition = installed.value.definition
    assert.equal(installed.value.alreadyAdded, false)
    assert.equal(definition.status, 'enabled', 'an added automation arrives on, whatever the payload said')
    assert.equal(definition.runInWorktree, undefined, 'left absent, which is the contract\'s "run in a worktree"')
    assert.notEqual(definition.id, 'multicode.nightly-sweep', 'the catalogue id is never the automation id')
    assert.notEqual(definition.id, CATALOGUE_PAYLOAD.id, 'the payload id is a template name, not the store id')
    assert.equal(definition.sourceCatalogueId, 'multicode.nightly-sweep')
    assert.equal(definition.sourcePublisher, 'Multicode Labs')
    assert.equal(definition.ownerModuleId, undefined, 'a catalogue automation is the user\'s, not a module\'s')
    assert.equal(definition.nextRunAt !== null, true, 'the definition is scheduled at install, not at the next restart')
    assert.deepEqual(changed, [root], 'the definitions-changed hook fires so open surfaces refresh')

    assert.deepEqual(await definitionFiles(root), [`${definition.id}.json`])
    const stored = await new AutomationsStore(root).getDefinition(definition.id)
    assert.equal(stored.ok, true)
    if (!stored.ok) return
    assert.equal(stored.value.sourceCatalogueId, 'multicode.nightly-sweep', 'provenance round-trips through the store')
  })
}

// A shelf item cannot opt a user out of run isolation on their behalf: without
// a worktree an unattended agent runs in the user's own checkout, with no branch
// and so no pull request (architect ruling, 2026-07-30).
async function assertCatalogueCannotOptOutOfWorktreeIsolation(): Promise<void> {
  await withProjectRoots(1, async ([root]) => {
    const { core } = catalogueWriteCore()
    const installed = await core.installFromCatalogue(root, {
      payload: { ...CATALOGUE_PAYLOAD, runInWorktree: false },
      sourceCatalogueId: 'multicode.uncontained',
    })

    assert.equal(installed.ok, true, installed.ok ? '' : installed.message)
    if (!installed.ok) return
    assert.equal(installed.value.definition.runInWorktree, undefined, 'a payload-supplied false is dropped, never honoured')

    const stored = await new AutomationsStore(root).getDefinition(installed.value.definition.id)
    assert.equal(stored.ok, true)
    if (!stored.ok) return
    assert.notEqual(stored.value.runInWorktree, false, 'and nothing on disk says false either')
  })
}

async function assertSecondInstallIntoSameProjectAddsNothing(): Promise<void> {
  await withProjectRoots(1, async ([root]) => {
    const { core } = catalogueWriteCore()
    const first = await core.installFromCatalogue(root, { payload: CATALOGUE_PAYLOAD, sourceCatalogueId: 'multicode.nightly-sweep' })
    const second = await core.installFromCatalogue(root, { payload: CATALOGUE_PAYLOAD, sourceCatalogueId: 'multicode.nightly-sweep' })

    assert.equal(first.ok && second.ok, true)
    if (!first.ok || !second.ok) return
    assert.equal(second.value.alreadyAdded, true, 'the second Get reports the entry as already added')
    assert.equal(second.value.definition.id, first.value.definition.id, 'and resolves the record already there')
    assert.equal((await definitionFiles(root)).length, 1, 'nothing was written a second time')
  })
}

async function assertSameEntryInstallsIndependentlyIntoTwoProjects(): Promise<void> {
  await withProjectRoots(2, async ([first, second]) => {
    const { core } = catalogueWriteCore()
    const one = await core.installFromCatalogue(first, { payload: CATALOGUE_PAYLOAD, sourceCatalogueId: 'multicode.nightly-sweep' })
    const two = await core.installFromCatalogue(second, { payload: CATALOGUE_PAYLOAD, sourceCatalogueId: 'multicode.nightly-sweep' })

    assert.equal(one.ok && two.ok, true)
    if (!one.ok || !two.ok) return
    assert.equal(two.value.alreadyAdded, false, 'a different project is not "already added"')
    assert.notEqual(one.value.definition.id, two.value.definition.id, 'each project gets its own store-issued id')
    assert.equal((await definitionFiles(first)).length, 1)
    assert.equal((await definitionFiles(second)).length, 1)
  })
}

async function assertMalformedPayloadWritesNothing(): Promise<void> {
  await withProjectRoots(1, async ([root]) => {
    const { core, changed } = catalogueWriteCore()
    const result = await core.installFromCatalogue(root, {
      payload: { name: 'No trigger', action: { kind: 'spawn-agent', config: {} } },
      sourceCatalogueId: 'multicode.broken',
    })

    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.code, 'invalid_input')
    assert.deepEqual(await definitionFiles(root), [], 'a payload that does not parse leaves no partial record')
    assert.deepEqual(changed, [], 'and nothing downstream is told anything changed')
  })
}

async function assertUnknownTriggerProviderWritesNothing(): Promise<void> {
  await withProjectRoots(1, async ([root]) => {
    const { core } = catalogueWriteCore()
    const result = await core.installFromCatalogue(root, {
      payload: { ...CATALOGUE_PAYLOAD, trigger: { kind: 'not-a-provider', config: {} } },
      sourceCatalogueId: 'multicode.unknown-trigger',
    })

    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.code, 'unknown_trigger')
    assert.deepEqual(await definitionFiles(root), [], 'provider validation runs before the write, as it does for the panel')
  })
}

// ── Catalogue schedules are local to whoever adds them (item 2039) ───────────

// The payload's zone is the author's, and every starter ships UTC — so before
// this, "nightly at 03:00" fired at 03:00 UTC, which is 13:00 in Sydney.
const SYDNEY = () => 'Australia/Sydney'

function storedSchedule(definition: { trigger: { config: unknown } }): { timezone: string; cadence: unknown } {
  const validated = validateScheduleTriggerConfig(definition.trigger.config)
  assert.ok(validated.ok, 'an installed schedule must validate')
  return { timezone: validated.value.timezone, cadence: validated.value.cadence }
}

async function assertInstallResolvesTheCadenceIntoTheInstallingUsersZone(): Promise<void> {
  await withProjectRoots(1, async ([root]) => {
    const { core } = catalogueWriteCore(undefined, SYDNEY)
    const installed = await core.installFromCatalogue(root, {
      payload: CATALOGUE_PAYLOAD,
      sourceCatalogueId: 'multicode.nightly-sweep',
    })

    assert.equal(installed.ok, true, installed.ok ? '' : installed.message)
    if (!installed.ok) return
    const schedule = storedSchedule(installed.value.definition)
    assert.equal(schedule.timezone, 'Australia/Sydney', 'the installing user\'s zone, not the payload\'s')
    assert.deepEqual(schedule.cadence, { type: 'daily', timeLocal: '03:00' }, 'the authored wall-clock is untouched')

    // 03:00 Sydney (UTC+10 in July) after 2026-07-30T12:00Z — not the 03:00 UTC
    // the payload would have produced.
    assert.equal(installed.value.definition.nextRunAt, '2026-07-30T17:00:00.000Z', 'it fires at 03:00 where the user is')
    assert.notEqual(installed.value.definition.nextRunAt, '2026-07-31T03:00:00.000Z')

    const stored = await new AutomationsStore(root).getDefinition(installed.value.definition.id)
    assert.equal(stored.ok, true)
    if (!stored.ok) return
    assert.equal(storedSchedule(stored.value).timezone, 'Australia/Sydney', 'and that is what is on disk')
  })
}

// A one-shot `at` is a local wall-clock like daily/weekly, not a fixed global
// instant: a catalogue payload is a template every reader installs at a
// different moment, so there is no single instant its author could have meant.
async function assertOneShotAndIntervalFollowTheSameOneRule(): Promise<void> {
  await withProjectRoots(2, async ([oneShotRoot, intervalRoot]) => {
    const { core } = catalogueWriteCore(undefined, SYDNEY)

    const oneShot = await core.installFromCatalogue(oneShotRoot, {
      payload: {
        ...CATALOGUE_PAYLOAD,
        trigger: {
          kind: 'schedule',
          config: { kind: 'schedule', cadence: { type: 'at', datetime: '2026-08-01T09:00' }, timezone: 'UTC' },
        },
      },
      sourceCatalogueId: 'multicode.one-shot',
    })
    assert.equal(oneShot.ok, true, oneShot.ok ? '' : oneShot.message)
    if (!oneShot.ok) return
    assert.equal(storedSchedule(oneShot.value.definition).timezone, 'Australia/Sydney', 'an `at` is localised too')
    // 09:00 Sydney on 1 August, not 09:00 UTC.
    assert.equal(oneShot.value.definition.nextRunAt, '2026-07-31T23:00:00.000Z')

    // An interval names no wall-clock, so localising its zone changes nothing
    // about when it runs — it is rewritten anyway rather than special-cased.
    const interval = await core.installFromCatalogue(intervalRoot, {
      payload: {
        ...CATALOGUE_PAYLOAD,
        trigger: {
          kind: 'schedule',
          config: { kind: 'schedule', cadence: { type: 'interval', everyMinutes: 30 }, timezone: 'UTC' },
        },
      },
      sourceCatalogueId: 'multicode.interval',
    })
    assert.equal(interval.ok, true, interval.ok ? '' : interval.message)
    if (!interval.ok) return
    assert.equal(storedSchedule(interval.value.definition).timezone, 'Australia/Sydney')
    assert.equal(interval.value.definition.nextRunAt, '2026-07-30T12:30:00.000Z', 'the cadence is unaffected')
  })
}

// The resolution is an install default, not a read rule: once the record is the
// user's, their own edit is the only thing that moves it.
async function assertAUsersOwnEditIsNeverRelocalised(): Promise<void> {
  await withProjectRoots(1, async ([root]) => {
    const { core } = catalogueWriteCore(undefined, SYDNEY)
    const installed = await core.installFromCatalogue(root, {
      payload: CATALOGUE_PAYLOAD,
      sourceCatalogueId: 'multicode.nightly-sweep',
    })
    assert.equal(installed.ok, true, installed.ok ? '' : installed.message)
    if (!installed.ok) return

    // The user moves it to a zone that is not theirs — a deliberate choice the
    // app must not correct.
    const edited = await core.update(root, installed.value.definition.id, {
      trigger: {
        kind: 'schedule',
        config: { kind: 'schedule', cadence: { type: 'daily', timeLocal: '09:15' }, timezone: 'Europe/Dublin' },
      },
    })
    assert.equal(edited.ok, true, edited.ok ? '' : edited.message)
    if (!edited.ok) return
    assert.deepEqual(storedSchedule(edited.value), {
      timezone: 'Europe/Dublin',
      cadence: { type: 'daily', timeLocal: '09:15' },
    })

    const reread = await new AutomationsStore(root).getDefinition(installed.value.definition.id)
    assert.equal(reread.ok, true)
    if (!reread.ok) return
    assert.equal(storedSchedule(reread.value).timezone, 'Europe/Dublin', 'a later read re-localises nothing')

    // Nor does a second Get for the same entry rewrite the record already there.
    const again = await core.installFromCatalogue(root, {
      payload: CATALOGUE_PAYLOAD,
      sourceCatalogueId: 'multicode.nightly-sweep',
    })
    assert.equal(again.ok, true, again.ok ? '' : again.message)
    if (!again.ok) return
    assert.equal(again.value.alreadyAdded, true)
    assert.equal(storedSchedule(again.value.definition).timezone, 'Europe/Dublin')
  })
}

// A host that cannot name a usable zone must not cost the user the install: the
// payload's own zone stays, which is exactly what shipped before this rule.
async function assertAnUnusableHostZoneLeavesThePayloadAlone(): Promise<void> {
  await withProjectRoots(2, async ([blankRoot, bogusRoot]) => {
    for (const [root, zone, id] of [
      [blankRoot, '', 'multicode.no-zone'],
      [bogusRoot, 'Mars/Olympus_Mons', 'multicode.bogus-zone'],
    ] as const) {
      const { core } = catalogueWriteCore(undefined, () => zone)
      const installed = await core.installFromCatalogue(root, { payload: CATALOGUE_PAYLOAD, sourceCatalogueId: id })
      assert.equal(installed.ok, true, installed.ok ? '' : installed.message)
      if (!installed.ok) return
      assert.equal(storedSchedule(installed.value.definition).timezone, 'UTC', `"${zone}" is not stamped over the payload`)
    }
  })
}

function assertProvenanceCannotBePatchedOrForged(): void {
  const forged = parseDefinitionDraft({
    ...CATALOGUE_PAYLOAD,
    status: 'enabled',
    sourceCatalogueId: 'multicode.something-i-did-not-install',
    sourcePublisher: 'Someone Else',
  })
  assert.equal(forged.ok, true)
  if (!forged.ok) return
  assert.equal(forged.value.sourceCatalogueId, undefined, 'provenance is stamped by the host, never read off the payload')
  assert.equal(forged.value.sourcePublisher, undefined)

  const patch = parseDefinitionPatch({ name: 'Renamed', sourceCatalogueId: 'multicode.other' })
  assert.equal(patch.ok, true)
  if (!patch.ok) return
  assert.equal(Object.hasOwn(patch.value, 'sourceCatalogueId'), false, 'provenance is immutable after create')
}

async function main(): Promise<void> {
  assertLandedStartPairDefaultsToRunOnce()
  assertExplicitFalseOptsOut()
  assertOtherPairsAreUnaffected()
  assertRetiredAutonomyFieldIsIgnoredNotRejected()
  assertProvenanceCannotBePatchedOrForged()
  await assertInstallCreatesOneEnabledDefinitionWithProvenance()
  await assertCatalogueCannotOptOutOfWorktreeIsolation()
  await assertSecondInstallIntoSameProjectAddsNothing()
  await assertSameEntryInstallsIndependentlyIntoTwoProjects()
  await assertMalformedPayloadWritesNothing()
  await assertUnknownTriggerProviderWritesNothing()
  await assertInstallResolvesTheCadenceIntoTheInstallingUsersZone()
  await assertOneShotAndIntervalFollowTheSameOneRule()
  await assertAUsersOwnEditIsNeverRelocalised()
  await assertAnUnusableHostZoneLeavesThePayloadAlone()
  console.log('automations definition-write chain-default and catalogue-install tests passed')
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})
