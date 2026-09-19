// T9 real-path verification: the shelf half of "shelf to pull request".
//
// Nothing on the path under test is stubbed. The bundle is the shipped starter
// under `resources/marketplace/plugins`, the installer is the real
// `installMarketplacePlugin`, the front door is the one `registerAutomationsIpc`
// returns, the store is `AutomationsStore` writing real files into a real git
// project, and the schedule is read back by a real `AutomationsEngine`. The
// only doubles are at the edges the shelf path does not own: the run executor
// (a recorder, so the harness does not launch an agent) and the MCP config
// service (this bundle has no MCP component).
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { installMarketplacePlugin } from '../modules/plugin-bundle-installer'
import { registerAutomationsIpc } from '../ipc/automations-ipc'
import { AutomationsStore, automationsStoreDirectory } from './store'
import { createBuiltInAutomationProviderRegistry } from './provider-registry'
import { AutomationsEngine } from './engine'
import { test } from 'vitest'

test('shelf-install-e2e', async () => {
  const REPO = resolve(__dirname, '../../..')
  const PLUGINS = join(REPO, 'resources/marketplace/plugins')
  const STARTERS = [
    'dead-code-sweep-automation',
    'duplication-review-automation',
    'merged-pr-seam-review-automation',
    'ui-ux-review-automation',
    'unit-test-coverage-automation',
  ]

  function record(step: string, detail: unknown): void {
    console.log(`  ${step}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
  }

  async function makeProject(name: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), `t9-${name}-`))
    execFileSync('git', ['init', '-q'], { cwd: root })
    execFileSync('git', ['config', 'user.email', 't9@example.test'], { cwd: root })
    execFileSync('git', ['config', 'user.name', 'T9'], { cwd: root })
    await writeFile(join(root, 'README.md'), '# t9\n')
    execFileSync('git', ['add', '-A'], { cwd: root })
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: root })
    return root
  }

  type FrontDoor = ReturnType<typeof registerAutomationsIpc>

  function frontDoorFor(roots: string[]): FrontDoor {
    const registry = createBuiltInAutomationProviderRegistry()
    return registerAutomationsIpc({ registerIpc: () => undefined }, {
      engine: {
        runNow: async () => ({
          ok: false as const,
          problem: { code: 'unused', message: 'run drive is a separate phase' },
        }),
        finalizeRun: async () => ({ ok: false as const, problem: { code: 'unused', message: 'unused' } }),
      },
      createStore: (workspaceRoot: string) => new AutomationsStore(workspaceRoot),
      triggerProviders: registry.listTriggerProviders(),
      actionProviders: registry.listActionProviders(),
      getWorkspaceSyncSnapshot: () => ({
        sequence: 1,
        state: {
          activeWorkspaceId: roots[0] ? 'ws-1' : null,
          primaryWorkspaceWindowId: 'primary',
          workspaceWindows: [],
          workspaces: roots.map((folderPath, index) => ({ id: `ws-${index + 1}`, folderPath })),
        },
      }),
    } as never)
  }

  // The wiring marketplace-plugin-ipc.ts uses, minus Electron's `app`.
  function installerServices(frontDoor: FrontDoor | null): never {
    return {
      trustContext: () => ({ trustedModules: new Map(), trustedKeyFingerprints: [] }),
      mcpConfigService: { sync: () => ({ ok: false, message: 'this bundle has no MCP component' }) },
      ...(frontDoor
        ? {
            installAutomationDefinition: async (input: never) => {
              const result = await frontDoor.installCatalogueDefinition(input)
              if (!result.ok) return result
              return {
                ok: true as const,
                value: { definition: result.value.definition, alreadyAdded: result.value.alreadyAdded },
              }
            },
          }
        : {}),
    } as never
  }

  async function pressGet(
    starter: string,
    input: { frontDoor: FrontDoor | null; workspaceRoot?: string; cli?: string | undefined },
  ): Promise<{ ok: boolean; message?: string; installed?: unknown }> {
    return (await installMarketplacePlugin(
      {
        localFolder: join(PLUGINS, starter),
        ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}),
        ...(input.cli === undefined ? {} : { automationDefaultCli: input.cli }),
      } as never,
      installerServices(input.frontDoor),
    )) as never
  }

  async function readStoreDefinitions(root: string): Promise<Array<Record<string, unknown>>> {
    const dir = join(root, automationsStoreDirectory(), 'definitions')
    const files = await readdir(dir).catch(() => [] as string[])
    const out: Array<Record<string, unknown>> = []
    for (const file of files.filter((name) => name.endsWith('.json')).sort()) {
      out.push(JSON.parse(await readFile(join(dir, file), 'utf8')))
    }
    return out
  }

  // Get on the shipped starter writes one definition whose every field the
  // install defaults own — read back from the file, not from the install result.
  async function assertGetWritesTheDefinitionTheInstallDefaultsPromise(): Promise<void> {
    const project = await makeProject('project')
    const frontDoor = frontDoorFor([project])
    const got = await pressGet(STARTERS[0], { frontDoor, workspaceRoot: project, cli: 'claude-code' })
    assert.equal(got.ok, true, `Get failed: ${got.message ?? ''}`)
    record('Get result', got.installed)

    const definitions = await readStoreDefinitions(project)
    assert.equal(definitions.length, 1, 'one Get writes exactly one definition')
    const definition = definitions[0]
    record('on-disk definition', definition)

    const manifest = JSON.parse(await readFile(join(PLUGINS, STARTERS[0], 'plugin.json'), 'utf8'))
    const payload = JSON.parse(await readFile(join(PLUGINS, STARTERS[0], 'automation/automation.json'), 'utf8'))

    assert.equal(definition.status, 'enabled', 'a starter lands enabled')
    assert.equal(definition.sourceCatalogueId, manifest.id, 'provenance records the shelf entry')
    assert.equal(definition.sourcePublisher, manifest.publisher, 'provenance records the publisher')
    assert.notEqual(definition.id, manifest.id, 'the store id is not the catalogue id')
    assert.notEqual(definition.id, payload.id, 'the store id is not the payload id')
    assert.equal('autonomyDefault' in definition, false, 'the retired field is never written')
    // `absent ⇒ run in a worktree` is the single place that answer lives, so the
    // field being absent — not `false` — is what makes the run isolated.
    assert.notEqual(definition.runInWorktree, false, 'a starter must never land opted out of worktree isolation')
    record(
      'runInWorktree on disk',
      'runInWorktree' in definition ? definition.runInWorktree : '<absent — resolves to true>',
    )
    assert.ok(
      typeof definition.nextRunAt === 'string' && definition.nextRunAt.length > 0,
      'the write computes a next run',
    )
    record('nextRunAt', definition.nextRunAt)

    // A second Get for the same starter in the same project resolves to the
    // definition already there rather than adding a duplicate.
    const second = await pressGet(STARTERS[0], { frontDoor, workspaceRoot: project, cli: 'claude-code' })
    assert.equal(second.ok, true, 'a duplicate Get is answered, not failed')
    record('duplicate Get result', second.installed)
    assert.match(
      JSON.stringify(second.installed),
      /Already added/u,
      'the duplicate says so rather than claiming a new add',
    )
    const afterSecond = await readStoreDefinitions(project)
    assert.equal(afterSecond.length, 1, 'a duplicate Get writes nothing')
    assert.equal(afterSecond[0].id, definition.id, 'a duplicate Get resolves to the same definition')
  }

  // Both preconditions the install cannot invent: a project to install into, and
  // a CLI for the agent it schedules. Each must refuse, and refuse before writing.
  async function assertMissingPreconditionsRefuseAndWriteNothing(): Promise<void> {
    const noProject = await pressGet(STARTERS[0], { frontDoor: frontDoorFor([]), cli: 'claude-code' })
    assert.equal(noProject.ok, false, 'Get with no active project must refuse')
    record('no active project', noProject.message)

    const project = await makeProject('nocli')
    const noCli = await pressGet(STARTERS[0], {
      frontDoor: frontDoorFor([project]),
      workspaceRoot: project,
      cli: undefined,
    })
    assert.equal(noCli.ok, false, 'Get with no last-selected CLI must refuse')
    record('no last-selected CLI', noCli.message)
    assert.equal((await readStoreDefinitions(project)).length, 0, 'a refused Get writes nothing')

    const noAutomations = await pressGet(STARTERS[0], { frontDoor: null, workspaceRoot: project, cli: 'claude-code' })
    assert.equal(noAutomations.ok, false, 'Get with Automations switched off must refuse')
    record('automations unavailable', noAutomations.message)
    assert.equal((await readStoreDefinitions(project)).length, 0, 'a refused Get writes nothing')
  }

  // All five shipped starters install side by side into one project with distinct
  // store ids — the shelf's own promise, and the collision the store id exists for.
  async function assertEveryShippedStarterInstalls(): Promise<void> {
    const project = await makeProject('all')
    const frontDoor = frontDoorFor([project])
    for (const starter of STARTERS) {
      const result = await pressGet(starter, { frontDoor, workspaceRoot: project, cli: 'claude-code' })
      assert.equal(result.ok, true, `${starter} failed to install: ${result.message ?? ''}`)
    }
    const definitions = await readStoreDefinitions(project)
    assert.equal(definitions.length, STARTERS.length, 'every starter landed')
    assert.equal(new Set(definitions.map((d) => d.id)).size, STARTERS.length, 'store ids are distinct')
    record(
      'five starters',
      definitions.map((d) => ({
        id: d.id,
        name: d.name,
        trigger: (d.trigger as Record<string, unknown>).kind,
        nextRunAt: d.nextRunAt,
      })),
    )
  }

  // The engine reads definitions on every tick, so one installed underneath a
  // running engine is scheduled by the next tick with no restart. Proved by
  // firing it: the recorder sees a run for an automation the engine never saw
  // when it started.
  async function assertALiveEngineSchedulesAnInstallWithoutRestart(): Promise<void> {
    const project = await makeProject('live')
    const frontDoor = frontDoorFor([project])
    const registry = createBuiltInAutomationProviderRegistry()
    const fired: string[] = []
    // One engine for the whole check, on a clock the harness moves. Constructing a
    // second engine to reach the due time would BE the restart this is proving is
    // unnecessary.
    let clock = Date.now()
    const engine = new AutomationsEngine({
      getProjectFolders: () => [{ workspaceId: 'ws-live', folderPath: project }],
      createStore: (root: string) => new AutomationsStore(root),
      triggerProviders: registry.listTriggerProviders(),
      now: () => clock,
      runAutomation: async (input: never) => {
        fired.push((input as unknown as { definition: { id: string } }).definition.id)
        return { status: 'completed' as const, summary: 'recorded by the harness' }
      },
    } as never)

    const before = await engine.tick()
    assert.equal(before.fired.length, 0, 'nothing to fire before the install')
    assert.equal(before.scheduled.length, 0, 'nothing scheduled before the install')

    // The shortest cadence the validator accepts, so the clock only has to move
    // minutes for the run to come due.
    const installed = await frontDoor.installCatalogueDefinition({
      workspaceRoot: project,
      sourceCatalogueId: 'sprintengine.t9-live-schedule',
      sourcePublisher: 'SprintEngine Labs',
      definition: {
        name: 'T9 live schedule',
        trigger: {
          kind: 'schedule',
          config: { kind: 'schedule', timezone: 'UTC', cadence: { type: 'interval', everyMinutes: 5 } },
        },
        action: { kind: 'spawn-agent', config: { prompt: 'recorded by the harness', cli: 'claude-code' } },
      },
    })
    assert.equal(installed.ok, true, `live install failed: ${installed.ok ? '' : installed.message}`)
    const automationId = installed.ok ? installed.value.definition.id : ''
    record('installed under a running engine', {
      automationId,
      nextRunAt: installed.ok ? installed.value.definition.nextRunAt : null,
    })

    const seen = await engine.tick()
    record('tick immediately after install', { scheduled: seen.scheduled.length, fired: seen.fired.length })
    assert.equal(seen.scheduled.length, 1, 'the engine picked up the new definition with no restart')
    assert.equal(seen.scheduled[0].automationId, automationId)

    clock += 6 * 60_000
    const dueTick = await engine.tick()
    record('tick once the schedule is due', {
      fired: dueTick.fired.map((run) => run.automationId),
      problems: dueTick.problems,
      executorSaw: fired,
    })
    assert.deepEqual(fired, [automationId], 'the automation the engine never started with is the one that fired')
  }

  async function main(): Promise<void> {
    console.log('shelf install e2e: Get writes the promised definition')
    await assertGetWritesTheDefinitionTheInstallDefaultsPromise()
    console.log('shelf install e2e: missing preconditions refuse')
    await assertMissingPreconditionsRefuseAndWriteNothing()
    console.log('shelf install e2e: every shipped starter installs')
    await assertEveryShippedStarterInstalls()
    console.log('shelf install e2e: a live engine schedules without a restart')
    await assertALiveEngineSchedulesAnInstallWithoutRestart()
    console.log('shelf install e2e tests passed')
  }

  const suiteRun = main().catch((error) => {
    console.error(error)
    process.exit(1)
  })

  await suiteRun
})
