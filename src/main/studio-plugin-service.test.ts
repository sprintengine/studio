// Opening a workspace installs the app's own plugin.
//
// The install itself is `skills/studio-plugin.test.ts`; this is the half that
// decides WHEN — the memo, the version key, the serialisation, the once-only
// acknowledgement, and the promise that a failure here never escapes into the
// path a person is waiting behind.

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
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
  assert.equal(record?.skillDirNames.length, 4)
  assert.equal(existsSync(join(workspace, '.agents', 'skills', 'studio-sprints', 'SKILL.md')), false)
  assert.equal(existsSync(join(workspace, '.agents', 'skills', 'studio-backlog', 'SKILL.md')), true)
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
  assert.equal(record?.skillDirNames.length, 4, 'the skills are what an agent reads; they still land')
  assert.equal(record?.hookSettingsPath, '', 'no hook is registered with nothing to report to')
  // And the question was never answered, because it was never asked.
  assert.equal(existsSync(join(built.userData, 'studio-plugin.json')), false)
  assert.equal(await service.hooksAcknowledgedAt(), '')
  await rm(built.workspace, { recursive: true, force: true })
}

// Once the launch hands Claude Code this app's plugin directories, a workspace
// stops receiving the Claude half of the install — AND the wiring an older
// release left in it is taken back out. Both matter: a stale hook beside the
// one the launch registers fires the reporter twice for every event.
async function launchInjectionTidiesTheWorkspaceAndSkipsClaude(): Promise<void> {
  const built = await harness({
    listHarnesses: async (): Promise<SkillHarness[]> => ['agents', 'claude'],
    resolveLaunchPluginsActive: () => true,
  })
  const { mkdir } = await import('node:fs/promises')

  // What an older release wrote into this workspace, plus settings of their own
  // in both files, which must survive untouched.
  await mkdir(join(built.workspace, '.claude', 'skills', 'studio-backlog'), { recursive: true })
  await writeFile(
    join(built.workspace, '.claude', 'skills', 'studio-backlog', '.multicode-skill.json'),
    `${JSON.stringify({ sourceId: 'sprintengine-studio', skillId: 'studio-backlog', commitSha: '0.0.1', installedAt: '2026-01-01T00:00:00.000Z' })}\n`,
    'utf8'
  )
  await mkdir(join(built.workspace, '.claude', 'skills', 'their-own-skill'), { recursive: true })
  await writeFile(join(built.workspace, '.claude', 'skills', 'their-own-skill', 'SKILL.md'), '# theirs\n', 'utf8')
  await mkdir(join(built.workspace, '.multicode', 'hooks'), { recursive: true })
  await writeFile(join(built.workspace, '.multicode', 'hooks', 'agent-state.mjs'), '// old reporter\n', 'utf8')
  await writeFile(
    join(built.workspace, '.claude', 'settings.local.json'),
    `${JSON.stringify(
      {
        hooks: {
          Stop: [
            {
              hooks: [
                {
                  type: 'command',
                  command: 'node "/ws/.multicode/hooks/agent-state.mjs" --socket "/tmp/old.sock"',
                  _multicode: 'multicode-agent-state',
                },
              ],
            },
          ],
        },
        extraKnownMarketplaces: { 'sprintengine-studio': { source: { source: 'directory', path: '/old/path' } } },
        theirLocalSetting: true,
      },
      null,
      2
    )}\n`,
    'utf8'
  )
  await writeFile(
    join(built.workspace, '.claude', 'settings.json'),
    `${JSON.stringify({ enabledPlugins: { 'sprintengine-studio@sprintengine-studio': true }, theirSetting: 'kept' }, null, 2)}\n`,
    'utf8'
  )

  const service = createStudioPluginService(built.options)
  await service.ensureInstalledForRoots([built.workspace])

  // The stale registration is gone, and so is the script it named.
  const local = JSON.parse(await readFile(join(built.workspace, '.claude', 'settings.local.json'), 'utf8')) as {
    hooks?: Record<string, unknown>
    extraKnownMarketplaces?: Record<string, unknown>
    theirLocalSetting?: boolean
  }
  assert.equal(
    JSON.stringify(local.hooks ?? {}).includes('agent-state.mjs'),
    false,
    'the hook this app wrote must be taken back out'
  )
  assert.equal(local.extraKnownMarketplaces, undefined, 'and the machine path with it')
  assert.equal(local.theirLocalSetting, true, 'their own settings are untouched')
  assert.equal(
    existsSync(join(built.workspace, '.multicode', 'hooks', 'agent-state.mjs')),
    false,
    'the reporter script the old hook named is removed, and never written back'
  )

  const project = JSON.parse(await readFile(join(built.workspace, '.claude', 'settings.json'), 'utf8')) as {
    enabledPlugins?: Record<string, boolean>
    theirSetting?: string
  }
  assert.equal(project.enabledPlugins, undefined, 'the plugin key is removed from the file a project commits')
  assert.equal(project.theirSetting, 'kept')

  // Our old skill copy is removed; a skill they wrote themselves is not.
  assert.equal(existsSync(join(built.workspace, '.claude', 'skills', 'studio-backlog')), false)
  assert.equal(existsSync(join(built.workspace, '.claude', 'skills', 'their-own-skill', 'SKILL.md')), true)

  // And nothing Claude-shaped was written back: the skills for the other
  // harnesses still install, because those CLIs still read them from here.
  const record = service.installed(built.workspace)
  assert.ok(record, 'the install still ran')
  assert.equal(record?.hookSettingsPath, '', 'no hook is registered when the launch carries it')
  assert.ok((record?.skillDirNames.length ?? 0) > 0, 'the other harnesses still get their skills')
  assert.equal(existsSync(join(built.workspace, '.agents', 'skills')), true)
  const claudeSkills = await readdir(join(built.workspace, '.claude', 'skills'))
  assert.deepEqual(claudeSkills, ['their-own-skill'], 'no studio skill is copied back into .claude')

  await rm(built.workspace, { recursive: true, force: true })
}

// The app-owned copy is materialised asynchronously at startup, so a workspace
// can be opened BEFORE it exists — that open installs the old way. When the
// copy lands, the next open must install again: otherwise the hook written into
// the workspace and the one the launch now registers both fire for every event,
// which is the doubling this whole arrangement exists to avoid.
async function aWorkspaceOpenedBeforeTheCopyLandedIsReinstalled(): Promise<void> {
  let active = false
  const built = await harness({
    listHarnesses: async (): Promise<SkillHarness[]> => ['agents', 'claude'],
    resolveLaunchPluginsActive: () => active,
  })
  const service = createStudioPluginService(built.options)

  await service.ensureInstalledForRoots([built.workspace])
  const before = service.installed(built.workspace)
  assert.ok(before?.hookSettingsPath, 'the early open registers the hook in the workspace')
  assert.equal(existsSync(join(built.workspace, '.multicode', 'hooks', 'agent-state.mjs')), true)

  active = true
  await service.ensureInstalledForRoots([built.workspace])
  const after = service.installed(built.workspace)
  assert.equal(after?.hookSettingsPath, '', 'the later open installs without the Claude half')
  assert.equal(
    (await readFile(join(built.workspace, '.claude', 'settings.local.json'), 'utf8')).includes('agent-state.mjs'),
    false,
    'and takes the hook the earlier open wrote back out'
  )
  assert.equal(
    existsSync(join(built.workspace, '.multicode', 'hooks', 'agent-state.mjs')),
    false,
    'along with the script it named'
  )

  // And it settles: a third open with nothing changed does no further work.
  const settled = service.installed(built.workspace)
  await service.ensureInstalledForRoots([built.workspace])
  assert.equal(service.installed(built.workspace)?.installedAt, settled?.installedAt, 'a settled workspace is left alone')

  await rm(built.workspace, { recursive: true, force: true })
}

async function main(): Promise<void> {
  await openingAWorkspaceInstallsThePlugin()
  await launchInjectionTidiesTheWorkspaceAndSkipsClaude()
  await aWorkspaceOpenedBeforeTheCopyLandedIsReinstalled()
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
