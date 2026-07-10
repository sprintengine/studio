import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { LoadedPlugin } from '../shared/plugin-manifest'
import { BUILTIN_SKILLS, createBuiltinSkillManager } from './builtin-skills'

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

async function main(): Promise<void> {
  for (const skill of BUILTIN_SKILLS) {
    const realSkill = await readFile(join(process.cwd(), 'resources', 'skills', skill.id, 'SKILL.md'), 'utf-8')
    assert.match(realSkill, new RegExp(`name:\\s*${skill.id}`))
    await readFile(join(process.cwd(), 'resources', 'skills', skill.id, 'agents', 'openai.yaml'), 'utf-8')
  }

  const temp = await mkdtemp(join(tmpdir(), 'multicode-builtin-skills-'))
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
  assert.deepEqual(
    listed.map((skill) => skill.id),
    [
      'workspace-knowledge',
      'knowledge-grill',
      'debug',
      'behavior-first-testing',
      'prototype',
      'architecture-deepening',
      'handoff',
      'backlog',
      'use-railway',
      'use-codex',
      'frontend-design',
    ]
  )

  const missing = await manager.getStatus(workspaceRoot, 'workspace-knowledge')
  assert.equal(missing.ok, true)
  assert.equal(missing.ok && missing.status, 'missing')

  const installed = await manager.install(workspaceRoot, 'workspace-knowledge')
  assert.equal(installed.ok, true)
  assert.equal(installed.ok && installed.status, 'installed')

  const installedStatus = await manager.getStatus(workspaceRoot, 'workspace-knowledge')
  assert.equal(installedStatus.ok, true)
  assert.equal(installedStatus.ok && installedStatus.status, 'installed')

  const debugInstalled = await manager.install(workspaceRoot, 'debug')
  assert.equal(debugInstalled.ok, true)
  assert.equal(debugInstalled.ok && debugInstalled.status, 'installed')
  assert.equal(
    await readFile(join(workspaceRoot, '.agents', 'skills', 'debug', 'SKILL.md'), 'utf-8'),
    'version one\n'
  )
  // Debug Mode delivers the full skill to the agent, so `debug` opts into
  // all-native targets (like backlog): it installs to .agents PLUS every native
  // CLI harness, not just .agents. This is what lets the spawn-time /debug
  // invocation resolve to a present skill in the CLI's own skill dir.
  for (const dir of ['.claude', '.pi']) {
    assert.equal(
      await readFile(join(workspaceRoot, dir, 'skills', 'debug', 'SKILL.md'), 'utf-8'),
      'version one\n',
      `debug installs to ${dir}/skills/debug`
    )
  }
  const debugTargets = await manager.getStatus(workspaceRoot, 'debug')
  assert.equal(debugTargets.ok && debugTargets.status, 'installed')
  assert.equal(
    debugTargets.ok && debugTargets.targets.length,
    5,
    'debug resolves all-native targets (.agents + claude + pi + shim + generic-shell); zai dedupes into the claude path'
  )
  // Regression (skill-picker Install EEXIST): claude-code and zai render the
  // same .claude destination — exactly one path-bearing target may survive.
  const debugClaudePath = join(workspaceRoot, '.claude', 'skills', 'debug')
  assert.equal(
    debugTargets.ok
      && debugTargets.targets.filter((target) => target.destinationPath === debugClaudePath).length,
    1,
    'duplicate plugin install paths dedupe to one target'
  )

  await writeAllSkillSources(sourceRoot, 'version two\n')
  const updateAvailable = await manager.getStatus(workspaceRoot, 'workspace-knowledge')
  assert.equal(updateAvailable.ok, true)
  assert.equal(updateAvailable.ok && updateAvailable.status, 'update-available')

  const updated = await manager.install(workspaceRoot, 'workspace-knowledge')
  assert.equal(updated.ok, true)
  assert.equal(updated.ok && updated.status, 'updated')
  assert.equal(
    await readFile(join(workspaceRoot, '.agents', 'skills', 'workspace-knowledge', 'SKILL.md'), 'utf-8'),
    'version two\n'
  )

  await writeFile(
    join(workspaceRoot, '.agents', 'skills', 'workspace-knowledge', 'SKILL.md'),
    'local edit\n',
    'utf-8'
  )
  const modified = await manager.getStatus(workspaceRoot, 'workspace-knowledge')
  assert.equal(modified.ok, true)
  assert.equal(modified.ok && modified.status, 'modified')

  const blocked = await manager.install(workspaceRoot, 'workspace-knowledge')
  assert.equal(blocked.ok, false)
  assert.equal(!blocked.ok && blocked.status, 'modified')

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
    'prompt-shim'
  )
  assert.equal(
    backlogMissing.ok && backlogMissing.targets.find((target) => target.harness === 'generic-shell')?.status,
    'unsupported'
  )

  const backlogInstalled = await manager.install(workspaceRoot, 'backlog')
  assert.equal(backlogInstalled.ok, true)
  assert.equal(backlogInstalled.ok && backlogInstalled.status, 'installed')
  for (const dir of harnessDirs) {
    assert.equal(
      await readFile(join(workspaceRoot, dir, 'skills', 'backlog', 'SKILL.md'), 'utf-8'),
      'version two\n'
    )
  }

  const backlogStatus = await manager.getStatus(workspaceRoot, 'backlog')
  assert.equal(backlogStatus.ok, true)
  assert.equal(backlogStatus.ok && backlogStatus.status, 'installed')

  // A modified copy in one harness is skipped, not a block on the others.
  await writeFile(
    join(workspaceRoot, '.claude', 'skills', 'backlog', 'SKILL.md'),
    'local claude edit\n',
    'utf-8'
  )
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
    'local claude edit\n'
  )
  assert.equal(
    await readFile(join(workspaceRoot, '.agents', 'skills', 'backlog', 'SKILL.md'), 'utf-8'),
    'version three\n'
  )
  assert.equal(
    await readFile(join(workspaceRoot, '.pi', 'skills', 'backlog', 'SKILL.md'), 'utf-8'),
    'version three\n'
  )

  // Selective-harness skills (harnesses: ['agents', 'claude']) resolve static
  // targets only — no all-native plugin fan-out, and never the Codex harness.
  const useCodexMissing = await manager.getStatus(workspaceRoot, 'use-codex')
  assert.equal(useCodexMissing.ok, true)
  assert.equal(useCodexMissing.ok && useCodexMissing.status, 'missing')
  assert.deepEqual(
    useCodexMissing.ok && useCodexMissing.targets.map((target) => target.harness).sort(),
    ['agents', 'claude'],
    'use-codex targets exactly .agents and .claude'
  )

  const useCodexInstalled = await manager.install(workspaceRoot, 'use-codex')
  assert.equal(useCodexInstalled.ok, true)
  assert.equal(useCodexInstalled.ok && useCodexInstalled.status, 'installed')
  for (const dir of ['.agents', '.claude']) {
    assert.equal(
      await readFile(join(workspaceRoot, dir, 'skills', 'use-codex', 'SKILL.md'), 'utf-8'),
      'version three\n',
      `use-codex installs to ${dir}/skills/use-codex`
    )
  }
  await assert.rejects(
    readFile(join(workspaceRoot, '.pi', 'skills', 'use-codex', 'SKILL.md'), 'utf-8'),
    /ENOENT/,
    'use-codex must not fan out to other native CLI harnesses'
  )

  // frontend-design (MC-1511) is Claude-only: harnesses: ['claude'] resolves a
  // single native target and installs into .claude alone. This is the install
  // half of the wizard's "non-Claude sessions get no design skill" guarantee —
  // a non-Claude CLI never receives the skill files.
  const designSkillMissing = await manager.getStatus(workspaceRoot, 'frontend-design')
  assert.equal(designSkillMissing.ok, true)
  assert.equal(designSkillMissing.ok && designSkillMissing.status, 'missing')
  assert.deepEqual(
    designSkillMissing.ok && designSkillMissing.targets.map((target) => target.harness),
    ['claude'],
    'frontend-design targets exactly the Claude harness'
  )

  const designSkillInstalled = await manager.install(workspaceRoot, 'frontend-design')
  assert.equal(designSkillInstalled.ok, true)
  assert.equal(designSkillInstalled.ok && designSkillInstalled.status, 'installed')
  assert.equal(
    await readFile(join(workspaceRoot, '.claude', 'skills', 'frontend-design', 'SKILL.md'), 'utf-8'),
    'version three\n',
    'frontend-design installs into the Claude skill dir'
  )
  await assert.rejects(
    readFile(join(workspaceRoot, '.agents', 'skills', 'frontend-design', 'SKILL.md'), 'utf-8'),
    /ENOENT/,
    'frontend-design must not fan out to .agents or any non-Claude harness'
  )
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
