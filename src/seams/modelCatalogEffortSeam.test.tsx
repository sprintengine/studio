import { sprintEngineRunState } from '../renderer/src/store/slices/workspaceModuleState'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { installJsdomEnvironment } from './jsdomEnvironment'

// ── Seams between the four children of run D (MC-1865/1870/1884/1885) ─────────
//
// Each child passes its own suite. The failures this run can still ship are the
// ones that live BETWEEN them, so every seam below is proved by running the two
// sides against each other rather than by reading both and calling them
// consistent:
//
//   1. MC-1865 × MC-1870 — two store-schema rungs (69, 70) in one run. A store
//      written by the PREVIOUS build must hydrate with its catalog AND its level
//      intact, and the load after that must re-run neither rung.
//   2. MC-1865's union merge under repetition, through the real store setter —
//      Opus 5 by name, across three discovery passes that never mention it.
//   3. MC-1884 × MC-1870 — the level clicked in the real picker must reach the
//      LAUNCHED COMMAND, not merely the store.
//   4. MC-1885 × MC-1870 — a seat's level must reach the launched agent's
//      command, not merely the seat config in the projection.
//   5. MC-1884 × a CLI declaring no levels — absent, not disabled, not empty.
//   6. The remaining shared-file pairs the plan's Seams table names:
//      settingsSlice (one selection type, two owners), cliRuntimeOptions (the
//      per-CLI guard), the model popover (a discovered row, with the reasoning
//      selector beside it).
//
// Store hydration is exercised through the REAL persist envelope, so the seeding
// below has to happen before workspaceStore is imported.
//
// Labelled SEAM: per the run-A convention.

const dom = installJsdomEnvironment()

const BUNDLED_ROOT = join(process.cwd(), 'resources', 'plugins')

// A well-formed discovered catalog written by the build that shipped MC-1865
// (store v69) and a reasoning level on a stored selection. Both must survive the
// v70 rung: the whole point of two rungs rather than one combined bump.
const PREVIOUS_BUILD_CATALOG = {
  'claude-code': {
    models: [{ id: 'opus[1m]', displayName: 'Opus (1M)' }, { id: 'claude-fable-5' }],
    fetchedAt: '2026-07-27T00:00:00Z',
    source: 'agent-sdk',
  },
}
const PREVIOUS_BUILD_SELECTIONS = {
  architect: { cli: 'codex', model: 'gpt-5.6-sol', reasoning: 'high' },
  developer: { cli: 'claude-code', model: '', reasoning: 'xhigh' },
}

const seedStorage = (version: number): void => {
  dom.window.localStorage.setItem(
    'multicode-workspaces',
    JSON.stringify({
      state: {
        workspaces: [
          {
            id: 'ws-seam',
            name: 'Seam Project',
            mode: 'standard',
            folderPath: '/repo/seam',
            agents: {},
            createdAt: 1,
          },
        ],
        activeWorkspaceId: 'ws-seam',
        workspaceRegistryEmptyState: null,
      },
      version,
    }),
  )
  dom.window.localStorage.setItem(
    'multicode-app-settings',
    JSON.stringify({
      state: {
        appSettings: {
          cliRuntimes: { codex: { command: 'codex', useWsl: false, models: ['o4-mini'] } },
          cliModelCatalog: PREVIOUS_BUILD_CATALOG,
          specialistModelDefaults: PREVIOUS_BUILD_SELECTIONS,
        },
      },
      version,
    }),
  )
}

// Store v69 = "the previous build": MC-1865 landed, MC-1870 had not.
seedStorage(69)

type CatalogEntry = {
  id: string
  displayName: string
  source: 'bundled'
  modelSelection?: unknown
  reasoningSelection?: unknown
}

// The real bundled manifests, read from disk. Every model id, level id and flag
// asserted below is therefore the one the CLI actually documents, not one this
// suite invented.
function bundledCatalogEntries(ids: string[]): CatalogEntry[] {
  return ids.map((id) => {
    const manifest = JSON.parse(readFileSync(join(BUNDLED_ROOT, id, 'plugin.json'), 'utf8')) as {
      displayName: string
      modelSelection?: unknown
      reasoningSelection?: unknown
    }
    return {
      id,
      displayName: manifest.displayName,
      source: 'bundled' as const,
      ...(manifest.modelSelection ? { modelSelection: manifest.modelSelection } : {}),
      ...(manifest.reasoningSelection ? { reasoningSelection: manifest.reasoningSelection } : {}),
    }
  })
}

async function main(): Promise<void> {
  const React = await import('react')
  const { act } = React
  const { createRoot } = await import('react-dom/client')

  const { useWorkspaceStore } = await import('../renderer/src/store/workspaceStore')
  const { WORKSPACE_STORE_VERSION, migratePersistedWorkspaceState } = await import(
    '../renderer/src/store/slices/persistenceSlice'
  )
  const { normalizeAppSettings } = await import('../renderer/src/store/slices/settingsSlice')
  const { buildAgentCliCatalog, resolveCliReasoning, resolveSurfaceModel } = await import(
    '../renderer/src/components/workspace/newWorkspace/cliRuntimeOptions'
  )
  const { CliModelPopoverSurface } = await import('../renderer/src/components/ui/CliModelPicker')
  const { reconcileSprintEngineAgents } = await import('../renderer/src/store/slices/runStateSlice')
  const { createInitialSprintEngineState } = await import('../renderer/src/utils/sprintengine')
  const { buildAgentShellCommand, renderAgentLaunchArgv } = await import('../main/agent-launch-render')
  const { createPluginRegistry } = await import('../main/plugin-registry')
  const { __resetPluginRegistryForTest, __setPluginRegistryForTest } = await import(
    '../main/plugin-registry-instance'
  )

  let failures = 0
  const check = async (name: string, fn: () => Promise<void> | void): Promise<void> => {
    try {
      await fn()
      console.log(`ok - ${name}`)
    } catch (error) {
      failures += 1
      console.error(`not ok - ${name}`)
      console.error(error)
    }
  }

  // The real bundled registry, so the launch render below resolves the same
  // manifests the app ships.
  async function usingBundledRegistry(fn: () => Promise<void> | void): Promise<void> {
    __resetPluginRegistryForTest()
    const registry = createPluginRegistry({
      bundledRoot: BUNDLED_ROOT,
      userRoot: join(process.cwd(), '.does-not-exist', 'multicode', 'plugins'),
    })
    const report = registry.loadSync()
    assert.deepEqual(report.rejected, [], 'bundled manifests load clean')
    __setPluginRegistryForTest(registry, report)
    try {
      await fn()
    } finally {
      __resetPluginRegistryForTest()
    }
  }

  type SurfaceProps = Parameters<typeof CliModelPopoverSurface>[0]
  const mounted: Array<() => void> = []

  function mountListbox(props: Partial<SurfaceProps>) {
    const container = dom.window.document.createElement('div')
    dom.window.document.body.appendChild(container)
    const root = createRoot(container)
    const render = (next: Partial<SurfaceProps>): void => {
      act(() => {
        root.render(
          React.createElement(CliModelPopoverSurface, {
            ariaLabel: 'Agent runtime',
            effectiveModelFor: () => undefined,
            onSelectCli: () => {},
            onSelectModel: () => {},
            showReasoning: true,
            ...props,
            ...next,
          } as unknown as SurfaceProps),
        )
      })
    }
    render({})
    // Triggers live inside this mount's own container; only the OPEN menu is
    // portaled to <body>. Scoping the trigger query to the container is what
    // keeps one mounted surface from answering another's question.
    const scoped = <T extends Element>(selector: string): T[] =>
      [...container.querySelectorAll(selector)] as unknown as T[]
    let unmounted = false
    const view = {
      render,
      rows: () => scoped<HTMLElement>('[data-model-row="true"]'),
      pickers: () => scoped<HTMLButtonElement>('[data-reasoning-trigger="true"]'),
      menuItems: () =>
        [...dom.window.document.body.querySelectorAll('[data-reasoning-option="true"]')] as unknown as HTMLButtonElement[],
      click: async (element: Element | undefined | null) => {
        assert.ok(element, 'expected the control to exist before clicking it')
        await act(async () => {
          element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
        })
      },
      key: async (element: Element | undefined | null, key: string) => {
        assert.ok(element, 'expected the control to exist before keying it')
        await act(async () => {
          element.dispatchEvent(
            new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
          )
        })
      },
      // Effort is a ramp on a slider, not a row per level, so a level is
      // reached by WALKING it. Home first so the walk starts from a known stop
      // whatever the control was showing; the surface is re-rendered and the
      // element re-read each step, because these mounts read their level back
      // out of a store they do not subscribe to.
      pickLevel: async (label: string) => {
        const slider = () =>
          dom.window.document.body.querySelector('[data-slider="true"]') as HTMLElement | null
        assert.ok(slider(), 'the effort ramp is on the open surface')
        await view.key(slider(), 'Home')
        for (let step = 0; step <= 12; step += 1) {
          view.render({})
          if (slider()?.getAttribute('aria-valuetext') === label) return
          await view.key(slider(), 'ArrowRight')
        }
        assert.fail(`the ramp never reached ${label}`)
      },
      unmount: () => {
        if (unmounted) return
        unmounted = true
        act(() => root.unmount())
        container.remove()
      },
    }
    mounted.push(view.unmount)
    return view
  }

  // ── Seam 1: MC-1865 (store v69) × MC-1870 (store v70) ──────────────────────

  await check('SEAM: a store written by the previous build hydrates with its catalog AND its level intact', () => {
    // 2026-09-06: this asserted `WORKSPACE_STORE_VERSION === 70` — the ladder's
    // height when run D shipped, when "two rungs, 69 then 70" and "the current
    // version" happened to be the same statement. They stopped being the same
    // when the counter reached 74 on four unrelated rungs (v71 MC-1573's module
    // state bag, v72 MC-2222's specialist default, v73/v74 the rail → pane
    // layout heals), and the pin then failed for a reason this seam has no
    // opinion about. What the seam is actually for is BELOW: a store written at
    // v69 by the previous build arrives with its catalog and its levels intact
    // no matter how many rungs it climbs on the way. Verified at v74 on
    // 2026-09-06 — all three deepEquals pass — so the floor is the assertion
    // and the hydration is the proof. `the load after that re-runs neither
    // rung` exercises the 69 and 70 rungs themselves.
    assert.ok(
      WORKSPACE_STORE_VERSION >= 70,
      `the 69 → 70 rungs are still in the ladder this store hydrates through (at ${WORKSPACE_STORE_VERSION})`,
    )

    const settings = useWorkspaceStore.getState().appSettings
    assert.deepEqual(
      settings.cliModelCatalog,
      PREVIOUS_BUILD_CATALOG,
      'MC-1865’s discovered catalog survives the rung MC-1870 added on top of it',
    )
    assert.deepEqual(
      settings.specialistModelDefaults,
      PREVIOUS_BUILD_SELECTIONS,
      'and the per-CLI levels survive beside it — including the one with no model, '
        + 'which the pre-1870 normalizer would have thrown away',
    )
    assert.deepEqual(
      settings.cliRuntimes.codex.models,
      ['o4-mini'],
      'the user’s own model ids are a sibling of the discovered catalog, untouched by either rung',
    )
  })

  await check('SEAM: the load after that re-runs neither rung', async () => {
    // Observable, not argued. Every rung in this ladder replaces `appSettings`
    // with a fresh object (normalizeAppSettings always returns a new one), so
    // reference identity says exactly which rungs fired.
    const envelope = () => ({
      workspaces: [{ id: 'ws-seam', mode: 'standard', folderPath: '/repo/seam', agents: {} }],
      activeWorkspaceId: 'ws-seam',
      appSettings: {
        cliModelCatalog: PREVIOUS_BUILD_CATALOG,
        specialistModelDefaults: PREVIOUS_BUILD_SELECTIONS,
      },
    })

    const atV69 = envelope()
    const beforeV69 = atV69.appSettings
    const migratedV69 = migratePersistedWorkspaceState(atV69, 69) as { appSettings: unknown }
    assert.notEqual(migratedV69.appSettings, beforeV69, 'loading a v69 store runs the v70 rung')

    const atV68 = envelope()
    const beforeV68 = atV68.appSettings
    const migratedV68 = migratePersistedWorkspaceState(atV68, 68) as { appSettings: unknown }
    assert.notEqual(migratedV68.appSettings, beforeV68, 'loading a v68 store runs the v69 rung too')
    assert.deepEqual(
      (migratedV68 as { appSettings: { cliModelCatalog?: unknown } }).appSettings.cliModelCatalog,
      PREVIOUS_BUILD_CATALOG,
      'and both rungs together still leave the catalog exactly as written',
    )

    const atCurrent = envelope()
    const beforeCurrent = atCurrent.appSettings
    const migratedCurrent = migratePersistedWorkspaceState(atCurrent, WORKSPACE_STORE_VERSION) as {
      appSettings: unknown
    }
    assert.equal(
      migratedCurrent.appSettings,
      beforeCurrent,
      'a store already at the current version runs NEITHER rung — same object, untouched',
    )

    // And the real second load, through the whole persist path: the app has
    // re-stamped the envelope at the current version, so this hydration reaches
    // merge() alone and must land on the same settings.
    const first = useWorkspaceStore.getState().appSettings
    seedStorage(WORKSPACE_STORE_VERSION)
    await useWorkspaceStore.persist.rehydrate()
    const second = useWorkspaceStore.getState().appSettings
    assert.deepEqual(second.cliModelCatalog, first.cliModelCatalog, 'second load: catalog unchanged')
    assert.deepEqual(
      second.specialistModelDefaults,
      first.specialistModelDefaults,
      'second load: levels unchanged',
    )
  })

  // ── Seam 2: the union merge under repetition, through the store setter ─────

  await check('SEAM: Opus 5 survives three discovery passes that never mention it', () => {
    const store = useWorkspaceStore.getState()
    const plugins = bundledCatalogEntries(['claude-code'])
    const claudeModels = (): Array<{ id: string; origin?: string }> => {
      const catalog = useWorkspaceStore.getState().appSettings.cliModelCatalog
      const option = buildAgentCliCatalog(
        plugins as never,
        { 'claude-code': { models: ['my-own-pin'] } } as never,
        catalog as never,
      ).find((entry) => entry.value === 'claude-code')
      assert.ok(option?.modelSelection, 'claude-code renders a model list')
      return option.modelSelection.options as never
    }

    // Measured 2026-07-26: the Claude Agent SDK lists these and NOT
    // `claude-opus-5`, on a machine where `claude --model claude-opus-5` runs.
    // A "replace with what discovery returned" merge deletes it here and looks
    // perfectly correct doing so.
    const passes = [
      [{ id: 'opus[1m]', displayName: 'Opus (1M)' }, { id: 'claude-fable-5' }],
      [{ id: 'opus[1m]', displayName: 'Opus (1M)' }],
      [{ id: 'claude-sonnet-5' }],
    ]
    passes.forEach((models, index) => {
      store.setCliModelCatalog('claude-code' as never, {
        models,
        fetchedAt: `2026-07-2${7 + index}T00:00:00Z`,
        source: 'agent-sdk',
      } as never)
      const ids = claudeModels().map((model) => model.id)
      assert.ok(
        ids.includes('claude-opus-5'),
        `pass ${index + 1} omitted Opus 5 and it must still be offered: ${ids.join(', ')}`,
      )
      assert.ok(
        ids.includes('my-own-pin'),
        `pass ${index + 1}: the user's own id survives every re-probe too: ${ids.join(', ')}`,
      )
    })

    // The other half of the same rule, and the reason it is a union rather than
    // an append: the discovered layer IS replaced, so a model the CLI stopped
    // listing stops being claimed as discovered.
    const final = claudeModels()
    assert.equal(
      final.find((model) => model.id === 'claude-sonnet-5')?.origin,
      'discovered',
      'the newest pass’s own row is present and claimed by the discovered layer',
    )
    assert.equal(
      final.find((model) => model.id === 'claude-opus-5')?.origin,
      'manifest',
      'and Opus 5 is still there under the layer that actually vouches for it',
    )

    // Clearing the catalog is the fourth pass: the curated layers are still all
    // there, so a failed probe can never empty a picker.
    store.setCliModelCatalog('claude-code' as never, null)
    const cleared = claudeModels().map((model) => model.id)
    assert.ok(cleared.includes('claude-opus-5') && cleared.includes('my-own-pin'), cleared.join(', '))
    assert.ok(!cleared.includes('claude-sonnet-5'), 'and the discovered rows are gone with the catalog')
  })

  // ── Seam 3: MC-1884's picker × MC-1870's launch ────────────────────────────

  await check('SEAM: the level clicked in the picker reaches the launched command, not just the store', async () => {
    const specialistId = 'reviewer' as never
    const store = () => useWorkspaceStore.getState()
    store().setSpecialistModelDefault(specialistId, { cli: 'claude-code', model: 'claude-opus-5' })

    const options = buildAgentCliCatalog(bundledCatalogEntries(['claude-code']) as never)
    const view = mountListbox({
      options: options as never,
      currentCli: 'claude-code' as never,
      effectiveModelFor: (cli) => resolveSurfaceModel(cli, store().appSettings.specialistModelDefaults?.[specialistId]),
      effectiveReasoningFor: (cli) =>
        resolveCliReasoning(cli, store().appSettings.specialistModelDefaults?.[specialistId]),
      onSelectReasoning: (cli, reasoning) => store().setSpecialistReasoningDefault(specialistId, cli, reasoning),
    })

    // One trigger per axis the runtime offers, all on the SELECTED row — never
    // one per row. Opus 5 ships at two context windows and claude-code declares
    // effort levels, so this surface carries two: context window, then
    // reasoning (owner, 2026-08-06 — they were one composed "Auto · Standard"
    // trigger, which made changing either a menu-open away from knowing which
    // half you were reading).
    const pickerLabels = view.pickers().map((picker) => picker.getAttribute('aria-label') ?? '')
    assert.equal(view.pickers().length, 2, `the selected row carries one trigger per axis: ${pickerLabels}`)
    assert.ok(
      pickerLabels.some((label) => label.startsWith('Context window')),
      `context window is its own control: ${pickerLabels}`,
    )
    const reasoningPicker = view
      .pickers()
      .find((picker) => (picker.getAttribute('aria-label') ?? '').startsWith('Reasoning'))
    assert.ok(reasoningPicker, `reasoning is its own control: ${pickerLabels}`)
    await view.click(reasoningPicker)
    await view.pickLevel('Extra high')

    // Evidence A — store state. Necessary, and on its own worth nothing: MC-1885
    // shipped with every layer below the producer proved from state exactly like
    // this, and the chain was still broken in the middle.
    const stored = store().appSettings.specialistModelDefaults?.[specialistId]
    assert.deepEqual(
      stored,
      { cli: 'claude-code', model: 'claude-opus-5', reasoning: 'xhigh' },
      'the click wrote the level beside the model it was picked for',
    )

    // Evidence B — the command line the process is launched with. This is the
    // assertion that matters; A is only how B got its input.
    await usingBundledRegistry(() => {
      const command = buildAgentShellCommand({
        cli: 'claude-code',
        sessionId: 'seam-session',
        cliModel: resolveSurfaceModel('claude-code', stored),
        cliReasoning: resolveCliReasoning('claude-code', stored),
      })
      assert.match(command, /--effort xhigh/, `the launched command carries the picked level: ${command}`)
      assert.match(command, /--model claude-opus-5/, 'and still carries the model beside it')
    })

    // Round trip: the control reads back what it wrote rather than only writing.
    // The REASONING trigger specifically — with the axes split, the first
    // trigger on the row is the context window, which knows nothing about effort.
    view.render({})
    const trigger = view
      .pickers()
      .find((picker) => (picker.getAttribute('aria-label') ?? '').startsWith('Reasoning'))
    assert.ok(trigger, 'the picker is still rendered after the write')
    assert.match(trigger.textContent ?? '', /Extra high/, 'and it reads the stored level back')
    view.unmount()
  })

  await check('SEAM: clearing the level clears the flag, and the model survives the clearing', async () => {
    const specialistId = 'reviewer' as never
    const store = () => useWorkspaceStore.getState()
    // Self-contained: set the state this check clears, rather than inheriting it
    // from the check above, so a failure here names its own cause.
    store().setSpecialistModelDefault(specialistId, {
      cli: 'claude-code',
      model: 'claude-opus-5',
      reasoning: 'xhigh',
    } as never)
    store().setSpecialistReasoningDefault(specialistId, 'claude-code' as never, null)
    const stored = store().appSettings.specialistModelDefaults?.[specialistId]
    assert.deepEqual(
      stored,
      { cli: 'claude-code', model: 'claude-opus-5' },
      'clearing the level keeps the model — clearing effort must not silently change which model launches',
    )
    await usingBundledRegistry(() => {
      const command = buildAgentShellCommand({
        cli: 'claude-code',
        sessionId: 'seam-session',
        cliModel: resolveSurfaceModel('claude-code', stored),
        cliReasoning: resolveCliReasoning('claude-code', stored),
      })
      const baseline = buildAgentShellCommand({
        cli: 'claude-code',
        sessionId: 'seam-session',
        cliModel: 'claude-opus-5',
      })
      assert.equal(command, baseline, 'a cleared level launches byte-identical to a pre-effort launch')
    })
  })

  // ── Seam 4: MC-1885's seat × MC-1870's launch ──────────────────────────────

  await check('SEAM: a seat’s level reaches the launched agent’s command, not just the projection', async () => {
    const base = createInitialSprintEngineState({
      goal: 'prove the seat level reaches the launch',
      name: 'Effort Seam Team',
      roleCounts: { developer: 1 },
    })
    const state = {
      ...base,
      sprintEngineAgents: {
        ...base.sprintEngineAgents,
        developer: { role: 'developer' as const, status: 'idle' as const, currentTaskId: null },
      },
      roleRuntimes: { developer: { cli: 'claude-code', model: 'claude-opus-5', reasoning: 'max' } },
    }

    // The projection write the app actually performs, then the agent record the
    // spawn reads. `{}` is a cold workspace: this is the minted branch, the one
    // MC-1450 proved could silently drop the role's runtime.
    const agents = reconcileSprintEngineAgents({}, state as never)
    const developer = agents.developer
    assert.ok(developer, 'the seat minted an agent record')
    assert.equal(developer.cliReasoning, 'max', 'the record carries the seat’s level')

    // TerminalView spawns with exactly these three fields off the agent record;
    // this is the payload, rendered.
    await usingBundledRegistry(() => {
      const command = buildAgentShellCommand({
        cli: developer.cli!,
        sessionId: 'seam-session',
        cliModel: developer.cliModel,
        cliReasoning: developer.cliReasoning,
      })
      assert.match(command, /--effort max/, `the launched command carries the seat level: ${command}`)
    })

    // A seat with no level must leave the command exactly as it was before this
    // run existed — the regression that would hit every existing run.
    const plainAgents = reconcileSprintEngineAgents({}, {
      ...state,
      roleRuntimes: { developer: { cli: 'claude-code', model: 'claude-opus-5' } },
    } as never)
    assert.equal(plainAgents.developer?.cliReasoning, undefined, 'no level configured, none resolved')
    await usingBundledRegistry(() => {
      const command = buildAgentShellCommand({
        cli: 'claude-code',
        sessionId: 'seam-session',
        cliModel: 'claude-opus-5',
        cliReasoning: plainAgents.developer?.cliReasoning,
      })
      assert.doesNotMatch(command, /--effort/, `no level means no flag: ${command}`)
    })
  })

  await check('SEAM: the seat the wizard starts immediately launches at the level the wizard picked', async () => {
    // The gap the previous check cannot see. Under the lazy roster the ONLY
    // seat materialized at creation is the architect, and it is materialized by
    // `addWorkspace` — not by `reconcileSprintEngineAgents`. That seeding exists
    // precisely because "Start now" launches the architect off the seeded record
    // before any projection has arrived (SprintEngineBoardPanel returns true for
    // the architect without waiting), which is why it already copies the CLI and
    // the model across. A level left out of that copy is MC-1450 one field over:
    // the run's own roleRuntimes say `max`, the process launches at the CLI's
    // default effort, and nothing reports the difference.
    const state = createInitialSprintEngineState({
      goal: 'prove the wizard-seeded seat carries its level',
      name: 'Start Now Team',
      roleCounts: { architect: 1, developer: 1 },
    })
    const workspaceId = useWorkspaceStore.getState().addWorkspace(
      { id: 'seam-standard', name: 'Standard', layout: { global: {}, borders: [], layout: { type: 'row', children: [] } } } as never,
      {
        name: 'Start Now Team',
        folderPath: '/repo/seam-start-now',
        sprintEngineState: {
          ...state,
          // What run init wrote and the projection reads back — the single
          // source of truth every later reconcile of this seat uses.
          roleRuntimes: { architect: { cli: 'claude-code', model: 'claude-opus-5', reasoning: 'max' } },
        },
        sprintEngineRoleCliDefaults: { architect: 'claude-code', developer: 'claude-code' },
        sprintEngineRoleModelOverrides: { architect: 'claude-opus-5' },
        sprintEngineInitialSpawnRoles: ['architect'],
      } as never,
    )
    const workspace = useWorkspaceStore.getState().workspaces.find((entry) => entry.id === workspaceId)
    assert.deepEqual(
      workspace?.sprintEngineInitialSpawnAgentIds,
      ['architect'],
      'the architect is queued to launch immediately, before any projection lands',
    )
    const architect = workspace?.agents.architect
    assert.ok(architect, 'the architect seat was materialized at creation')
    assert.equal(architect.cliModel, 'claude-opus-5', 'the seeded record carries the model, as it always has')
    assert.equal(
      architect.cliReasoning,
      'max',
      'and it must carry the level too — this record IS what the immediate spawn launches with',
    )

    // Same record, rendered: the launched command, not the store.
    await usingBundledRegistry(() => {
      const command = buildAgentShellCommand({
        cli: architect.cli!,
        sessionId: 'seam-session',
        cliModel: architect.cliModel,
        cliReasoning: architect.cliReasoning,
      })
      assert.match(command, /--effort max/, `the first launch carries the wizard's level: ${command}`)
    })

    // And the seeded record must already agree with what the first projection
    // reconcile produces, so opening the board cannot change the seat's runtime
    // out from under a process that is already running.
    const reconciled = reconcileSprintEngineAgents(workspace!.agents, sprintEngineRunState(workspace!) as never)
    assert.equal(
      reconciled.architect?.cliReasoning,
      architect.cliReasoning,
      'the seeded level already matches the projection-resolved one',
    )
  })

  await check('SEAM: a level the seat’s CLI does not declare never reaches its command', async () => {
    // `ultra` is Codex's top level and is NOT one of claude-code's five. A run
    // whose roleRuntimes carry it (a hand-edited run.yaml, a seat whose CLI was
    // changed under it) must launch without the flag rather than with a value
    // the CLI would reject.
    await usingBundledRegistry(() => {
      const command = buildAgentShellCommand({
        cli: 'claude-code',
        sessionId: 'seam-session',
        cliReasoning: 'ultra',
      })
      assert.doesNotMatch(command, /--effort/, `an undeclared level renders no flag: ${command}`)
      const codex = renderAgentLaunchArgv({ cli: 'codex', sessionId: 'seam-session', cliReasoning: 'ultra' })
      assert.ok(
        codex.argv.some((token) => token.includes('ultra')),
        `and the CLI that DOES declare it still gets it: ${codex.argv.join(' ')}`,
      )
    })
  })

  // ── Seam 5: a CLI that declares no levels ──────────────────────────────────

  await check('SEAM: a CLI declaring no levels renders no picker — absent, not disabled, not empty', () => {
    // Grok's real manifest declares modelSelection and no reasoningSelection.
    const options = buildAgentCliCatalog(bundledCatalogEntries(['grok']) as never)
    assert.equal(options[0]?.reasoningSelection, undefined, 'the real manifest declares no levels')

    const view = mountListbox({
      options: options as never,
      currentCli: 'grok' as never,
      effectiveModelFor: () => 'grok-4.5',
      // BOTH accessors wired — the host offers effort, the CLI does not have it.
      effectiveReasoningFor: () => undefined,
      onSelectReasoning: () => {},
    })

    assert.ok(view.rows().length >= 2, 'the CLI and its models still render')
    assert.equal(view.pickers().length, 0, 'no picker anywhere')
    assert.equal(view.menuItems().length, 0, 'and no menu of levels behind it')
    const inert = [...view.rows()].flatMap((row) => [
      ...row.querySelectorAll('[disabled],[aria-disabled="true"]'),
    ])
    assert.equal(inert.length, 0, 'and nothing rendered disabled in its place')
    // Nothing explains the absence either — a row for a CLI without levels reads
    // exactly like a row for a CLI that has them and has none picked.
    const text = view.rows().map((row) => row.textContent ?? '').join(' ')
    assert.doesNotMatch(text, /effort|reasoning/i, `no copy names the missing control: ${text}`)
    view.unmount()
  })

  // ── Seam 6: the remaining shared-file pairs from the plan's Seams table ────

  await check('SEAM: settingsSlice — one selection type carries MC-1865’s catalog and MC-1870’s level together', () => {
    const normalized = normalizeAppSettings(
      {
        cliModelCatalog: PREVIOUS_BUILD_CATALOG,
        specialistModelDefaults: {
          ...PREVIOUS_BUILD_SELECTIONS,
          // Neither a model nor a level: not an override at all.
          tester: { cli: 'codex', model: '', reasoning: '  ' },
        },
      } as never,
      [],
    )
    assert.deepEqual(normalized.cliModelCatalog, PREVIOUS_BUILD_CATALOG)
    assert.deepEqual(normalized.specialistModelDefaults, PREVIOUS_BUILD_SELECTIONS)
    // Idempotent: the normalizer runs on every hydration, so a second pass over
    // its own output must not erode a level-only selection.
    assert.deepEqual(
      normalizeAppSettings(normalized as never, []).specialistModelDefaults,
      PREVIOUS_BUILD_SELECTIONS,
      'a level-only selection survives repeated hydration',
    )
  })

  await check('SEAM: cliRuntimeOptions — a level picked for one CLI never reaches another’s command', async () => {
    // The trap this guards: Codex and claude-code do not share a level set, and
    // the surfaces store ONE selection per surface.
    const codexPick = { cli: 'codex', model: 'gpt-5.6-sol', reasoning: 'high' } as never
    assert.equal(resolveCliReasoning('codex' as never, codexPick), 'high')
    assert.equal(
      resolveCliReasoning('claude-code' as never, codexPick),
      undefined,
      'the per-CLI guard drops it at resolution',
    )
    await usingBundledRegistry(() => {
      const command = buildAgentShellCommand({
        cli: 'claude-code',
        sessionId: 'seam-session',
        cliReasoning: resolveCliReasoning('claude-code' as never, codexPick),
      })
      assert.doesNotMatch(command, /--effort/, `and nothing leaks into the other CLI's command: ${command}`)
    })
  })

  await check('SEAM: model popover — a DISCOVERED row is selectable and the level rides beside it', async () => {
    // The file's two owners meet here: MC-1865 renders rows the manifest never
    // declared, MC-1884 puts an effort level on whatever runtime is selected. A
    // discovered row must be a first-class row, not a read-only annotation, and
    // the level must still write through from the surface that shows it.
    const discoveredId = 'claude-sonnet-5'
    const options = buildAgentCliCatalog(bundledCatalogEntries(['claude-code']) as never, undefined, {
      'claude-code': {
        models: [{ id: discoveredId, displayName: 'Sonnet 5' }],
        fetchedAt: '2026-07-28T00:00:00Z',
        source: 'agent-sdk',
      },
    } as never)
    const rows = options[0]?.modelSelection?.options ?? []
    assert.equal(
      (rows.find((model) => model.id === discoveredId) as { origin?: string } | undefined)?.origin,
      'discovered',
      'the discovered row merged in',
    )

    let picked: string | null | undefined
    const view = mountListbox({
      options: options as never,
      currentCli: 'claude-code' as never,
      effectiveModelFor: () => discoveredId,
      // Reads back what it was told, the way the real host's store does: a ramp
      // that never reflects its own writes cannot be walked past its first stop.
      effectiveReasoningFor: () => picked ?? undefined,
      onSelectReasoning: (_cli, reasoning) => {
        picked = reasoning
      },
    })
    const discoveredRow = view.rows().find((row) => row.textContent?.includes('Sonnet 5'))
    assert.ok(discoveredRow, 'the discovered row rendered')
    assert.equal(discoveredRow.getAttribute('aria-selected'), 'true', 'and it is the selected row')
    const trigger = view.pickers()[0]
    assert.ok(trigger, 'the reasoning selector rides the surface beside the model list')
    await view.click(trigger)
    await view.pickLevel('High')
    assert.equal(picked, 'high', 'and a level picked while a discovered row is selected writes through')
    view.unmount()
  })

  for (const unmount of mounted) unmount()

  if (failures > 0) {
    console.error(`\n${failures} model-catalog/effort seam checks failed`)
    process.exit(1)
  }
  console.log('modelCatalogEffortSeam.test.tsx: ok')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
