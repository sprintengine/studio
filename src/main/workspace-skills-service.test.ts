import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BUILTIN_SKILLS } from './builtin-skills'
import { createWorkspaceSkillsService } from './workspace-skills-service'

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

  console.log('workspace-skills-service tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
