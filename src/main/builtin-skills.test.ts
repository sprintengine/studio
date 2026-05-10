import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createBuiltinSkillManager } from './builtin-skills'

async function writeSkillSource(root: string, body: string): Promise<void> {
  const skillRoot = join(root, 'workspace-knowledge')
  await mkdir(join(skillRoot, 'agents'), { recursive: true })
  await writeFile(join(skillRoot, 'SKILL.md'), body, 'utf-8')
  await writeFile(join(skillRoot, 'agents', 'openai.yaml'), 'display_name: Workspace Knowledge\n', 'utf-8')
}

async function main(): Promise<void> {
  const temp = await mkdtemp(join(tmpdir(), 'multicode-builtin-skills-'))
  const sourceRoot = join(temp, 'source')
  const workspaceRoot = join(temp, 'workspace')
  await mkdir(workspaceRoot, { recursive: true })
  await writeSkillSource(sourceRoot, 'version one\n')

  const manager = createBuiltinSkillManager({ sourceRoot })

  const missing = await manager.getStatus(workspaceRoot, 'workspace-knowledge')
  assert.equal(missing.ok, true)
  assert.equal(missing.ok && missing.status, 'missing')

  const installed = await manager.install(workspaceRoot, 'workspace-knowledge')
  assert.equal(installed.ok, true)
  assert.equal(installed.ok && installed.status, 'installed')

  const installedStatus = await manager.getStatus(workspaceRoot, 'workspace-knowledge')
  assert.equal(installedStatus.ok, true)
  assert.equal(installedStatus.ok && installedStatus.status, 'installed')

  await writeSkillSource(sourceRoot, 'version two\n')
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
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
