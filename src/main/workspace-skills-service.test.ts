import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { PluginRegistryListEntry } from '../shared/plugin-manifest'
import { createPluginRegistry } from './plugin-registry'
import { createAppPluginRegistryOptions } from './plugin-registry-instance'
import { BUILTIN_SKILLS } from './builtin-skills'
import {
  createAgentCapabilityService,
  createFsSkillDirectoryReader,
  createWorkspaceSkillsService,
  type ReadSkillsResult,
  type SkillDirectoryReader,
} from './workspace-skills-service'

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
  const temp = await mkdtemp(join(tmpdir(), 'multicode-workspace-skills-'))
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
    join(backlogDir, '.multicode-skill.json'),
    JSON.stringify({ id: 'backlog', source: 'multicode-builtin', version: backlogBuiltin.version }),
    'utf-8',
  )

  // Installed builtin with a stale manifest version → update-available.
  const debugDir = await writeSkillDir(workspaceRoot, '.claude', 'debug')
  await writeFile(
    join(debugDir, '.multicode-skill.json'),
    JSON.stringify({ id: 'debug', source: 'multicode-builtin', version: '0.0.1' }),
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
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)))

  await testAgentCapabilities()

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

function bundledPlugins(): PluginRegistryListEntry[] {
  const registry = createPluginRegistry(
    createAppPluginRegistryOptions(
      join(process.cwd(), 'node_modules', '.cache', 'multicode'),
      join(process.cwd(), 'resources', 'plugins'),
      join(process.cwd(), 'node_modules', '.cache', 'multicode', 'plugins-none'),
    ),
  )
  registry.loadSync()
  return registry.list()
}

async function testAgentCapabilities(): Promise<void> {
  const plugins = bundledPlugins()
  const temp = await mkdtemp(join(tmpdir(), 'multicode-agent-capabilities-'))
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
    join(claudeSkills, 'backlog', '.multicode-skill.json'),
    JSON.stringify({ id: 'backlog', source: 'multicode-builtin', version: '1.0.0' }),
    'utf-8',
  )
  await mkdir(join(claudeSkills, 'from-github'), { recursive: true })
  await writeFile(
    join(claudeSkills, 'from-github', '.multicode-skill.json'),
    JSON.stringify({ sourceId: 'gh-1', skillId: 'from-github', commitSha: 'abc' }),
    'utf-8',
  )
  await mkdir(join(claudeSkills, 'hand-made'), { recursive: true })

  const fsService = createAgentCapabilityService({
    reader: createFsSkillDirectoryReader(),
    listPlugins: () => plugins,
  })

  const claude = await fsService.resolve({ workspaceRoot, pluginId: 'claude-code' })
  assert.ok(claude.ok)
  assert.equal(claude.support, 'native')
  assert.equal(claude.harnessId, 'claude')
  assert.deepEqual(claude.diagnostics, [])
  assert.deepEqual(claude.servers, [], 'the MCP half is not this service')
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
      assert.equal(locked.diagnostics[0].reason, 'unreadable')
      assert.equal(locked.diagnostics[0].path, unreadableDir)
      assert.ok(locked.diagnostics[0].message.length > 0)
    }
  } finally {
    await chmod(unreadableDir, 0o755)
  }

  // Three CLIs on one harness read the directory once each time they are asked,
  // and each ask attributes the result to all three.
  const reader = fakeReader({
    [join(workspaceRoot, '.claude', 'skills')]: {
      ok: true,
      skills: [{ id: 'debug', name: 'Debug', description: '', source: 'builtin' }],
    },
  })
  const fakeService = createAgentCapabilityService({ reader, listPlugins: () => plugins })
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
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
