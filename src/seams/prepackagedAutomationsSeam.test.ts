// Seam test for the prepackaged-automations epic (T10).
//
// The eight implementation tasks were each built against the plan rather than
// against each other, so every module below is correct in isolation. This test
// runs ONE artefact — a starter bundle exactly as it ships on disk (T8) — all
// the way through the chain the tasks divide between them, and asserts the
// invariants at each hand-off:
//
//   T1  the `automation` marketplace kind: manifest parse, component digests,
//       and the structural payload tier in packages/module-sdk
//   T5  the install path: the authoritative parse, install defaults, provenance
//       stamping, and the store record it writes
//   T2  the retirement of `autonomyDefault`: absent on what is written, and
//       translated (never resurrected) on what is read back
//   T3  the unattended default: the preset a stored starter actually launches on
//   T6→T7 the shelf→door hand-off latch that carries a freshly added automation
//       into the one editor that configures it
//
// Nothing here is stubbed apart from the clock: real bundle bytes, a real
// AutomationsStore on a real temp directory, real provider registry.

import assert from 'node:assert/strict'
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  MARKETPLACE_COMPONENT_KINDS,
  marketplaceAutomationPayloadIssues,
  parseMarketplacePluginAuthoringManifest,
  type MarketplacePluginAuthoringManifest,
} from '../../packages/module-sdk/src/plugin-manifest'
import {
  marketplaceAutomationPayloadIssuesSync,
  marketplaceComponentDigestMismatchIssuesSync,
} from '../../packages/module-sdk/src/plugin-component-digests'
import { hasCodeBearingComponent } from '../shared/marketplace/component-trust'
import { AUTOMATION_DEFAULT_PERMISSION_PRESET, type AutomationDefinition } from '../shared/automations/contracts'
import { createDefinitionWriteCore } from '../main/automations/definition-write'
import { allowAutomationProvider, createBuiltInAutomationProviderRegistry } from '../main/automations/provider-registry'
import { computeNextRun, validateScheduleTriggerConfig } from '../main/automations/schedule'
import { AutomationsStore } from '../main/automations/store'
import {
  WRITE_UP_ONLY_INSTRUCTION,
  composeSpawnAgentPrompt,
  parseSpawnAgentConfig,
} from '../main/automations/actions/spawn-agent'
import { automationsDoorTarget } from '../renderer/src/components/automations/runTarget'
import {
  consumePendingAutomationSurfaceTarget,
  dispatchAutomationSurfaceTarget,
} from '../renderer/src/components/workspace/globalSurface/automations/automationSurfaceTarget'

// The bundle is emitted into node_modules/.cache, so `__dirname` is not the
// source tree; the npm script runs from the repo root, like every sibling test.
const MARKETPLACE_ROOT = join(process.cwd(), 'resources', 'marketplace')

// The five nightly starters T8 ships. Named rather than globbed: a starter that
// disappears from disk should fail this test, not silently shrink its coverage.
const STARTER_IDS = [
  'dead-code-sweep-automation',
  'duplication-review-automation',
  'merged-pr-seam-review-automation',
  'ui-ux-review-automation',
  'unit-test-coverage-automation',
] as const

const FIXED_NOW = Date.parse('2026-07-30T12:00:00.000Z')

// The seam installs as a user somewhere the starters were not authored in, which
// is every user: the payloads ship UTC and the install resolves the schedule
// into the installing machine's zone (item 2039). Pinned rather than read off
// the host so the instants below hold wherever this runs.
const INSTALLING_USER_ZONE = 'Australia/Sydney'

function writeCore() {
  const registry = createBuiltInAutomationProviderRegistry()
  const changed: string[] = []
  const core = createDefinitionWriteCore({
    createStore: (workspaceRoot) => new AutomationsStore(workspaceRoot),
    getTriggerProviderRegistrations: () => registry.listTriggerProviderRegistrations(),
    getActionProviderRegistrations: () => registry.listActionProviderRegistrations(),
    checkProviderPermission: allowAutomationProvider,
    now: () => FIXED_NOW,
    hostTimeZone: () => INSTALLING_USER_ZONE,
    onDefinitionsChanged: (workspaceRoot) => {
      changed.push(workspaceRoot)
    },
  })
  return { core, changed }
}

// The payload is `unknown` on purpose here — the bundle is bytes off disk, and
// `validateScheduleTriggerConfig` is the gate that decides whether it is a
// schedule at all. This only reaches in far enough to hand it that gate.
function payloadTriggerConfig(payload: unknown): unknown {
  return (payload as { trigger?: { config?: unknown } } | null)?.trigger?.config
}

async function withProjectRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'mc-prepackaged-seam-'))
  try {
    return await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

type StarterBundle = {
  id: string
  bundleRoot: string
  manifest: MarketplacePluginAuthoringManifest
  payload: unknown
}

// ── T1: the bundle gates, run over the bytes that actually ship ──────────────
async function readStarterThroughBundleGates(id: string): Promise<StarterBundle> {
  const bundleRoot = join(MARKETPLACE_ROOT, 'plugins', id)
  const manifestSource = await readFile(join(bundleRoot, 'plugin.json'), 'utf8')
  const parsed = parseMarketplacePluginAuthoringManifest(manifestSource)
  assert.equal(parsed.ok, true, `${id}: plugin.json must parse as an authoring manifest`)
  if (!parsed.ok) throw new Error('unreachable')
  const manifest = parsed.manifest

  const automation = manifest.components.automation
  assert.ok(automation, `${id}: the starter must declare an automation component`)

  // The kind list is the single source both tiers iterate; a kind the SDK does
  // not know is a kind the installer's switch cannot reach.
  assert.ok(
    MARKETPLACE_COMPONENT_KINDS.includes('automation'),
    'automation must be in MARKETPLACE_COMPONENT_KINDS or no consumer enumerates it',
  )

  // Declarative, so an unsigned automation-only bundle is allowed to stage.
  assert.equal(
    hasCodeBearingComponent(manifest.components),
    false,
    `${id}: an automation payload is a definition, never loaded as code`,
  )

  assert.deepEqual(
    // Sibling gates, different argument shapes: the digest walk takes the
    // manifest, the automation check takes its components.
    marketplaceComponentDigestMismatchIssuesSync(bundleRoot, manifest),
    [],
    `${id}: the shipped digests must match the shipped bytes`,
  )
  assert.deepEqual(
    marketplaceAutomationPayloadIssuesSync(bundleRoot, manifest.components),
    [],
    `${id}: the structural tier must accept the payload it ships`,
  )

  const payload = JSON.parse(await readFile(join(bundleRoot, automation.path), 'utf8'))
  return { id, bundleRoot, manifest, payload }
}

// ── T1 → T5 → T2 → T3: one starter, the whole chain ──────────────────────────
async function assertEveryShippedStarterSurvivesTheWholeChain(): Promise<void> {
  for (const id of STARTER_IDS) {
    const starter = await readStarterThroughBundleGates(id)

    await withProjectRoot(async (root) => {
      const { core, changed } = writeCore()

      // T5: the authoritative parse and the single write path. The structural
      // tier passing above proves nothing about this one — that split is the
      // seam, so both are exercised on the same bytes.
      const installed = await core.installFromCatalogue(root, {
        payload: starter.payload,
        sourceCatalogueId: starter.manifest.id,
        ...(starter.manifest.publisher ? { sourcePublisher: starter.manifest.publisher } : {}),
      })
      assert.equal(installed.ok, true, installed.ok ? '' : `${id}: ${installed.message}`)
      if (!installed.ok) return

      const definition = installed.value.definition
      assert.equal(installed.value.alreadyAdded, false)
      assert.equal(definition.status, 'enabled', `${id}: a starter arrives on`)
      assert.equal(definition.sourceCatalogueId, starter.manifest.id, `${id}: provenance is the catalogue entry id`)
      assert.notEqual(definition.id, starter.manifest.id, `${id}: the catalogue id never becomes the store id`)
      assert.equal(definition.runInWorktree, undefined, `${id}: a starter cannot opt the user out of isolation`)
      assert.notEqual(definition.nextRunAt, null, `${id}: scheduled at install, not at the next restart`)

      // The payload's UTC does not survive the install: the authored wall-clock
      // is kept and read in the installing user's zone, so "nightly" is nightly
      // for them rather than mid-afternoon (item 2039).
      const schedule = validateScheduleTriggerConfig(definition.trigger.config)
      const authored = validateScheduleTriggerConfig(payloadTriggerConfig(starter.payload))
      assert.ok(schedule.ok, `${id}: an installed schedule must validate`)
      assert.ok(authored.ok, `${id}: so must the payload's own`)
      assert.equal(authored.value.timezone, 'UTC', `${id}: the payload ships the author's zone`)
      assert.equal(schedule.value.timezone, INSTALLING_USER_ZONE, `${id}: the record carries the installing user's`)
      assert.deepEqual(schedule.value.cadence, authored.value.cadence, `${id}: the authored wall-clock is untouched`)
      assert.notEqual(
        definition.nextRunAt,
        new Date(computeNextRun(authored.value, FIXED_NOW) ?? 0).toISOString(),
        `${id}: so it is not armed at the instant the payload's UTC would have given`,
      )
      assert.deepEqual(changed, [root], `${id}: open surfaces are told the project's definitions changed`)

      // T2: the retired field is on neither the record nor the file.
      assert.equal(Object.hasOwn(definition, 'autonomyDefault'), false, `${id}: nothing writes the retired field`)
      const onDisk = JSON.parse(
        await readFile(join(root, '.sprintengine', 'automations', 'definitions', `${definition.id}.json`), 'utf8'),
      )
      assert.equal(Object.hasOwn(onDisk, 'autonomyDefault'), false, `${id}: nor does it reach disk`)
      assert.equal(Object.hasOwn(onDisk, 'legacyWriteUpOnly'), false, `${id}: nor does its runtime marker`)

      // T2 read side: the store reads back what the install wrote.
      const reread = await new AutomationsStore(root).getDefinition(definition.id)
      assert.equal(reread.ok, true, `${id}: the written record must load`)
      if (!reread.ok) return
      assert.equal(reread.value.sourcePublisher, starter.manifest.publisher)

      // T3: what this starter will actually launch on, resolved from the record
      // that landed rather than from the payload the author wrote.
      assertStoredStarterLaunchesUnattended(reread.value)
    })
  }
  console.log(`ok - all ${STARTER_IDS.length} shipped starters survive bundle gates → install → store → launch`)
}

function assertStoredStarterLaunchesUnattended(definition: AutomationDefinition): void {
  const config = parseSpawnAgentConfig(definition.action.config)
  assert.equal(
    config.permissionPreset,
    AUTOMATION_DEFAULT_PERMISSION_PRESET,
    `${definition.name}: a starter naming no preset runs unattended, not on \`default\` (which would hang at the first prompt)`,
  )

  const prompt = composeSpawnAgentPrompt({
    userPrompt: config.prompt,
    automationId: definition.id,
    runId: 'run-1',
    writeUpOnly: definition.legacyWriteUpOnly === true,
  })
  for (const retired of ['review_only', 'allow_changes', 'Automation execution mode']) {
    assert.equal(
      prompt.includes(retired),
      false,
      `${definition.name}: the retired autonomy vocabulary must not survive in the launch prompt`,
    )
  }
  // Not `prompt.includes(...)`: two starters carry the owner's write-up-only
  // sentence in their OWN prompt text, which is the point — the intent lives in
  // the prompt now. What must hold is that the composer adds no legacy line of
  // its own, so the composed prompt is byte-identical to the unmarked build.
  assert.equal(
    prompt,
    composeSpawnAgentPrompt({
      userPrompt: config.prompt,
      automationId: definition.id,
      runId: 'run-1',
      writeUpOnly: false,
    }),
    `${definition.name}: a definition written since the retirement gets no legacy instruction`,
  )
}

// ── T2 × T5: a legacy record and a catalogue record in the same store ────────
// The tolerant read and the install path both write through the same core. A
// legacy definition sitting beside an installed starter must keep its author's
// intent, and must not resurrect the retired key when the record is next written.
async function assertLegacyRecordKeepsItsIntentBesideAnInstalledStarter(): Promise<void> {
  const starter = await readStarterThroughBundleGates('duplication-review-automation')

  await withProjectRoot(async (root) => {
    const { core } = writeCore()
    const store = new AutomationsStore(root)

    // A record written before the retirement, created through the same core and
    // then given the retired key on disk — the shape a user upgrading actually has.
    const legacyCreated = await core.create(root, {
      name: 'Legacy reviewer',
      status: 'enabled',
      trigger: {
        kind: 'schedule',
        config: { kind: 'schedule', cadence: { type: 'daily', timeLocal: '04:00' }, timezone: 'UTC' },
      },
      action: { kind: 'spawn-agent', config: { prompt: 'Report on the state of the tests.' } },
    })
    assert.equal(legacyCreated.ok, true, legacyCreated.ok ? '' : legacyCreated.message)
    if (!legacyCreated.ok) return
    const legacyPath = join(root, '.sprintengine', 'automations', 'definitions', `${legacyCreated.value.id}.json`)
    const legacyFile = JSON.parse(await readFile(legacyPath, 'utf8'))
    await writeJson(legacyPath, { ...legacyFile, autonomyDefault: 'review_only' })

    const installed = await core.installFromCatalogue(root, {
      payload: starter.payload,
      sourceCatalogueId: starter.manifest.id,
    })
    assert.equal(installed.ok, true, installed.ok ? '' : installed.message)
    if (!installed.ok) return

    const listed = await store.listDefinitions()
    assert.equal(listed.ok, true, 'a legacy record must not break enumeration for the ones beside it')
    if (!listed.ok) return
    assert.equal(listed.values.length, 2)

    const legacy = listed.values.find((d) => d.id === legacyCreated.value.id)
    const fresh = listed.values.find((d) => d.id === installed.value.definition.id)
    assert.ok(legacy && fresh)
    assert.equal(Object.hasOwn(legacy, 'autonomyDefault'), false, 'the retired key never reaches a reader')
    assert.equal(legacy.legacyWriteUpOnly, true, 'a review_only author still gets a reviewer')
    assert.equal(fresh.legacyWriteUpOnly, undefined, 'the marker is not contagious across records in one store')

    // The intent reaches the prompt — this is the whole point of the marker.
    const legacyPrompt = composeSpawnAgentPrompt({
      userPrompt: parseSpawnAgentConfig(legacy.action.config).prompt,
      automationId: legacy.id,
      runId: 'run-1',
      writeUpOnly: legacy.legacyWriteUpOnly === true,
    })
    assert.equal(legacyPrompt.includes(WRITE_UP_ONLY_INSTRUCTION), true, 'the retired intent lands in the prompt')

    // And the next write strips both the retired key and its marker.
    const updated = await core.update(root, legacy.id, { name: 'Legacy reviewer, renamed' })
    assert.equal(updated.ok, true, updated.ok ? '' : updated.message)
    if (!updated.ok) return
    const rewritten = JSON.parse(await readFile(legacyPath, 'utf8'))
    assert.equal(Object.hasOwn(rewritten, 'autonomyDefault'), false, 'a rewrite does not resurrect the retired key')
    assert.equal(Object.hasOwn(rewritten, 'legacyWriteUpOnly'), false, 'nor persist the marker derived from it')
  })
  console.log(
    'ok - a legacy review_only record keeps its intent beside an installed starter, and neither key is ever persisted',
  )
}

// ── T6 → T7: the shelf hands the added automation to the door's editor ───────
async function assertShelfHandsAddedAutomationToTheEditor(): Promise<void> {
  const automationId = 'auto-installed-1'
  const folderPath = '/tmp/project-a'

  // What ExtensionsGlobalSurface.tailorAddedAutomation dispatches: the door
  // target for the automation, no run to focus, asking for the editor view.
  dispatchAutomationSurfaceTarget(automationsDoorTarget(automationId, '', folderPath), 'editor')

  const drained = consumePendingAutomationSurfaceTarget()
  assert.ok(drained, 'the shelf hand-off must survive the door not being mounted yet')
  assert.equal(drained.view, 'editor', 'a Get lands in the editor, not the run history')
  assert.equal(drained.ref.automationId, automationId)
  assert.equal(drained.ref.runId, '', 'an empty run id must decode, not be rejected as malformed')
  assert.equal(drained.ref.folderPath, folderPath, 'the door scopes to the project the automation landed in')
  assert.equal(consumePendingAutomationSurfaceTarget(), null, 'the latch drains once')

  // The Open path on an already-added automation is the same seam, runs view.
  dispatchAutomationSurfaceTarget(automationsDoorTarget(automationId, '', folderPath))
  const openTarget = consumePendingAutomationSurfaceTarget()
  assert.equal(openTarget?.view, 'runs', 'Open keeps the historical behaviour')

  console.log(
    'ok - the shelf → door hand-off carries an added automation into the editor, and Open still lands on runs',
  )
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function main(): Promise<void> {
  // The structural tier is what the bundle gates run; prove it rejects as well
  // as accepts, or the gate above is only asserting that nothing runs.
  assert.equal(marketplaceAutomationPayloadIssues('not json').length > 0, true)
  assert.equal(
    marketplaceAutomationPayloadIssues('{"name":"x"}').length,
    2,
    'a payload with no trigger and no action is refused',
  )

  await assertEveryShippedStarterSurvivesTheWholeChain()
  await assertLegacyRecordKeepsItsIntentBesideAnInstalledStarter()
  await assertShelfHandsAddedAutomationToTheEditor()
  console.log('ok - prepackaged automations seam')
}

main().catch((error) => {
  console.error('not ok - prepackaged automations seam')
  console.error(error)
  process.exit(1)
})
