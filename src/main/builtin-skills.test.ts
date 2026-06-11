import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

  const manager = createBuiltinSkillManager({ sourceRoot })
  const listed = await manager.list()
  assert.deepEqual(
    listed.map((skill) => skill.id),
    [
      'workspace-knowledge',
      'knowledge-grill',
      'diagnose',
      'behavior-first-testing',
      'prototype',
      'architecture-deepening',
      'handoff',
      'backlog',
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

  const diagnoseInstalled = await manager.install(workspaceRoot, 'diagnose')
  assert.equal(diagnoseInstalled.ok, true)
  assert.equal(diagnoseInstalled.ok && diagnoseInstalled.status, 'installed')
  assert.equal(
    await readFile(join(workspaceRoot, '.agents', 'skills', 'diagnose', 'SKILL.md'), 'utf-8'),
    'version one\n'
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

  // Multi-harness skills install one managed copy per harness directory.
  const harnessDirs = ['.claude', '.codex', '.cursor', '.gemini', '.opencode', '.agents']
  const backlogMissing = await manager.getStatus(workspaceRoot, 'backlog')
  assert.equal(backlogMissing.ok, true)
  assert.equal(backlogMissing.ok && backlogMissing.status, 'missing')
  assert.equal(backlogMissing.ok && backlogMissing.targets.length, harnessDirs.length)

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
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
