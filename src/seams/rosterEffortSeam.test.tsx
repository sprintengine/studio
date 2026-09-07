import assert from 'node:assert/strict'
import { join } from 'node:path'

import { installJsdomEnvironment } from './jsdomEnvironment'

// ── Seam: the wizard's effort producer reaches the spawned argv (MC-1885) ─────
//
// MC-1885 built every layer BELOW the wizard — the per-role map, the launch
// input, the seat runtime, the argv render — and proved them from a projection
// that already carried a level. MC-1884 built the picker and wired the agent
// composer. Neither could prove the sentence MC-1885's acceptance actually
// makes: "a seat configured with a non-default level IN THE WIZARD launches
// with the flag". Nothing populated `roleReasoningOverrides`, so the chain was
// broken in the middle and both suites passed anyway.
//
// This suite closes that gap by composing the real halves in order:
//
//   useRosterEditor (the wizard's own state)
//     → runSprintEngineNewTeamCreation (the real creation path, init captured)
//     → normalizeSprintEngineRoleRuntimes (the projection read)
//     → resolveSprintEngineAgentRuntime (the seat's effective runtime)
//     → renderAgentLaunchArgv against the REAL bundled manifests (argv)
//
// plus the two rendering questions a state test cannot reach: that the wizard's
// dense roster table renders the shared picker unchanged, and that a CLI which
// declares no levels renders no control at all.
//
// Labelled SEAM: per the run-A convention.

const dom = installJsdomEnvironment()

const BUNDLED_ROOT = join(process.cwd(), 'resources', 'plugins')

async function main(): Promise<void> {
  const React = (await import('react')).default
  const { act } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { useRosterEditor } = await import(
    '../renderer/src/components/workspace/newWorkspace/useRosterEditor'
  )
  const { SprintEngineRosterPanel } = await import(
    '../renderer/src/components/workspace/newWorkspace/SprintEngineRosterPanel'
  )
  const { SprintEngineRosterTable } = await import(
    '../renderer/src/components/workspace/newWorkspace/SprintEngineRosterTable'
  )
  const { runSprintEngineNewTeamCreation } = await import(
    '../renderer/src/components/workspace/newWorkspace/controllers/sprintEngineController'
  )
  const { buildSprintEngineRoleRegistry, normalizeSprintEngineRoleRuntimes, resolveSprintEngineAgentRuntime } = await import(
    '../shared/sprintengine/state'
  )
  const { renderAgentLaunchArgv } = await import('../main/agent-launch-render')
  const { createPluginRegistry } = await import('../main/plugin-registry')
  const { __resetPluginRegistryForTest, __setPluginRegistryForTest } = await import(
    '../main/plugin-registry-instance'
  )

  let failures = 0
  const check = async (name: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn()
      console.log(`ok - ${name}`)
    } catch (error) {
      failures += 1
      console.error(`not ok - ${name}`)
      console.error(error)
    }
  }

  // The real bundled manifests, so the flag under assertion is the one the CLI
  // documents rather than one this suite invented.
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

  type Editor = ReturnType<typeof useRosterEditor>
  const mounted: Array<() => void> = []

  // The wizard's roster editor, mounted for real (createRoot + act) so state
  // updates run through React exactly as they do in the wizard. Returns a live
  // accessor: the captured object is replaced on every render.
  async function captureEditor(): Promise<() => Editor> {
    let captured: Editor | null = null
    function Probe(): JSX.Element {
      captured = useRosterEditor({
        cliOptions: [],
        cliAvailabilityStatus: 'idle',
        workspaceRoot: null,
      })
      return <span />
    }
    const container = dom.window.document.createElement('div')
    dom.window.document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(<Probe />)
    })
    mounted.push(() => {
      root.unmount()
      container.remove()
    })
    if (!captured) throw new Error('the roster editor never rendered')
    return () => {
      if (!captured) throw new Error('the roster editor unmounted')
      return captured
    }
  }

  // The wizard's own launch step, driven through the REAL creation controller
  // rather than by calling `buildSprintEngineRoleRuntimes` here: the question is
  // whether the map the wizard holds is the one that reaches run init, and a
  // direct call to the builder would answer a question nobody asked. The init
  // port is a capture, so what is asserted is the payload the engine receives.
  const roleRuntimesFromWizardLaunch = async (editor: Editor): Promise<Record<string, unknown>> => {
    let captured: Record<string, unknown> | null = null
    await runSprintEngineNewTeamCreation(
      {
        folderPath: '/tmp/seam-effort-project',
        teamName: 'Effort seam',
        goal: 'prove the level reaches init',
        roleCounts: editor.roleCounts,
        visibleRoleCounts: editor.roleCounts,
        maxParallelAgents: 2,
        roleCliDefaults: editor.roleCliDefaults,
        roleModelOverrides: editor.roleModelOverrides,
        roleReasoningOverrides: editor.roleReasoningOverrides,
        startRunner: false,
        autoApproveArtifacts: false,
        cliPermissionPreset: 'manual',
      } as never,
      {
        pathExists: () => false,
        initializeSprintEngineState: async (input: Record<string, unknown>) => {
          captured = input
          return {
            ok: true,
            data: { projectionContent: JSON.stringify({ name: 'Effort seam', agents: {}, tasks: [] }) },
          }
        },
      } as never,
    )
    assert.ok(captured, 'the creation path called run init')
    return (captured as Record<string, unknown>).roleRuntimes as Record<string, unknown>
  }

  // From the init payload onward: the projection reads `roleRuntimes` back and
  // the seat resolves its effective runtime from them.
  const seatRuntimeFrom = (roleRuntimes: unknown, role: string) => {
    const projected = normalizeSprintEngineRoleRuntimes(roleRuntimes)
    return resolveSprintEngineAgentRuntime(projected ?? undefined, role as never, undefined)
  }

  await check('SEAM: a level picked in the wizard reaches the spawned argv as the CLI’s own flag', async () => {
    const editor = await captureEditor()
    await act(async () => {
      editor().onSetRoleCli('developer' as never, 'claude-code')
    })
    await act(async () => {
      editor().onSetRoleModel('developer' as never, 'claude-opus-5')
      editor().onSetRoleReasoning('developer' as never, 'high')
    })

    assert.equal(
      editor().roleReasoningOverrides.developer,
      'high',
      'the wizard state holds the picked level (this is the map MC-1885 built and nothing populated)',
    )

    const roleRuntimes = await roleRuntimesFromWizardLaunch(editor())
    assert.deepEqual(
      roleRuntimes.developer,
      { model: 'claude-opus-5', cli: 'claude-code', reasoning: 'high' },
      'the level rides the seat’s own roleRuntimes entry in the payload run init receives',
    )

    const seat = seatRuntimeFrom(roleRuntimes, 'developer')
    assert.equal(seat.cli, 'claude-code', 'the seat keeps its CLI')
    assert.equal(seat.cliModel, 'claude-opus-5', 'and its model')
    assert.equal(seat.cliReasoning, 'high', 'and the level survives init → projection → seat resolve')

    await usingBundledRegistry(() => {
      const rendered = renderAgentLaunchArgv({
        cli: seat.cli as 'claude-code',
        sessionId: 'seam-session',
        cliModel: seat.cliModel,
        cliReasoning: seat.cliReasoning,
      })
      // claude-code's manifest documents `--effort <level>`; asserting the
      // rendered pair (not just the substring "high") is what makes this the
      // CLI's documented flag rather than an accident of the model id.
      const argv = rendered.argv
      const flagIndex = argv.indexOf('--effort')
      assert.ok(flagIndex >= 0, `argv carries the effort flag: ${argv.join(' ')}`)
      assert.equal(argv[flagIndex + 1], 'high', 'and the level the wizard picked is its value')
    })
  })

  await check('SEAM: a seat with no level launches byte-identical argv to today', async () => {
    const editor = await captureEditor()
    await act(async () => {
      editor().onSetRoleCli('developer' as never, 'claude-code')
    })
    await act(async () => {
      editor().onSetRoleModel('developer' as never, 'claude-opus-5')
    })
    const seat = seatRuntimeFrom(await roleRuntimesFromWizardLaunch(editor()), 'developer')
    assert.equal(seat.cliReasoning, undefined, 'no level picked means no level resolved')

    await usingBundledRegistry(() => {
      const rendered = renderAgentLaunchArgv({
        cli: seat.cli as 'claude-code',
        sessionId: 'seam-session',
        cliModel: seat.cliModel,
        cliReasoning: seat.cliReasoning,
      })
      const baseline = renderAgentLaunchArgv({
        cli: seat.cli as 'claude-code',
        sessionId: 'seam-session',
        cliModel: seat.cliModel,
      })
      assert.deepEqual(rendered.argv, baseline.argv, 'argv is byte-identical to a pre-effort launch')
    })
  })

  await check('SEAM: changing a role’s CLI drops the level it picked for the old one', async () => {
    const editor = await captureEditor()
    await act(async () => {
      editor().onSetRoleCli('developer' as never, 'codex')
    })
    await act(async () => {
      editor().onSetRoleModel('developer' as never, 'gpt-5.5')
      editor().onSetRoleReasoning('developer' as never, 'ultra')
    })
    assert.equal(editor().roleReasoningOverrides.developer, 'ultra', 'precondition: the level is stored')

    // A model change WITHIN the CLI keeps it — the level is per-CLI, not
    // per-model.
    await act(async () => {
      editor().onSetRoleModel('developer' as never, 'gpt-5.6-sol')
    })
    assert.equal(editor().roleReasoningOverrides.developer, 'ultra', 'a model change inside one CLI keeps the level')

    // Switching CLIs drops it: `ultra` exists on Codex and not on Claude Code,
    // so carrying it across would offer a level the new CLI cannot run.
    await act(async () => {
      editor().onSetRoleCli('developer' as never, 'claude-code')
    })
    assert.ok(
      !('developer' in editor().roleReasoningOverrides),
      'the stored level is deleted, not blanked — same rule the model override follows',
    )
    assert.ok(
      !('developer' in editor().roleModelOverrides),
      'and the model override still drops with it (unchanged behaviour)',
    )

    const seat = seatRuntimeFrom(await roleRuntimesFromWizardLaunch(editor()), 'developer')
    assert.equal(seat.cliReasoning, undefined, 'so the launch carries no level either')
  })

  // ── Rendering: the wizard's two roster surfaces ────────────────────────────
  //
  // Codex declares levels; Kimi Code declares none. Shapes mirror the real
  // manifests so "declares no levels" is a genuine case, not a stub.
  // Post un-ship, a wizard surface offers only roles the registry resolves — and
  // `general` is no longer spliced in on top (MC-2057), so these mounts must
  // carry a registry or they render no rows at all.
  const SEAM_REGISTRY = buildSprintEngineRoleRegistry({
    roles: [{ id: 'developer', label: 'Developer', aliases: [], source: { layer: 'workspace' } }],
  }) as never

  const CLI_OPTIONS = [
    {
      value: 'codex',
      label: 'Codex',
      modelSelection: { options: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' }] },
      reasoningSelection: {
        levels: [
          { id: 'low', label: 'Low' },
          { id: 'medium', label: 'Medium' },
          { id: 'high', label: 'High' },
        ],
        default: 'medium',
      },
    },
    {
      value: 'kimi-code',
      label: 'Kimi Code',
      modelSelection: { options: [{ id: 'kimi-k3', label: 'Kimi K3' }] },
    },
  ] as never

  type TableView = {
    open: (label: string) => Promise<void>
    pickers: () => HTMLButtonElement[]
    rows: () => HTMLElement[]
    unmount: () => void
  }

  // Mount the dense roster table at its real call site shape, then open a row's
  // runtime popover the way a person does.
  async function mountTable(props: Record<string, unknown>): Promise<TableView> {
    const container = dom.window.document.createElement('div')
    dom.window.document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(
        <SprintEngineRosterTable
          roleCounts={{ developer: 1 } as never}
          roleCliDefaults={{ developer: 'codex' } as never}
          cliOptions={CLI_OPTIONS}
          registry={SEAM_REGISTRY}
          disabledRoleIds={null}
          countDisabled={false}
          cliDisabled={false}
          onSetCount={() => {}}
          onSetCli={() => {}}
          onSetModel={() => {}}
          roleModelOverrides={{ developer: 'gpt-5.6-sol' } as never}
          {...(props as unknown as Partial<Parameters<typeof SprintEngineRosterTable>[0]>)}
        />,
      )
    })
    const press = async (element: Element): Promise<void> => {
      await act(async () => {
        element.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }))
      })
      await act(async () => {
        element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
    }
    return {
      open: async (label: string) => {
        const trigger = [...container.querySelectorAll('button')].find((button) =>
          (button.getAttribute('aria-label') ?? '').startsWith(label),
        )
        assert.ok(trigger, `the ${label} runtime trigger exists`)
        await press(trigger)
      },
      pickers: () =>
        [...dom.window.document.body.querySelectorAll('[data-reasoning-trigger="true"]')] as never,
      rows: () =>
        [...dom.window.document.body.querySelectorAll('[data-model-row="true"]')] as never,
      unmount: () => {
        act(() => root.unmount())
        container.remove()
      },
    }
  }

  await check('SEAM: the dense roster table renders T5’s picker, one line tall and never wrapping', async () => {
    const written: Array<[string, string | null]> = []
    const view = await mountTable({
      roleReasoningOverrides: { developer: 'high' },
      onSetReasoning: (role: string, reasoning: string | null) => written.push([role, reasoning]),
    })
    await view.open('Developer agent runtime')
    assert.equal(view.pickers().length, 1, 'exactly one picker, on the selected row')

    // The table's layout is denser than the panel's, so the single-line contract
    // is asserted HERE and not only in the picker's own suite.
    for (const row of view.rows()) {
      assert.match(row.className, /items-center/, 'cells are centred on one line')
      assert.ok(!row.className.includes('flex-wrap'), 'a row may never wrap onto a second line')
      assert.ok(!row.className.includes('flex-col'), 'a row is never stacked')
      for (const cell of [...row.children].slice(1)) {
        const className = (cell as HTMLElement).className ?? ''
        assert.ok(
          typeof className !== 'string' || className.includes('shrink-0') || className.includes('flex-1'),
          `trailing cell "${className}" must be shrink-0 so the picker cannot force a wrap`,
        )
      }
    }

    // And it is wired, not decorative: picking a level calls back with the ROLE.
    const trigger = view.pickers()[0]
    await act(async () => {
      trigger.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }))
    })
    await act(async () => {
      trigger.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
    // Effort is a ramp on a slider, not a row per level: the stored level is the
    // stop it opens on, and one step down the ramp is the level before it.
    const slider = dom.window.document.body.querySelector('[data-slider="true"]')
    assert.ok(slider, 'the effort ramp is on the open surface')
    assert.equal(slider.getAttribute('aria-valuetext'), 'High', 'opened on the stored level')
    await act(async () => {
      slider.dispatchEvent(
        new dom.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }),
      )
    })
    assert.deepEqual(written, [['developer', 'medium']], 'the pick is written against the row’s role')
    view.unmount()
  })

  await check('SEAM: a CLI that declares no levels renders no picker in either wizard surface', async () => {
    const noLevels = {
      roleCliDefaults: { developer: 'kimi-code' },
      roleModelOverrides: { developer: 'kimi-k3' },
      roleReasoningOverrides: {},
    }
    const table = await mountTable({ ...noLevels, onSetReasoning: () => {} })
    await table.open('Developer agent runtime')
    assert.ok(table.rows().length > 0, 'the runtime list is open')
    assert.equal(table.pickers().length, 0, 'no levels declared means no control — not greyed, not empty')
    table.unmount()

    const panel = await mountPanel({ ...noLevels, onSetRoleReasoning: () => {} })
    await panel.open('Developer agent runtime')
    assert.ok(panel.rows().length > 0, 'the panel row’s runtime list is open')
    assert.equal(panel.pickers().length, 0, 'and the panel withholds it for the same reason')
    panel.unmount()
  })

  // The sprint wizard's Roster step, mounted at its real call-site shape.
  async function mountPanel(props: Record<string, unknown>): Promise<TableView> {
    const container = dom.window.document.createElement('div')
    dom.window.document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(
        <SprintEngineRosterPanel
          roleCounts={{ developer: 1 } as never}
          roleCliDefaults={{ developer: 'codex' } as never}
          roleModelOverrides={{ developer: 'gpt-5.6-sol' } as never}
          onSetRoleCount={() => {}}
          onSetRoleCli={() => {}}
          onSetRoleModel={() => {}}
          cliOptions={CLI_OPTIONS}
          registry={SEAM_REGISTRY}
          registryStatus="ready"
          disabledRoleIds={null}
          rosterDisabled={false}
          hasExistingTeam={false}
          rosters={[]}
          selectedRosterId={null}
          selectedRosterDirty={false}
          onSelectRoster={() => {}}
          onSaveRoster={() => {}}
          onUpdateRoster={() => {}}
          onRenameRoster={() => {}}
          onDeleteRoster={() => {}}
          {...(props as unknown as Partial<Parameters<typeof SprintEngineRosterPanel>[0]>)}
        />,
      )
    })
    return {
      open: async (label: string) => {
        const trigger = [...container.querySelectorAll('button')].find((button) =>
          (button.getAttribute('aria-label') ?? '').startsWith(label),
        )
        assert.ok(trigger, `the ${label} runtime trigger exists`)
        await act(async () => {
          trigger.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }))
        })
        await act(async () => {
          trigger.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
        })
      },
      pickers: () =>
        [...dom.window.document.body.querySelectorAll('[data-reasoning-trigger="true"]')] as never,
      rows: () =>
        [...dom.window.document.body.querySelectorAll('[data-model-row="true"]')] as never,
      unmount: () => {
        act(() => root.unmount())
        container.remove()
      },
    }
  }

  await check('SEAM: the roster panel’s role row renders the picker and writes through it', async () => {
    const written: Array<[string, string | null]> = []
    const view = await mountPanel({
      roleReasoningOverrides: { developer: 'high' },
      onSetRoleReasoning: (role: string, reasoning: string | null) => written.push([role, reasoning]),
    })
    await view.open('Developer agent runtime')
    assert.equal(view.pickers().length, 1, 'the selected row carries exactly one picker')
    for (const row of view.rows()) {
      assert.ok(!row.className.includes('flex-wrap'), 'the panel’s rows stay one line too')
    }
    const trigger = view.pickers()[0]
    assert.equal(
      trigger.getAttribute('aria-label'),
      'Reasoning for Developer agent runtime: High',
      'the stored level rides the control’s accessible name',
    )
    await act(async () => {
      trigger.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }))
    })
    await act(async () => {
      trigger.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
    const slider = dom.window.document.body.querySelector('[data-slider="true"]')
    assert.ok(slider, 'the effort ramp carries the CLI’s declared levels')
    assert.equal(slider.getAttribute('aria-valuetext'), 'High', 'opened on the stored level')
    await act(async () => {
      slider.dispatchEvent(
        new dom.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }),
      )
    })
    assert.deepEqual(written, [['developer', 'medium']], 'the pick reaches the wizard’s own setter')
    view.unmount()
  })

  await check('SEAM: a host that wires no effort producer renders no picker in either surface', async () => {
    // Both surfaces with the props omitted entirely — the saved-roster manager
    // and an existing run land here, and both must show nothing.
    const table = await mountTable({})
    await table.open('Developer agent runtime')
    // The list being OPEN is what makes the absence meaningful: a closed
    // popover would report zero pickers while proving nothing.
    assert.ok(table.rows().length > 0, 'the runtime list is open')
    assert.equal(table.pickers().length, 0, 'the table offers no effort control without a producer')
    table.unmount()

    const panel = await mountPanel({})
    await panel.open('Developer agent runtime')
    assert.ok(panel.rows().length > 0, 'the panel row’s runtime list is open')
    assert.equal(panel.pickers().length, 0, 'the panel offers no effort control without a producer either')
    panel.unmount()
  })

  await check('SEAM: a saved roster does not carry a level, and reloading one clears the hand-tuned levels', async () => {
    const { useWorkspaceStore } = await import('../renderer/src/store/workspaceStore')
    const editor = await captureEditor()
    await act(async () => {
      editor().onSetRoleCli('developer' as never, 'codex')
    })
    await act(async () => {
      editor().onSetRoleModel('developer' as never, 'gpt-5.6-sol')
      editor().onSetRoleReasoning('developer' as never, 'high')
    })
    await act(async () => {
      editor().onSaveRoster('Effort preset')
    })
    await act(async () => { await Promise.resolve() })

    const saved = useWorkspaceStore.getState().appSettings.sprintEngineRoleSettings
      .savedRosters?.find((entry) => entry.name === 'Effort preset')
    assert.ok(saved, 'the roster saved')
    // The ruling, asserted rather than assumed: a preset stores the model and
    // NOT the level, because storing it is a store-schema change this run's
    // pinned versions (69, 70) will not take.
    assert.ok(
      !Object.keys(saved).some((key) => key.toLowerCase().includes('reasoning')),
      `no effort member rides the saved roster: ${Object.keys(saved).join(', ')}`,
    )

    // And reloading it clears the hand-tuned levels rather than silently
    // applying them to whatever CLIs the preset staffs.
    await act(async () => {
      editor().onSelectRoster(saved.id)
    })
    assert.deepEqual(editor().roleReasoningOverrides, {}, 'loading a preset resets the levels')
  })

  await check('SEAM: no store schema moved for this producer', async () => {
    const { WORKSPACE_STORE_VERSION } = await import(
      '../renderer/src/store/slices/persistenceSlice'
    )
    const { readFileSync } = await import('node:fs')
    // The wizard's level is session state: the effort producer (MC-1870) took
    // exactly one rung, v70, and nothing after it may quietly become a second.
    //
    // 2026-09-06: this asserted `WORKSPACE_STORE_VERSION === 70` and now reads
    // the ladder instead. The counter moved to 74 on four rungs that have
    // nothing to do with effort — v71 the module-owned workspace-state bag
    // (MC-1573, bb0e992ae), v72 the retired title-bar specialist default
    // (MC-2222, 60fbc1f15), v73 and v74 the rail → pane layout heals
    // (48cc7ce5d, 023c9fa76) — so the pin was failing on other people's work
    // while saying nothing about this producer, and it sat unread for days
    // because verify:app halts long before this step. Pinning a GLOBAL counter
    // to state a LOCAL invariant is the defect; the invariant is which rungs
    // carry effort, so ask the ladder that directly and it stops rotting.
    assert.ok(
      WORKSPACE_STORE_VERSION >= 70,
      `the effort rung is still in the ladder (store version ${WORKSPACE_STORE_VERSION})`,
    )
    // [pre, "69", body69, "70", body70, …] — the capture makes split() hand
    // back each rung's number beside the text that belongs to it.
    const parts = readFileSync(
      join(process.cwd(), 'src/renderer/src/store/slices/persistenceSlice.ts'),
      'utf8',
    ).split(/\n {2}if \(version < (\d+)\) \{/)
    const rungs = new Map<number, string>()
    for (let i = 1; i < parts.length; i += 2) rungs.set(Number(parts[i]), parts[i + 1] ?? '')
    // Anchor first: a scan that matched nothing would pass this check vacuously
    // and hide the very rung it exists to watch.
    assert.match(
      rungs.get(70) ?? '',
      /reasoning/i,
      'v70 is still the one rung the effort producer added',
    )
    assert.deepEqual(
      [...rungs].filter(([at, body]) => at > 70 && /reasoning|effort/i.test(body)).map(([at]) => `v${at}`),
      [],
      'a second effort migration entered the ladder above v70 — the ordering hazard the ruling exists to avoid',
    )
  })

  // The creation surface's launch call site cannot be observed from a mounted
  // row: the question is whether the picked map is handed to the creation
  // controller at all. Asserted at the source, the way MC-1884's suite asserts
  // its own host wiring. The wizard's sprint paths died with MC-2062; the New
  // sprint dialog is the one run-creating surface now.
  await check('SEAM: the New sprint dialog hands the level into run init beside the model', async () => {
    const { readFileSync } = await import('node:fs')
    const source = readFileSync(
      join(process.cwd(), 'src/renderer/src/components/workspace/newSprint/NewSprintDialog.tsx'),
      'utf8',
    )
    assert.match(
      source,
      /roleModelOverrides: editor\.roleModelOverrides,\n\s*roleReasoningOverrides: editor\.roleReasoningOverrides,/,
      'the dialog create carries the map into init beside the model picks',
    )
  })

  for (const unmount of mounted) unmount()

  if (failures > 0) {
    console.error(`\n${failures} roster-effort seam checks failed`)
    process.exit(1)
  }
  console.log('rosterEffortSeam.test.tsx: ok')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
