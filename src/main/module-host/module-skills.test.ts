import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import type { IpcMain } from 'electron'

import type { EnsureSkillInstalledResult, ModuleSkillRegistration } from '../../shared/modules/skills'
import { loadMainModules, type CapabilityModule } from './load-modules'
import { createMainKernel, type ModuleSkillHostRegistry } from './main-host'
import { test } from 'vitest'

test('module-skills', async () => {
  // The host half of module-owned skills (WP-D). What is pinned here is the
  // surface a module sees — where its `sourceDir` is allowed to point, who owns
  // which id, and what unloading takes with it. The install mechanics themselves
  // live one layer down (src/main/builtin-skills.ts) and are covered there; this
  // file uses a recording registry so the host contract is testable without a
  // filesystem.

  function createFakeIpcMain(): IpcMain {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    return {
      handle(channel: string, handler: (...args: unknown[]) => unknown): void {
        handlers.set(channel, handler)
      },
      removeHandler(channel: string): void {
        handlers.delete(channel)
      },
    } as unknown as IpcMain
  }

  type RecordedRegistration = { moduleId: string; registrations: ModuleSkillRegistration[] }

  function createRecordingSkillRegistry(): {
    registry: ModuleSkillHostRegistry
    registered: RecordedRegistration[]
    unregistered: string[]
    ensured: Array<{ workspaceRoot: string; skillId: string }>
    owners: Map<string, string>
  } {
    const registered: RecordedRegistration[] = []
    const unregistered: string[] = []
    const ensured: Array<{ workspaceRoot: string; skillId: string }> = []
    const owners = new Map<string, string>()
    const registry: ModuleSkillHostRegistry = {
      register(moduleId, registrations) {
        for (const registration of registrations) {
          const owner = owners.get(registration.id)
          if (owner && owner !== moduleId) {
            throw new Error(`Skill "${registration.id}" is already registered by module "${owner}".`)
          }
        }
        for (const registration of registrations) owners.set(registration.id, moduleId)
        registered.push({ moduleId, registrations: [...registrations] })
      },
      unregister(moduleId) {
        unregistered.push(moduleId)
        for (const [id, owner] of [...owners]) {
          if (owner === moduleId) owners.delete(id)
        }
      },
      async ensureInstalled(workspaceRoot, skillId): Promise<EnsureSkillInstalledResult> {
        ensured.push({ workspaceRoot, skillId })
        return owners.has(skillId)
          ? { ok: true, status: 'installed' }
          : { ok: false, status: 'unknown-skill', message: `Unknown skill: ${skillId}` }
      },
    }
    return { registry, registered, unregistered, ensured, owners }
  }

  const REVIEW_ROOT = resolve('/tmp/multicode-modules/review')

  function testSourceDirResolvesAgainstTheModuleRoot(): void {
    const recorder = createRecordingSkillRegistry()
    const kernel = createMainKernel(createFakeIpcMain(), {
      resolveModuleRoot: (moduleId) => (moduleId === 'review' ? REVIEW_ROOT : undefined),
      skillRegistry: recorder.registry,
    })

    kernel.hostFor('review').registerSkills([
      {
        id: 'review-guide',
        sourceDir: 'skills/review-guide',
        targetPolicy: 'all-native',
        description: 'Walk a human reviewer through a code change.',
      },
      {
        id: 'studio-review',
        sourceDir: 'skills/studio-review',
        targetPolicy: 'all-native',
        description: 'Read and write Studio code reviews.',
      },
    ])

    assert.deepEqual(
      recorder.registered.map((entry) => ({
        moduleId: entry.moduleId,
        dirs: entry.registrations.map((registration) => registration.sourceDir),
      })),
      [
        {
          moduleId: 'review',
          dirs: [join(REVIEW_ROOT, 'skills', 'review-guide'), join(REVIEW_ROOT, 'skills', 'studio-review')],
        },
      ],
      'the host hands the registry absolute directories inside the module root',
    )
    assert.deepEqual(
      [...kernel.ownedSkills()],
      [
        ['review-guide', 'review'],
        ['studio-review', 'review'],
      ],
      'the kernel records which module owns which skill id',
    )
  }

  function testSourceDirMayNotEscapeTheModuleRoot(): void {
    const recorder = createRecordingSkillRegistry()
    const kernel = createMainKernel(createFakeIpcMain(), {
      resolveModuleRoot: () => REVIEW_ROOT,
      skillRegistry: recorder.registry,
    })
    const host = kernel.hostFor('review')

    for (const escape of ['../../etc/skills', '/etc/skills', '..', '']) {
      assert.throws(
        () => host.registerSkills([{ id: 'escapee', sourceDir: escape, targetPolicy: 'agents', description: 'no' }]),
        /must (resolve inside the module root|be a non-empty path)/,
        `"${escape}" must not resolve to a skill directory`,
      )
    }
    assert.deepEqual(recorder.registered, [], 'a rejected registration lands nothing')

    // A batch is resolved whole before any of it is registered: the second skill
    // escaping must not leave the first one installed behind it.
    assert.throws(
      () =>
        host.registerSkills([
          { id: 'ok', sourceDir: 'skills/ok', targetPolicy: 'agents', description: 'fine' },
          { id: 'bad', sourceDir: '../outside', targetPolicy: 'agents', description: 'nope' },
        ]),
      /must resolve inside the module root/,
    )
    assert.deepEqual(recorder.registered, [], 'a batch with one escape registers none of it')
  }

  function testBundledModulesPassAbsolutePaths(): void {
    const recorder = createRecordingSkillRegistry()
    const kernel = createMainKernel(createFakeIpcMain(), { skillRegistry: recorder.registry })
    const host = kernel.hostFor('bundled-thing')
    const shipped = resolve('/opt/multicode/resources/skills/shipped')

    // A bundled module's code is the app's; it has no install folder to be
    // contained by, so an absolute path is the only thing there is to resolve.
    assert.throws(
      () =>
        host.registerSkills([{ id: 'shipped', sourceDir: 'skills/shipped', targetPolicy: 'agents', description: 'x' }]),
      /must be an absolute path for a module with no module root/,
    )
    host.registerSkills([{ id: 'shipped', sourceDir: shipped, targetPolicy: 'agents', description: 'x' }])
    assert.equal(recorder.registered[0]?.registrations[0]?.sourceDir, shipped)
  }

  function testOwnershipIsTracked(): void {
    const recorder = createRecordingSkillRegistry()
    const kernel = createMainKernel(createFakeIpcMain(), {
      resolveModuleRoot: (moduleId) => resolve('/tmp/multicode-modules', moduleId),
      skillRegistry: recorder.registry,
    })

    kernel
      .hostFor('review')
      .registerSkills([
        { id: 'review-guide', sourceDir: 'skills/review-guide', targetPolicy: 'all-native', description: 'a' },
      ])
    assert.throws(
      () =>
        kernel
          .hostFor('impostor')
          .registerSkills([
            { id: 'review-guide', sourceDir: 'skills/review-guide', targetPolicy: 'agents', description: 'b' },
          ]),
      /already registered by module "review"/,
      'one skill id, one owner',
    )
  }

  async function testEnsureSkillInstalledDelegates(): Promise<void> {
    const recorder = createRecordingSkillRegistry()
    const kernel = createMainKernel(createFakeIpcMain(), {
      resolveModuleRoot: () => REVIEW_ROOT,
      skillRegistry: recorder.registry,
    })
    const host = kernel.hostFor('review')
    host.registerSkills([
      { id: 'studio-review', sourceDir: 'skills/studio-review', targetPolicy: 'all-native', description: 'a' },
    ])

    assert.deepEqual(await host.ensureSkillInstalled('/work/project', 'studio-review'), {
      ok: true,
      status: 'installed',
    })
    assert.deepEqual(
      await host.ensureSkillInstalled('/work/project', 'never-heard-of-it'),
      { ok: false, status: 'unknown-skill', message: 'Unknown skill: never-heard-of-it' },
      'an unknown id answers loudly rather than resolving to nothing',
    )
    assert.deepEqual(recorder.ensured, [
      { workspaceRoot: '/work/project', skillId: 'studio-review' },
      { workspaceRoot: '/work/project', skillId: 'never-heard-of-it' },
    ])
  }

  async function testUnloadingAModuleTakesItsSkills(): Promise<void> {
    const recorder = createRecordingSkillRegistry()
    const kernel = createMainKernel(createFakeIpcMain(), {
      resolveModuleRoot: () => REVIEW_ROOT,
      skillRegistry: recorder.registry,
    })
    kernel
      .hostFor('review')
      .registerSkills([
        { id: 'review-guide', sourceDir: 'skills/review-guide', targetPolicy: 'all-native', description: 'a' },
      ])

    await kernel.unregisterModule('review')

    assert.deepEqual(recorder.unregistered, ['review'])
    assert.deepEqual([...kernel.ownedSkills()], [], 'the kernel forgets the ids too')
    // The id is free again: the same skill may come back when the module reloads.
    kernel
      .hostFor('review')
      .registerSkills([
        { id: 'review-guide', sourceDir: 'skills/review-guide', targetPolicy: 'all-native', description: 'a' },
      ])
    assert.deepEqual([...kernel.ownedSkills()], [['review-guide', 'review']])
  }

  function testModuleRootsFlowThroughLoadMainModules(): void {
    const recorder = createRecordingSkillRegistry()
    const modules: CapabilityModule[] = [
      {
        manifest: {
          id: 'review',
          displayName: 'Reviews',
          version: 1,
          category: 'orchestration',
          source: 'third-party',
          defaultEnabled: true,
        },
        registerMain: (host) => {
          host.registerSkills([
            { id: 'review-guide', sourceDir: 'skills/review-guide', targetPolicy: 'all-native', description: 'a' },
          ])
        },
      },
    ]

    const { report } = loadMainModules({
      ipcMain: createFakeIpcMain(),
      modules,
      moduleRoots: { review: REVIEW_ROOT },
      skillRegistry: recorder.registry,
    })

    assert.deepEqual(report.errors, [])
    assert.equal(recorder.registered[0]?.registrations[0]?.sourceDir, join(REVIEW_ROOT, 'skills', 'review-guide'))
  }

  async function main(): Promise<void> {
    testSourceDirResolvesAgainstTheModuleRoot()
    console.log('ok - a registered sourceDir resolves against the module root')
    testSourceDirMayNotEscapeTheModuleRoot()
    console.log('ok - a sourceDir may not escape the module root')
    testBundledModulesPassAbsolutePaths()
    console.log('ok - a rootless bundled module registers an absolute directory')
    testOwnershipIsTracked()
    console.log('ok - one skill id has one owning module')
    await testEnsureSkillInstalledDelegates()
    console.log('ok - ensureSkillInstalled delegates and reports unknown ids')
    await testUnloadingAModuleTakesItsSkills()
    console.log('ok - unloading a module unregisters its skills')
    testModuleRootsFlowThroughLoadMainModules()
    console.log('ok - loadMainModules hands the kernel each module root')
  }

  const suiteRun = main().catch((error) => {
    console.error(error)
    process.exit(1)
  })

  await suiteRun
})
