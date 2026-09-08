// Opening a workspace installs the app's own plugin.
//
// The install itself is `skills/studio-plugin.test.ts`; this is the half that
// decides WHEN — the memo, the version key, the serialisation, the once-only
// acknowledgement, and the promise that a failure here never escapes into the
// path a person is waiting behind.

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import type { SkillHarness } from '../shared/skills'
import { createStudioPluginService, type StudioPluginServiceOptions } from './studio-plugin-service'

// These suites are bundled into node_modules/.cache before they run, so
// `__dirname` says nothing about where the source lives. `npm run` sets the cwd
// to the package root, which is the one anchor that survives bundling.
const TEMPLATE_ROOT = resolve(process.cwd(), 'resources', 'studio-plugin')

type Harness = {
  workspace: string
  userData: string
  warnings: string[]
  options: StudioPluginServiceOptions
}

async function harness(overrides: Partial<StudioPluginServiceOptions> = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'multicode-studio-service-'))
  const workspace = join(root, 'workspace')
  const userData = join(root, 'userData')
  await rm(workspace, { recursive: true, force: true })
  const { mkdir } = await import('node:fs/promises')
  await mkdir(workspace, { recursive: true })
  await mkdir(userData, { recursive: true })
  const reporter = join(root, 'multicode-agent-state.mjs')
  await writeFile(reporter, '// reporter\n', 'utf8')
  const warnings: string[] = []
  const options: StudioPluginServiceOptions = {
    resolveTemplateRoot: () => TEMPLATE_ROOT,
    resolveAgentStateReporterPath: () => reporter,
    resolveBridgeScriptPath: () => join(root, 'mcp-stdio-bridge.mjs'),
    resolveNodeCommand: () => join(root, 'Electron'),
    resolveUserDataDir: () => userData,
    resolveAgentStateSocketPath: () => join(userData, 'agent-state.sock'),
    listHarnesses: async (): Promise<SkillHarness[]> => ['agents'],
    logDiagnostic: (diagnostic) => warnings.push(`${diagnostic.title}: ${diagnostic.message}`),
    ...overrides,
  }
  return { workspace, userData, warnings, options }
}

async function openingAWorkspaceInstallsThePlugin(): Promise<void> {
  const { workspace, userData, warnings, options } = await harness()
  const service = createStudioPluginService(options)

  assert.equal(service.installed(workspace), null, 'nothing is claimed before an install runs')

  await service.ensureInstalledForRoots([workspace])

  const record = service.installed(workspace)
  assert.notEqual(record, null, `the open recorded an install; warnings=${JSON.stringify(warnings)}`)
  assert.equal(record?.version, '1.0.0')
  assert.equal(record?.claudePluginKey, 'sprintengine-studio@sprintengine-studio')
  assert.equal(record?.skillDirNames.length, 6)
  assert.equal(existsSync(join(workspace, '.agents', 'skills', 'studio-sprints', 'SKILL.md')), true)
  assert.equal(existsSync(join(workspace, '.multicode', 'studio-plugin')), true)
  assert.equal(existsSync(join(workspace, '.multicode', 'hooks', 'agent-state.mjs')), true)
  assert.equal(record?.hookSettingsPath, resolve(workspace, '.claude/settings.local.json'))
  assert.deepEqual(warnings, [], 'a clean open warns about nothing')

  // The acknowledgement is answered once, at first run, and recorded.
  const at = await service.hooksAcknowledgedAt()
  assert.notEqual(at, '')
  const stored = JSON.parse(await readFile(join(userData, 'studio-plugin.json'), 'utf8')) as {
    plugin: string
    hooksAcknowledgedAt: string
  }
  assert.equal(stored.plugin, 'sprintengine-studio')
  assert.equal(stored.hooksAcknowledgedAt, at)

  await rm(workspace, { recursive: true, force: true })
}

async function aSecondOpenDoesNotReinstall(): Promise<void> {
  let harnessReads = 0
  const built = await harness()
  const service = createStudioPluginService({
    ...built.options,
    listHarnesses: async () => {
      harnessReads += 1
      return ['agents']
    },
  })
  await service.ensureInstalled(built.workspace)
  assert.equal(harnessReads, 1)
  // Every accepted registry event runs a pass over every known root, so the
  // settled case has to cost nothing.
  await service.ensureInstalledForRoots([built.workspace, built.workspace])
  await service.ensureInstalled(built.workspace)
  assert.equal(harnessReads, 1, 'a workspace already installed this run is not installed again')
  await rm(built.workspace, { recursive: true, force: true })
}

async function concurrentOpensOfOneWorkspaceAreSerialised(): Promise<void> {
  const built = await harness()
  let concurrent = 0
  let peak = 0
  const service = createStudioPluginService({
    ...built.options,
    listHarnesses: async () => {
      concurrent += 1
      peak = Math.max(peak, concurrent)
      await new Promise((done) => setTimeout(done, 10))
      concurrent -= 1
      return ['agents']
    },
  })
  await Promise.all([
    service.ensureInstalled(built.workspace),
    service.ensureInstalled(built.workspace),
    service.ensureInstalled(built.workspace),
  ])
  // Two read-modify-writes of `.claude/settings.json` at once lose one of them.
  assert.equal(peak, 1, 'installs into one workspace never overlap')
  assert.notEqual(service.installed(built.workspace), null)
  await rm(built.workspace, { recursive: true, force: true })
}

async function aBuildWithNoPluginSaysSoAndInstallsNothing(): Promise<void> {
  const built = await harness({ resolveTemplateRoot: () => null })
  const service = createStudioPluginService(built.options)
  await service.ensureInstalled(built.workspace)
  assert.equal(await service.bundledVersion(), '')
  assert.equal(service.installed(built.workspace), null)
  assert.equal(existsSync(join(built.workspace, '.agents')), false)
  assert.equal(
    built.warnings.some((warning) => /missing from this build/.test(warning)),
    true,
    'a missing plugin is stated, not silent'
  )
  await rm(built.workspace, { recursive: true, force: true })
}

async function aMachineWithNoAgentCliInstallsNothingAndDoesNotThrow(): Promise<void> {
  const built = await harness({ listHarnesses: async () => [] })
  const service = createStudioPluginService(built.options)
  await service.ensureInstalled(built.workspace)
  assert.equal(service.installed(built.workspace), null)
  assert.equal(existsSync(join(built.workspace, '.agents')), false)
  await rm(built.workspace, { recursive: true, force: true })
}

async function aFailingInstallNeverEscapes(): Promise<void> {
  const built = await harness({
    listHarnesses: async () => {
      throw new Error('the harness probe fell over')
    },
  })
  const service = createStudioPluginService(built.options)
  // An app that refused to open a workspace because a skill could not be copied
  // would be worse than an app whose agent has to call sprintengine_help once.
  await service.ensureInstalled(built.workspace)
  assert.equal(
    built.warnings.some((warning) => /fell over/.test(warning)),
    true,
    'the failure is logged'
  )
  assert.equal(service.installed(built.workspace), null)

  // The chain is not poisoned: a later open retries rather than inheriting a
  // rejected promise.
  let retried = false
  const recovering = createStudioPluginService({
    ...built.options,
    listHarnesses: async () => {
      retried = true
      return ['agents']
    },
  })
  await recovering.ensureInstalled(built.workspace)
  assert.equal(retried, true)
  await rm(built.workspace, { recursive: true, force: true })
}

async function aMissingOrBlankRootIsSkipped(): Promise<void> {
  const built = await harness()
  const service = createStudioPluginService(built.options)
  const gone = join(built.workspace, 'not-here')
  await service.ensureInstalledForRoots(['', '   ', gone])
  assert.equal(service.installed(gone), null)
  assert.deepEqual(built.warnings, [], 'a workspace whose folder is gone is not an error to report')
  await rm(built.workspace, { recursive: true, force: true })
}

async function noSocketMeansNoHookButStillTheSkills(): Promise<void> {
  const built = await harness({ resolveAgentStateSocketPath: () => '' })
  const service = createStudioPluginService(built.options)
  await service.ensureInstalled(built.workspace)
  const record = service.installed(built.workspace)
  assert.equal(record?.skillDirNames.length, 5, 'the skills are what an agent reads; they still land')
  assert.equal(record?.hookSettingsPath, '', 'no hook is registered with nothing to report to')
  // And the question was never answered, because it was never asked.
  assert.equal(existsSync(join(built.userData, 'studio-plugin.json')), false)
  assert.equal(await service.hooksAcknowledgedAt(), '')
  await rm(built.workspace, { recursive: true, force: true })
}

async function main(): Promise<void> {
  await openingAWorkspaceInstallsThePlugin()
  await aSecondOpenDoesNotReinstall()
  await concurrentOpensOfOneWorkspaceAreSerialised()
  await aBuildWithNoPluginSaysSoAndInstallsNothing()
  await aMachineWithNoAgentCliInstallsNothingAndDoesNotThrow()
  await aFailingInstallNeverEscapes()
  await aMissingOrBlankRootIsSkipped()
  await noSocketMeansNoHookButStillTheSkills()
  console.log('studio plugin service: ok')
}

void main()
