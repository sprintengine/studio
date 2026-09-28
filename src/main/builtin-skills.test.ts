import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { LoadedPlugin } from '../shared/plugin-manifest'
import {
  BUILTIN_SKILLS,
  BUILTIN_SKILLS_RESOURCE_DIR,
  pruneRetiredBuiltinSkillCopies,
  RETIRED_BUILTIN_SKILL_IDS,
  createBuiltinSkillManager,
  ensureSkillInstalled,
  findModuleSkill,
  listModuleSkills,
  registerModuleSkills,
  resolveSkillById,
  setDefaultSkillManager,
  unregisterModuleSkills,
  writeManagedSkillManifest,
} from './builtin-skills'
import { test } from 'vitest'

test('builtin-skills', async () => {
  async function writeSkillSource(root: string, skillId: string, body: string): Promise<void> {
    const skillRoot = join(root, skillId)
    await mkdir(join(skillRoot, 'agents'), { recursive: true })
    await writeFile(join(skillRoot, 'SKILL.md'), body, 'utf-8')
    await writeFile(join(skillRoot, 'agents', 'openai.yaml'), `display_name: ${skillId}\n`, 'utf-8')
  }

  async function writeAllSkillSources(root: string, body: string): Promise<void> {
    for (const skill of BUILTIN_SKILLS) {
      await writeSkillSource(root, skill.id, body)
    }
  }

  // Two native-harness CLI plugins, enough to prove an all-native fan-out lands
  // in more than the harness-neutral .agents directory.
  function claudePlugin(temp: string): LoadedPlugin {
    return {
      source: 'bundled',
      manifestPath: join(temp, 'plugins', 'claude-code', 'plugin.json'),
      pluginRoot: join(temp, 'plugins', 'claude-code'),
      manifest: {
        id: 'claude-code',
        displayName: 'Claude Code',
        version: 1,
        binary: 'claude',
        permissionPresets: { default: { label: 'Default', args: [] } },
        launch: { argv: ['claude'] },
        promptInjection: { mode: 'positional-arg' },
        completion: { mode: 'process-exit' },
        capabilities: { resumeSession: true, sessionIdFromCaller: true, toolUse: true, mcpServers: true },
        skillIntegration: {
          support: 'native',
          harnessId: 'claude',
          installTargets: [
            {
              scope: 'workspace',
              path: '{{workspaceRoot}}/.claude/skills/{{skillId}}',
              format: 'claude-code',
              restartRequired: true,
            },
          ],
        },
      },
    }
  }

  function piPlugin(temp: string): LoadedPlugin {
    return {
      source: 'user',
      manifestPath: join(temp, 'plugins', 'pi', 'plugin.json'),
      pluginRoot: join(temp, 'plugins', 'pi'),
      manifest: {
        id: 'pi',
        displayName: 'Pi',
        version: 1,
        binary: 'pi',
        permissionPresets: { default: { label: 'Default', args: [] } },
        launch: { argv: ['pi'] },
        promptInjection: { mode: 'stdin-pipe' },
        completion: { mode: 'process-exit' },
        capabilities: { resumeSession: false, sessionIdFromCaller: false, toolUse: false, mcpServers: false },
        skillIntegration: {
          support: 'native',
          harnessId: 'pi',
          installTargets: [{ scope: 'workspace', path: '{{workspaceRoot}}/.pi/skills/{{skillId}}', format: 'generic' }],
        },
      },
    }
  }

  async function main(): Promise<void> {
    // The directory is named from the constant `builtinSkillSourceRoot()` builds
    // it from, not spelled again here: the skills have moved twice (into the
    // marketplace on 2026-09-06, out again on 2026-09-28), and a path written
    // out by hand would go on passing after the next move.
    const shipped = join(process.cwd(), 'resources', BUILTIN_SKILLS_RESOURCE_DIR)
    for (const skill of BUILTIN_SKILLS) {
      const realSkill = await readFile(join(shipped, skill.id, 'SKILL.md'), 'utf-8')
      assert.match(realSkill, new RegExp(`name:\\s*${skill.id}`))
      await readFile(join(shipped, skill.id, 'agents', 'openai.yaml'), 'utf-8')
    }

    const temp = await mkdtemp(join(tmpdir(), 'sprintengine-builtin-skills-'))
    const sourceRoot = join(temp, 'source')
    const workspaceRoot = join(temp, 'workspace')
    await mkdir(workspaceRoot, { recursive: true })
    await writeAllSkillSources(sourceRoot, 'version one\n')

    const loadedPlugins: LoadedPlugin[] = [
      {
        source: 'bundled',
        manifestPath: join(temp, 'plugins', 'claude-code', 'plugin.json'),
        pluginRoot: join(temp, 'plugins', 'claude-code'),
        manifest: {
          id: 'claude-code',
          displayName: 'Claude Code',
          version: 1,
          binary: 'claude',
          permissionPresets: { default: { label: 'Default', args: [] } },
          launch: { argv: ['claude'] },
          promptInjection: { mode: 'positional-arg' },
          completion: { mode: 'process-exit' },
          capabilities: { resumeSession: true, sessionIdFromCaller: true, toolUse: true, mcpServers: true },
          skillIntegration: {
            support: 'native',
            harnessId: 'claude',
            installTargets: [
              {
                scope: 'workspace',
                path: '{{workspaceRoot}}/.claude/skills/{{skillId}}',
                format: 'claude-code',
                restartRequired: true,
              },
            ],
            invocation: { fileDropTemplate: '/{{skillId}} {{path}}' },
          },
        },
      },
      {
        // Mirrors the real bundled registry: zai rides the Claude harness and
        // renders the SAME install path as claude-code. skillTargets must dedupe
        // by resolved destination or install() cp's the path twice and the
        // second copy dies ERR_FS_CP_EEXIST (the skill-picker Install bug).
        source: 'bundled',
        manifestPath: join(temp, 'plugins', 'zai', 'plugin.json'),
        pluginRoot: join(temp, 'plugins', 'zai'),
        manifest: {
          id: 'zai',
          displayName: 'Z.ai GLM',
          version: 1,
          binary: 'claude',
          permissionPresets: { default: { label: 'Default', args: [] } },
          launch: { argv: ['claude'] },
          promptInjection: { mode: 'positional-arg' },
          completion: { mode: 'process-exit' },
          capabilities: { resumeSession: true, sessionIdFromCaller: true, toolUse: true, mcpServers: true },
          skillIntegration: {
            support: 'native',
            harnessId: 'claude',
            installTargets: [
              {
                scope: 'workspace',
                path: '{{workspaceRoot}}/.claude/skills/{{skillId}}',
                format: 'claude-code',
                restartRequired: true,
              },
            ],
            invocation: { fileDropTemplate: '/{{skillId}} {{path}}' },
          },
        },
      },
      {
        source: 'user',
        manifestPath: join(temp, 'plugins', 'pi', 'plugin.json'),
        pluginRoot: join(temp, 'plugins', 'pi'),
        manifest: {
          id: 'pi',
          displayName: 'Pi',
          version: 1,
          binary: 'pi',
          permissionPresets: { default: { label: 'Default', args: [] } },
          launch: { argv: ['pi'] },
          promptInjection: { mode: 'stdin-pipe' },
          completion: { mode: 'process-exit' },
          capabilities: { resumeSession: false, sessionIdFromCaller: false, toolUse: false, mcpServers: false },
          skillIntegration: {
            support: 'native',
            harnessId: 'pi',
            installTargets: [
              {
                scope: 'workspace',
                path: '{{workspaceRoot}}/.pi/skills/{{skillId}}',
                format: 'generic',
              },
            ],
          },
        },
      },
      {
        source: 'user',
        manifestPath: join(temp, 'plugins', 'shim', 'plugin.json'),
        pluginRoot: join(temp, 'plugins', 'shim'),
        manifest: {
          id: 'shim',
          displayName: 'Shim CLI',
          version: 1,
          binary: 'shim',
          permissionPresets: { default: { label: 'Default', args: [] } },
          launch: { argv: ['shim'] },
          promptInjection: { mode: 'stdin-pipe' },
          completion: { mode: 'process-exit' },
          capabilities: { resumeSession: false, sessionIdFromCaller: false, toolUse: false, mcpServers: false },
          skillIntegration: {
            support: 'prompt-shim',
            harnessId: 'shim',
            invocation: { fileDropTemplate: 'Use {{skillName}} for {{path}}' },
          },
        },
      },
      {
        source: 'bundled',
        manifestPath: join(temp, 'plugins', 'generic-shell', 'plugin.json'),
        pluginRoot: join(temp, 'plugins', 'generic-shell'),
        manifest: {
          id: 'generic-shell',
          displayName: 'Generic Shell',
          version: 1,
          binary: 'sh',
          permissionPresets: { default: { label: 'Default', args: [] } },
          launch: { argv: ['sh'] },
          promptInjection: { mode: 'stdin-pipe' },
          completion: { mode: 'process-exit' },
          capabilities: { resumeSession: false, sessionIdFromCaller: false, toolUse: false, mcpServers: false },
          skillIntegration: { support: 'unsupported', harnessId: 'generic-shell' },
        },
      },
    ]

    const manager = createBuiltinSkillManager({ sourceRoot, listPlugins: () => loadedPlugins })
    const listed = await manager.list()
    // The one a prompt invokes; the workflow skills and `debug` are retired.
    assert.deepEqual(
      listed.map((skill) => skill.id),
      ['backlog'],
    )
    assert.equal(
      (await manager.getStatus(workspaceRoot, 'debug')).ok,
      false,
      'debug is no longer a skill this installer knows',
    )
    await writeAllSkillSources(sourceRoot, 'version two\n')

    // Multi-target skills install one managed copy for .agents plus each native
    // CLI plugin adapter. Prompt-shim and unsupported adapters are reported but
    // do not get fake native files.
    const harnessDirs = ['.agents', '.claude', '.pi']
    const backlogMissing = await manager.getStatus(workspaceRoot, 'backlog')
    assert.equal(backlogMissing.ok, true)
    assert.equal(backlogMissing.ok && backlogMissing.status, 'missing')
    assert.equal(backlogMissing.ok && backlogMissing.targets.length, 5)
    assert.equal(
      backlogMissing.ok && backlogMissing.targets.find((target) => target.harness === 'shim')?.status,
      'prompt-shim',
    )
    assert.equal(
      backlogMissing.ok && backlogMissing.targets.find((target) => target.harness === 'generic-shell')?.status,
      'unsupported',
    )

    const backlogInstalled = await manager.install(workspaceRoot, 'backlog')
    assert.equal(backlogInstalled.ok, true)
    assert.equal(backlogInstalled.ok && backlogInstalled.status, 'installed')
    for (const dir of harnessDirs) {
      assert.equal(await readFile(join(workspaceRoot, dir, 'skills', 'backlog', 'SKILL.md'), 'utf-8'), 'version two\n')
    }

    const backlogStatus = await manager.getStatus(workspaceRoot, 'backlog')
    assert.equal(backlogStatus.ok, true)
    assert.equal(backlogStatus.ok && backlogStatus.status, 'installed')
    // Regression (skill-picker Install EEXIST): claude-code and zai render the
    // same .claude destination — exactly one path-bearing target may survive.
    const backlogClaudePath = join(workspaceRoot, '.claude', 'skills', 'backlog')
    assert.equal(
      backlogStatus.ok && backlogStatus.targets.filter((target) => target.destinationPath === backlogClaudePath).length,
      1,
      'duplicate plugin install paths dedupe to one target',
    )

    // A modified copy in one harness is skipped, not a block on the others.
    await writeFile(join(workspaceRoot, '.claude', 'skills', 'backlog', 'SKILL.md'), 'local claude edit\n', 'utf-8')
    const backlogModified = await manager.getStatus(workspaceRoot, 'backlog')
    assert.equal(backlogModified.ok, true)
    assert.equal(backlogModified.ok && backlogModified.status, 'modified')

    await writeAllSkillSources(sourceRoot, 'version three\n')
    const backlogStale = await manager.getStatus(workspaceRoot, 'backlog')
    assert.equal(backlogStale.ok, true)
    assert.equal(backlogStale.ok && backlogStale.status, 'update-available')

    const backlogUpdated = await manager.install(workspaceRoot, 'backlog')
    assert.equal(backlogUpdated.ok, true)
    assert.equal(backlogUpdated.ok && backlogUpdated.status, 'updated')
    assert.equal(backlogUpdated.ok && backlogUpdated.skipped?.length, 1)
    assert.equal(backlogUpdated.ok && backlogUpdated.skipped?.[0]?.harness, 'claude')
    assert.equal(
      await readFile(join(workspaceRoot, '.claude', 'skills', 'backlog', 'SKILL.md'), 'utf-8'),
      'local claude edit\n',
    )
    assert.equal(
      await readFile(join(workspaceRoot, '.agents', 'skills', 'backlog', 'SKILL.md'), 'utf-8'),
      'version three\n',
    )
    assert.equal(
      await readFile(join(workspaceRoot, '.pi', 'skills', 'backlog', 'SKILL.md'), 'utf-8'),
      'version three\n',
    )

    await testModuleOwnedSkills()
  }

  // Module-owned skills (WP-D). A skill a capability module ships must be a
  // skill: same resolution at the launch boundary, same all-native fan-out, same
  // managed manifest. The only difference is where its bytes come from and how
  // long it lives — the module's own tree, and the module's own lifetime.
  async function testModuleOwnedSkills(): Promise<void> {
    const temp = await mkdtemp(join(tmpdir(), 'sprintengine-module-skills-'))
    const bundledRoot = join(temp, 'bundled')
    const moduleRoot = join(temp, 'modules', 'review')
    const workspaceRoot = join(temp, 'workspace')
    await mkdir(workspaceRoot, { recursive: true })
    await writeAllSkillSources(bundledRoot, 'bundled\n')
    await writeSkillSource(join(moduleRoot, 'skills'), 'review-guide-module', 'module version one\n')

    const manager = createBuiltinSkillManager({
      sourceRoot: bundledRoot,
      listPlugins: () => [claudePlugin(temp), piPlugin(temp)],
    })
    setDefaultSkillManager(manager)

    // Unknown before registration — and loudly so, rather than a silent no-op.
    assert.equal(resolveSkillById('review-guide-module'), null)
    assert.deepEqual(await ensureSkillInstalled(workspaceRoot, 'review-guide-module'), {
      ok: false,
      status: 'unknown-skill',
      message: 'Unknown skill: review-guide-module',
    })

    registerModuleSkills('review', [
      {
        id: 'review-guide-module',
        sourceDir: join(moduleRoot, 'skills', 'review-guide-module'),
        targetPolicy: 'all-native',
        description: 'Walk a human reviewer through a code change.',
      },
    ])

    const resolved = resolveSkillById('review-guide-module')
    assert.equal(resolved?.id, 'review-guide-module')
    assert.equal(resolved?.name, 'Review Guide Module', 'the display name is derived from the id')
    assert.equal(resolved?.targetPolicy, 'all-native')
    assert.equal(findModuleSkill('review-guide-module')?.moduleId, 'review')
    assert.deepEqual(
      (await manager.list()).map((skill) => skill.id).slice(-1),
      ['review-guide-module'],
      'a registered module skill joins the listed skills',
    )

    // The install fan-out is the built-in one: .agents plus every native CLI dir.
    const installed = await ensureSkillInstalled(workspaceRoot, 'review-guide-module')
    assert.deepEqual(installed, { ok: true, status: 'installed' })
    for (const dir of ['.agents', '.claude', '.pi']) {
      assert.equal(
        await readFile(join(workspaceRoot, dir, 'skills', 'review-guide-module', 'SKILL.md'), 'utf-8'),
        'module version one\n',
        `an all-native module skill installs into ${dir}/skills`,
      )
    }
    // The managed manifest is written, so a second ensure is a no-op rather than
    // a rewrite — the same check-first contract the bundled skills get.
    assert.deepEqual(await ensureSkillInstalled(workspaceRoot, 'review-guide-module'), {
      ok: true,
      status: 'installed',
    })

    // Source bytes come from the module's tree: changing them there makes the
    // installed copy stale, and the next ensure updates it.
    await writeSkillSource(join(moduleRoot, 'skills'), 'review-guide-module', 'module version two\n')
    assert.deepEqual(await ensureSkillInstalled(workspaceRoot, 'review-guide-module'), {
      ok: true,
      status: 'updated',
    })
    assert.equal(
      await readFile(join(workspaceRoot, '.claude', 'skills', 'review-guide-module', 'SKILL.md'), 'utf-8'),
      'module version two\n',
    )

    // One id, one owner — a built-in's id and another module's id are both taken.
    assert.throws(
      () =>
        registerModuleSkills('impostor', [
          { id: 'review-guide-module', sourceDir: join(temp, 'other'), targetPolicy: 'agents', description: 'x' },
        ]),
      /already registered by module "review"/,
    )
    assert.throws(
      () =>
        registerModuleSkills('impostor', [
          { id: 'backlog', sourceDir: join(temp, 'other'), targetPolicy: 'agents', description: 'x' },
        ]),
      /is a built-in skill/,
    )
    // The whole batch is validated before any of it lands.
    assert.throws(
      () =>
        registerModuleSkills('other', [
          { id: 'fine', sourceDir: join(temp, 'other'), targetPolicy: 'agents', description: 'x' },
          { id: 'backlog', sourceDir: join(temp, 'other'), targetPolicy: 'agents', description: 'x' },
        ]),
      /is a built-in skill/,
    )
    assert.equal(resolveSkillById('fine'), null, 'a rejected batch registers none of it')
    // The registry only ever takes resolved absolute directories; containment
    // against the module root is the host's job (module-host/module-skills.test.ts).
    assert.throws(
      () =>
        registerModuleSkills('other', [
          { id: 'relative', sourceDir: 'skills/x', targetPolicy: 'agents', description: 'x' },
        ]),
      /resolved absolute source directory/,
    )

    // Unloading the module takes its skills with it: the id stops resolving, and
    // the launch boundary says so instead of silently launching without it.
    unregisterModuleSkills('review')
    assert.deepEqual(listModuleSkills(), [])
    assert.equal(resolveSkillById('review-guide-module'), null)
    assert.deepEqual(await ensureSkillInstalled(workspaceRoot, 'review-guide-module'), {
      ok: false,
      status: 'unknown-skill',
      message: 'Unknown skill: review-guide-module',
    })
    setDefaultSkillManager(null)
  }

  const suiteRun = main().catch((error) => {
    console.error(error)
    process.exit(1)
  })

  await suiteRun
})

test('the retired skills are taken out of a workspace, but only the untouched, uncommitted copies this app wrote', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'sprintengine-retired-skills-'))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: workspace, stdio: 'ignore' })
  git('init', '-q')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  // A copy exactly as the installer leaves one: the bytes, then the marker.
  const managedCopy = async (harnessDir: string, skillId: string): Promise<string> => {
    const dir = join(workspace, harnessDir, 'skills', skillId)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'SKILL.md'), `# ${skillId}\n`, 'utf-8')
    await writeManagedSkillManifest({ destinationDir: dir, skill: { id: skillId, version: '1.0.0' }, sourceHash: 'x' })
    return dir
  }
  assert.ok(RETIRED_BUILTIN_SKILL_IDS.includes('frontend-design'))
  const untouched = await managedCopy('.claude', 'frontend-design')
  const inAgents = await managedCopy('.agents', 'workspace-knowledge')
  // Debug Mode's skill, which every Debug Mode launch copied in.
  assert.ok(RETIRED_BUILTIN_SKILL_IDS.includes('debug'))
  const debugCopy = await managedCopy('.codex', 'debug')
  const edited = await managedCopy('.agents', 'prototype')
  await writeFile(join(edited, 'SKILL.md'), '# my own notes\n', 'utf-8')
  const committed = await managedCopy('.agents', 'handoff')
  git('add', '--', join('.agents', 'skills', 'handoff'))
  git('commit', '-q', '-m', 'commit a copy')
  // Installed from a catalogue, not by this app: another marker entirely.
  const chosen = join(workspace, '.agents', 'skills', 'knowledge-grill')
  await mkdir(chosen, { recursive: true })
  await writeFile(join(chosen, 'SKILL.md'), '# chosen\n', 'utf-8')
  // A skill that still ships is never this function's business.
  const live = await managedCopy('.agents', 'backlog')

  const removed = await pruneRetiredBuiltinSkillCopies(workspace)
  assert.deepEqual(removed.sort(), [debugCopy, inAgents, untouched].sort())
  for (const kept of [edited, committed, chosen, live]) {
    assert.equal(existsSync(join(kept, 'SKILL.md')), true, `${kept} stays`)
  }
  assert.deepEqual(await pruneRetiredBuiltinSkillCopies(workspace), [], 'and a second pass finds nothing to do')
})
