import assert from 'node:assert/strict'
import { readdir } from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SPRINT_ENGINE_RUN_LANDED_TRIGGER_KIND } from '../../shared/automations/contracts'
import { SPRINT_ENGINE_START_ACTION_KIND } from './actions/sprint-engine'
import { createDefinitionWriteCore, parseDefinitionDraft, parseDefinitionPatch } from './definition-write'
import { allowAutomationProvider, createBuiltInAutomationProviderRegistry } from './provider-registry'
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

function catalogueWriteCore(now = Date.parse('2026-07-30T12:00:00.000Z')) {
  const registry = createBuiltInAutomationProviderRegistry()
  const changed: string[] = []
  const core = createDefinitionWriteCore({
    createStore: (workspaceRoot) => new AutomationsStore(workspaceRoot),
    getTriggerProviderRegistrations: () => registry.listTriggerProviderRegistrations(),
    getActionProviderRegistrations: () => registry.listActionProviderRegistrations(),
    checkProviderPermission: allowAutomationProvider,
    now: () => now,
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
  console.log('automations definition-write chain-default and catalogue-install tests passed')
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})
