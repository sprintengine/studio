import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AgentCliAvailabilityMap } from '../shared/electron-api'
import type { PluginManifest, PluginRegistryListEntry } from '../shared/plugin-manifest'
import { createAgentSkillInstaller } from './agent-skill-installer'
import { createPluginRegistry, type PluginRegistry } from './plugin-registry'
import { createAppPluginRegistryOptions } from './plugin-registry-instance'
import { BUILTIN_SKILLS } from './builtin-skills'
import { createMcpServerResolver } from './mcp-config-readers/resolve-servers'
import {
  createAgentCapabilityService,
  createFsSkillDirectoryReader,
  createWorkspaceSkillsService,
  type ReadSkillsResult,
  type SkillDirectoryReader,
} from './workspace-skills-service'
import { test } from 'vitest'

test('workspace-skills-service', async () => {
  async function writeSkillDir(
    workspaceRoot: string,
    harnessDir: string,
    dirName: string,
    skillMd?: string,
  ): Promise<string> {
    const dir = join(workspaceRoot, harnessDir, 'skills', dirName)
    await mkdir(dir, { recursive: true })
    if (skillMd !== undefined) await writeFile(join(dir, 'SKILL.md'), skillMd, 'utf-8')
    return dir
  }

  async function main(): Promise<void> {
    const temp = await mkdtemp(join(tmpdir(), 'sprintengine-workspace-skills-'))
    const workspaceRoot = join(temp, 'workspace')
    await mkdir(workspaceRoot, { recursive: true })

    const service = createWorkspaceSkillsService()

    // Missing workspace root fails, not throws.
    const missing = await service.listWorkspaceSkills({ workspaceRoot: join(temp, 'nope') })
    assert.equal(missing.ok, false)

    // Custom skill dir with frontmatter: name/description come from SKILL.md, not
    // the directory name. Installed under two harness dirs → one deduped entry.
    const customSkillMd = [
      '---',
      'name: my-fancy-skill',
      'description: Does something fancy for this workspace.',
      '---',
      '',
      '# My Fancy Skill',
      '',
    ].join('\n')
    await writeSkillDir(workspaceRoot, '.agents', 'fancy-dir', customSkillMd)
    await writeSkillDir(workspaceRoot, '.claude', 'fancy-dir', customSkillMd)

    // Custom skill dir with no SKILL.md at all: falls back to the dir name.
    await writeSkillDir(workspaceRoot, '.agents', 'bare-dir')

    // A skill installed from a source: no builtin, no frontmatter, so the
    // directory name is all the inventory can honestly report.
    await writeSkillDir(workspaceRoot, '.agents', 'react-best-practices')

    // Installed builtin, up to date.
    const backlogDir = await writeSkillDir(workspaceRoot, '.agents', 'backlog')
    const backlogBuiltin = BUILTIN_SKILLS.find((skill) => skill.id === 'backlog')
    assert.ok(backlogBuiltin)
    await writeFile(
      join(backlogDir, '.sprintengine-skill.json'),
      JSON.stringify({ id: 'backlog', source: 'sprintengine-builtin', version: backlogBuiltin.version }),
      'utf-8',
    )

    // Installed builtin with a stale manifest version → update-available.
    const debugDir = await writeSkillDir(workspaceRoot, '.claude', 'debug')
    await writeFile(
      join(debugDir, '.sprintengine-skill.json'),
      JSON.stringify({ id: 'debug', source: 'sprintengine-builtin', version: '0.0.1' }),
      'utf-8',
    )

    const result = await service.listWorkspaceSkills({ workspaceRoot })
    assert.ok(result.ok)
    const skills = result.skills
    const byId = new Map(skills.map((skill) => [skill.id, skill]))

    const fancy = byId.get('fancy-dir')
    assert.ok(fancy, 'custom skill dir is listed')
    assert.equal(fancy.name, 'my-fancy-skill')
    assert.equal(fancy.description, 'Does something fancy for this workspace.')
    assert.equal(fancy.source, 'custom')
    assert.equal(fancy.installState, 'installed')
    assert.deepEqual([...fancy.harnesses].sort(), ['agents', 'claude'])

    const bare = byId.get('bare-dir')
    assert.ok(bare)
    assert.equal(bare.name, 'bare-dir')
    assert.equal(bare.source, 'custom')

    const fromSource = byId.get('react-best-practices')
    assert.ok(fromSource, 'a skill installed from a source is listed by its directory')
    assert.equal(fromSource.name, 'react-best-practices')
    assert.equal(fromSource.source, 'custom')
    assert.equal(fromSource.installState, 'installed')

    const backlog = byId.get('backlog')
    assert.ok(backlog)
    assert.equal(backlog.source, 'builtin')
    assert.equal(backlog.installState, 'installed')
    // No SKILL.md written → BUILTIN_SKILLS metadata fallback.
    assert.equal(backlog.name, backlogBuiltin.name)

    const debug = byId.get('debug')
    assert.ok(debug)
    assert.equal(debug.installState, 'update-available')

    // Every builtin appears exactly once; uninstalled ones are 'available'.
    for (const builtin of BUILTIN_SKILLS) {
      const entries = skills.filter((skill) => skill.id === builtin.id)
      assert.equal(entries.length, 1, `builtin ${builtin.id} listed once`)
      if (builtin.id !== 'backlog' && builtin.id !== 'debug') {
        assert.equal(entries[0].installState, 'available')
      }
    }

    // Sorted by display name.
    const names = skills.map((skill) => skill.name)
    assert.deepEqual(
      names,
      [...names].sort((a, b) => a.localeCompare(b)),
    )

    await testAgentCapabilities()
    await testThirteenthCli()

    console.log('workspace-skills-service tests passed')
  }

  // A reader that records what it was asked for, so "one directory read per
  // harness" is checked rather than assumed.
  function fakeReader(byDir: Record<string, ReadSkillsResult>): SkillDirectoryReader & { reads: string[] } {
    const reads: string[] = []
    return {
      reads,
      async read(absoluteDir) {
        reads.push(absoluteDir)
        return byDir[absoluteDir] ?? { ok: false, reason: 'missing', message: 'No skills directory here yet.' }
      },
    }
  }

  function bundledRegistry(): PluginRegistry {
    const registry = createPluginRegistry(
      createAppPluginRegistryOptions(
        join(process.cwd(), 'node_modules', '.cache', 'sprintengine'),
        join(process.cwd(), 'resources', 'plugins'),
        join(process.cwd(), 'node_modules', '.cache', 'sprintengine', 'plugins-none'),
      ),
    )
    registry.loadSync()
    return registry
  }

  async function testAgentCapabilities(): Promise<void> {
    const registry = bundledRegistry()
    const plugins = registry.list()
    const lookupManifest = (pluginId: string): PluginManifest | undefined => registry.get(pluginId)?.manifest
    const temp = await mkdtemp(join(tmpdir(), 'sprintengine-agent-capabilities-'))
    const workspaceRoot = join(temp, 'workspace')
    await mkdir(workspaceRoot, { recursive: true })

    // Real directories: a built-in copy, a copy installed from a source, and a
    // hand-made one, so provenance is read from the marker rather than assumed.
    const claudeSkills = join(workspaceRoot, '.claude', 'skills')
    await mkdir(join(claudeSkills, 'backlog'), { recursive: true })
    await writeFile(
      join(claudeSkills, 'backlog', 'SKILL.md'),
      '---\nname: Backlog\ndescription: Work a backlog item.\n---\n\n# Backlog\n',
      'utf-8',
    )
    await writeFile(
      join(claudeSkills, 'backlog', '.sprintengine-skill.json'),
      JSON.stringify({ id: 'backlog', source: 'sprintengine-builtin', version: '1.0.0' }),
      'utf-8',
    )
    await mkdir(join(claudeSkills, 'from-github'), { recursive: true })
    await writeFile(
      join(claudeSkills, 'from-github', '.sprintengine-skill.json'),
      JSON.stringify({ sourceId: 'gh-1', skillId: 'from-github', commitSha: 'abc' }),
      'utf-8',
    )
    await mkdir(join(claudeSkills, 'hand-made'), { recursive: true })

    // Home is pinned at a directory that does not exist so a user-scope config on
    // the machine running the test cannot leak into the assertions below.
    const homeDir = (): string => join(temp, 'home')
    const fsService = createAgentCapabilityService({
      reader: createFsSkillDirectoryReader(),
      listPlugins: () => plugins,
      lookupManifest,
      mcpResolver: createMcpServerResolver({ homeDir }),
    })

    const claude = await fsService.resolve({ workspaceRoot, pluginId: 'claude-code' })
    assert.ok(claude.ok)
    assert.equal(claude.support, 'native')
    assert.equal(claude.harnessId, 'claude')
    assert.deepEqual(claude.diagnostics, [])
    assert.deepEqual(claude.servers, [], 'no .mcp.json in this workspace yet')
    assert.deepEqual(
      claude.skills.map((skill) => [skill.id, skill.source, skill.invocation]),
      [
        ['backlog', 'builtin', '/backlog'],
        ['from-github', 'source', '/from-github'],
        ['hand-made', 'local', '/hand-made'],
      ],
    )
    assert.equal(claude.skills[0].name, 'Backlog', 'name comes from SKILL.md')
    assert.equal(claude.skills[0].description, 'Work a backlog item.')
    assert.equal(claude.skills[2].name, 'hand-made', 'no entry document → the directory name')
    assert.equal(claude.skills[2].description, '')

    // Every CLI on the claude harness is attributed the same skills.
    assert.deepEqual([...claude.skills[0].pluginIds].sort(), ['claude-code', 'kimi-claude', 'zai'])

    // A directory that was never created is normal: an empty list and no fault.
    const codex = await fsService.resolve({ workspaceRoot, pluginId: 'codex' })
    assert.ok(codex.ok)
    assert.equal(codex.harnessId, 'codex')
    assert.deepEqual(codex.skills, [])
    assert.deepEqual(codex.diagnostics, [], 'missing is not a fault')

    // A missing workspace is the one thing that cannot be answered.
    const noWorkspace = await fsService.resolve({ workspaceRoot: join(temp, 'nope'), pluginId: 'claude-code' })
    assert.equal(noWorkspace.ok, false)

    // Declared-unsupported and no-declaration are both answers, never errors.
    const shell = await fsService.resolve({ workspaceRoot, pluginId: 'generic-shell' })
    assert.ok(shell.ok)
    assert.equal(shell.support, 'unsupported')
    assert.equal(shell.harnessId, 'generic-shell')
    assert.deepEqual(shell.skills, [])
    const cursor = await fsService.resolve({ workspaceRoot, pluginId: 'cursor' })
    assert.ok(cursor.ok)
    assert.equal(cursor.support, 'unsupported')
    assert.equal(cursor.harnessId, '', 'no skillIntegration means no harness to name')
    const unknown = await fsService.resolve({ workspaceRoot, pluginId: 'not-installed' })
    assert.ok(unknown.ok)
    assert.equal(unknown.support, 'unsupported')

    // An unreadable directory reports the failing path instead of reading as empty.
    const unreadableRoot = join(temp, 'locked')
    const unreadableDir = join(unreadableRoot, '.claude', 'skills')
    await mkdir(unreadableDir, { recursive: true })
    await chmod(unreadableDir, 0o000)
    try {
      const locked = await fsService.resolve({ workspaceRoot: unreadableRoot, pluginId: 'claude-code' })
      assert.ok(locked.ok)
      assert.deepEqual(locked.skills, [])
      // Running as root defeats the permission bits; only assert where it bit.
      if (locked.diagnostics.length > 0) {
        assert.equal(locked.diagnostics[0].capability, 'skills')
        assert.equal(locked.diagnostics[0].reason, 'unreadable')
        assert.equal(locked.diagnostics[0].path, unreadableDir)
        assert.ok(locked.diagnostics[0].message.length > 0)
      }
    } finally {
      await chmod(unreadableDir, 0o755)
    }

    // A file where the skills directory should be is a fault, not "never created".
    const wrongTypeRoot = join(temp, 'file-not-dir')
    await mkdir(join(wrongTypeRoot, '.claude'), { recursive: true })
    await writeFile(join(wrongTypeRoot, '.claude', 'skills'), 'not a directory', 'utf-8')
    const wrongType = await fsService.resolve({ workspaceRoot: wrongTypeRoot, pluginId: 'claude-code' })
    assert.ok(wrongType.ok)
    assert.deepEqual(wrongType.skills, [])
    assert.equal(wrongType.diagnostics.length, 1)
    assert.equal(wrongType.diagnostics[0].capability, 'skills')
    assert.equal(wrongType.diagnostics[0].reason, 'unreadable')
    assert.equal(wrongType.diagnostics[0].path, join(wrongTypeRoot, '.claude', 'skills'))

    // Three CLIs on one harness read the directory once each time they are asked,
    // and each ask attributes the result to all three.
    const reader = fakeReader({
      [join(workspaceRoot, '.claude', 'skills')]: {
        ok: true,
        skills: [{ id: 'debug', name: 'Debug', description: '', source: 'builtin' }],
      },
    })
    const fakeService = createAgentCapabilityService({
      reader,
      listPlugins: () => plugins,
      lookupManifest,
      mcpResolver: createMcpServerResolver({ homeDir }),
    })
    const shared = await fakeService.resolve({ workspaceRoot, pluginId: 'kimi-claude' })
    assert.ok(shared.ok)
    assert.equal(reader.reads.length, 1, 'one directory read')
    assert.equal(reader.reads[0], join(workspaceRoot, '.claude', 'skills'))
    assert.deepEqual([...shared.skills[0].pluginIds].sort(), ['claude-code', 'kimi-claude', 'zai'])

    // Invocations come from each manifest's own template, for every CLI that
    // declares native skill support.
    const invocations: Record<string, string> = {}
    for (const plugin of plugins) {
      if (plugin.skillIntegration?.support !== 'native') continue
      const result = await createAgentCapabilityService({
        reader: fakeReader({
          [join(workspaceRoot, '.claude', 'skills')]: {
            ok: true,
            skills: [{ id: 'debug', name: 'Debug', description: '', source: 'builtin' }],
          },
          [join(workspaceRoot, '.codex', 'skills')]: {
            ok: true,
            skills: [{ id: 'debug', name: 'Debug', description: '', source: 'builtin' }],
          },
          [join(workspaceRoot, '.grok', 'skills')]: {
            ok: true,
            skills: [{ id: 'debug', name: 'Debug', description: '', source: 'builtin' }],
          },
          [join(workspaceRoot, '.opencode', 'skills')]: {
            ok: true,
            skills: [{ id: 'debug', name: 'Debug', description: '', source: 'builtin' }],
          },
        }),
        listPlugins: () => plugins,
        lookupManifest,
        mcpResolver: createMcpServerResolver({ homeDir }),
      }).resolve({ workspaceRoot, pluginId: plugin.id })
      assert.ok(result.ok)
      assert.equal(result.skills.length, 1, `${plugin.id} resolves its harness directory`)
      invocations[plugin.id] = result.skills[0].invocation
    }
    assert.deepEqual(invocations, {
      'claude-code': '/debug',
      codex: 'Use $debug.',
      grok: '/debug',
      'kimi-claude': '/debug',
      opencode: 'Use the debug skill.',
      zai: '/debug',
    })

    await testCapabilityServers({ plugins, lookupManifest, temp })
  }

  // The MCP half, through the same one query the surface asks: the halves are
  // independent declarations, and neither one's fault empties the other.
  async function testCapabilityServers(context: {
    plugins: PluginRegistryListEntry[]
    lookupManifest: (pluginId: string) => PluginManifest | undefined
    temp: string
  }): Promise<void> {
    const workspaceRoot = join(context.temp, 'with-mcp')
    await mkdir(join(workspaceRoot, '.cursor'), { recursive: true })
    await writeFile(
      join(workspaceRoot, '.mcp.json'),
      JSON.stringify({ mcpServers: { linear: { type: 'stdio', command: 'npx' } } }),
      'utf-8',
    )
    await writeFile(join(workspaceRoot, '.cursor', 'mcp.json'), '{ "mcpServers": ', 'utf-8')

    const service = createAgentCapabilityService({
      reader: createFsSkillDirectoryReader(),
      listPlugins: () => context.plugins,
      lookupManifest: context.lookupManifest,
      mcpResolver: createMcpServerResolver({ homeDir: () => join(context.temp, 'home') }),
    })

    const claude = await service.resolve({ workspaceRoot, pluginId: 'claude-code' })
    assert.ok(claude.ok)
    assert.deepEqual(
      claude.servers.map((server) => [server.id, server.transport, server.scope, server.configPath]),
      [['linear', 'stdio', 'workspace', join(workspaceRoot, '.mcp.json')]],
    )
    assert.deepEqual(claude.diagnostics, [])

    // cursor declares an MCP config and no skill integration at all: nothing to
    // read for skills must not skip the half it does declare.
    const cursor = await service.resolve({ workspaceRoot, pluginId: 'cursor' })
    assert.ok(cursor.ok)
    assert.equal(cursor.support, 'unsupported')
    assert.deepEqual(cursor.skills, [])
    assert.equal(cursor.diagnostics.length, 1, 'its unparseable config is stated')
    assert.equal(cursor.diagnostics[0].capability, 'servers')
    assert.equal(cursor.diagnostics[0].reason, 'malformed')
    assert.equal(cursor.diagnostics[0].path, join(workspaceRoot, '.cursor', 'mcp.json'))

    // A CLI with no mcpConfig block at all answers with no servers and no fault.
    const shell = await service.resolve({ workspaceRoot, pluginId: 'generic-shell' })
    assert.ok(shell.ok)
    assert.deepEqual(shell.servers, [])
    assert.deepEqual(shell.diagnostics, [])
  }

  // The acceptance test for the whole backend, run rather than reasoned about:
  // a thirteenth CLI nobody has heard of, dropped into the user plugin root as a
  // plugin.json and nothing else, must resolve its skills and its servers — and
  // receive an attach — with no edit to any production file. Every path here is
  // invented (`.hypertron/agent-skills`, `hyper-mcp.json`) precisely so that a
  // hardcoded directory, config path or CLI list anywhere in the chain fails it.
  const THIRTEENTH_MANIFEST = {
    id: 'hypertron',
    displayName: 'Hypertron',
    publisher: 'fixture',
    version: 1,
    binary: 'hypertron',
    permissionPresets: {
      default: { label: 'Default', args: [] },
      bypass: { label: 'Bypass all approvals (dangerous)', args: ['--yolo'] },
    },
    launch: { argv: ['{{binary}}', { spreadIf: 'permissionArgs' }] },
    promptInjection: { mode: 'positional-arg' },
    completion: { mode: 'process-exit' },
    capabilities: {
      resumeSession: false,
      sessionIdFromCaller: false,
      toolUse: true,
      mcpServers: true,
    },
    mcpConfig: {
      path: '{{workspaceRoot}}/hyper-mcp.json',
      userPath: '{{home}}/.hypertron/hyper-mcp.json',
      format: 'claude-code',
    },
    skillIntegration: {
      support: 'native',
      harnessId: 'hypertron',
      installTargets: [
        {
          scope: 'workspace',
          path: '{{workspaceRoot}}/.hypertron/agent-skills/{{skillId}}',
          format: 'generic',
          restartRequired: false,
        },
      ],
      invocation: { explicitTemplate: '#{{skillId}}', fileDropTemplate: '#{{skillId}} {{path}}' },
    },
  }

  async function testThirteenthCli(): Promise<void> {
    const temp = await mkdtemp(join(tmpdir(), 'sprintengine-thirteenth-cli-'))
    const userPluginRoot = join(temp, 'user-plugins')
    await mkdir(join(userPluginRoot, 'hypertron'), { recursive: true })
    await writeFile(
      join(userPluginRoot, 'hypertron', 'plugin.json'),
      JSON.stringify(THIRTEENTH_MANIFEST, null, 2),
      'utf-8',
    )

    // Loaded through the real registry, so the manifest is validated exactly as a
    // dropped-in plugin would be rather than hand-built into the shape the map wants.
    const registry = createPluginRegistry(
      createAppPluginRegistryOptions(
        join(process.cwd(), 'node_modules', '.cache', 'sprintengine'),
        join(process.cwd(), 'resources', 'plugins'),
        userPluginRoot,
      ),
    )
    const report = registry.loadSync()
    assert.deepEqual(report.rejected, [], 'the fixture manifest is accepted as written')
    const plugins = registry.list()
    assert.equal(
      plugins.length,
      bundledRegistry().list().length + 1,
      'the bundled CLIs plus the fixture, which is one more than the app ships',
    )
    assert.ok(plugins.some((plugin) => plugin.id === 'hypertron'))

    const workspaceRoot = join(temp, 'workspace')
    const home = join(temp, 'home')
    await mkdir(join(workspaceRoot, '.hypertron', 'agent-skills', 'deploy'), { recursive: true })
    await writeFile(
      join(workspaceRoot, '.hypertron', 'agent-skills', 'deploy', 'SKILL.md'),
      '---\nname: Deploy\ndescription: Ship it.\n---\n\n# Deploy\n',
      'utf-8',
    )
    // Both declared scopes hold a server, so the union and the workspace-wins
    // precedence are exercised on a config path no bundled CLI declares.
    await writeFile(
      join(workspaceRoot, 'hyper-mcp.json'),
      JSON.stringify({ mcpServers: { linear: { type: 'stdio', command: 'npx' } } }),
      'utf-8',
    )
    await mkdir(join(home, '.hypertron'), { recursive: true })
    await writeFile(
      join(home, '.hypertron', 'hyper-mcp.json'),
      JSON.stringify({ mcpServers: { sentry: { type: 'http', url: 'https://mcp.sentry.dev' } } }),
      'utf-8',
    )

    const service = createAgentCapabilityService({
      reader: createFsSkillDirectoryReader(),
      listPlugins: () => plugins,
      lookupManifest: (pluginId) => registry.get(pluginId)?.manifest,
      mcpResolver: createMcpServerResolver({ homeDir: () => home }),
    })

    const resolved = await service.resolve({ workspaceRoot, pluginId: 'hypertron' })
    assert.ok(resolved.ok)
    assert.equal(resolved.support, 'native')
    assert.equal(resolved.harnessId, 'hypertron')
    assert.deepEqual(resolved.diagnostics, [])
    assert.deepEqual(
      resolved.skills.map((skill) => [skill.id, skill.name, skill.invocation, skill.source, skill.pluginIds]),
      [['deploy', 'Deploy', '#deploy', 'local', ['hypertron']]],
      'the invented harness directory is read and invoked from its own template',
    )
    assert.deepEqual(
      resolved.servers.map((server) => [server.id, server.transport, server.scope, server.configPath]),
      [
        ['linear', 'stdio', 'workspace', join(workspaceRoot, 'hyper-mcp.json')],
        ['sentry', 'http', 'user', join(home, '.hypertron', 'hyper-mcp.json')],
      ],
      'both declared scopes are read from the paths the fixture manifest names',
    )

    // The write path fans out by the same derived map: a skill living in one
    // harness reaches the thirteenth CLI's directory with no edit either.
    await mkdir(join(workspaceRoot, '.claude', 'skills', 'shipit'), { recursive: true })
    await writeFile(
      join(workspaceRoot, '.claude', 'skills', 'shipit', 'SKILL.md'),
      '---\nname: Ship It\ndescription: Ship it harder.\n---\n',
      'utf-8',
    )
    const installer = createAgentSkillInstaller({
      listPlugins: () => plugins,
      detectAvailability: async () =>
        ({
          'claude-code': { installed: true },
          hypertron: { installed: true },
        }) as unknown as AgentCliAvailabilityMap,
    })
    const attached = await installer.attach({ workspaceRoot, skillId: 'shipit' })
    assert.ok(attached.ok)
    const hypertronTarget = attached.targets.find((target) => target.harnessId === 'hypertron')
    assert.ok(hypertronTarget, 'the thirteenth CLI is an attach target')
    assert.equal(hypertronTarget.path, '.hypertron/agent-skills/shipit')
    assert.equal(hypertronTarget.status, 'written')
    assert.equal(hypertronTarget.restartRequired, false, 'restart truth comes from its own manifest')
    assert.ok(
      existsSync(join(workspaceRoot, '.hypertron', 'agent-skills', 'shipit', 'SKILL.md')),
      'the copy is on disk in the directory the fixture manifest declared',
    )
  }

  const suiteRun = main().catch((error) => {
    console.error(error)
    process.exit(1)
  })

  await suiteRun
})
