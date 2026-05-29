import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  installRoleFolder,
  loadUserRoleManifests,
  resolveRoleInstallTargets,
} from './sprintengine-role-registry'

const VALID_ROLE = JSON.stringify({
  id: 'auditor',
  label: 'Auditor',
  summary: 'Audits the change.',
  soul: [{ skill: 'auditor' }],
})

const INVALID_ROLE = JSON.stringify({ id: 'Bad Id', label: '', soul: [] })

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'mc-roles-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function testResolveRegistryFolder(): Promise<void> {
  await withTempDir(async (dir) => {
    const src = join(dir, 'src')
    await mkdir(join(src, 'roles'), { recursive: true })
    await mkdir(join(src, 'skills', 'auditor'), { recursive: true })
    await writeFile(join(src, 'roles', 'auditor.json'), VALID_ROLE)
    await writeFile(join(src, 'skills', 'auditor', 'SKILL.md'), '# Auditor')

    const targets = await resolveRoleInstallTargets(src)
    assert.equal(targets.roleFiles.length, 1)
    assert.equal(targets.skillDirs.length, 1)
  })
}

async function testInstallCopiesValidAndRejectsInvalid(): Promise<void> {
  await withTempDir(async (dir) => {
    const src = join(dir, 'src')
    const root = join(dir, 'registry')
    await mkdir(join(src, 'roles'), { recursive: true })
    await mkdir(join(src, 'skills', 'auditor'), { recursive: true })
    await writeFile(join(src, 'roles', 'auditor.json'), VALID_ROLE)
    await writeFile(join(src, 'roles', 'broken.json'), INVALID_ROLE)
    await writeFile(join(src, 'skills', 'auditor', 'SKILL.md'), '# Auditor')

    const result = await installRoleFolder(src, root)
    assert.equal(result.ok, true)
    assert.deepEqual(result.installedRoles, ['auditor'])
    assert.deepEqual(result.installedSkills, ['auditor'])
    assert.equal(result.rejected.length, 1, 'the malformed manifest is rejected, not copied')
    assert.ok(result.rejected[0].path.endsWith('broken.json'))

    // The valid role is discoverable; the broken one never landed.
    const listed = await loadUserRoleManifests(root)
    assert.deepEqual(
      listed.roles.map((role) => role.id),
      ['auditor']
    )
    assert.equal(listed.rejected.length, 0)
  })
}

async function testInstallEmptyFolder(): Promise<void> {
  await withTempDir(async (dir) => {
    const src = join(dir, 'empty')
    await mkdir(src, { recursive: true })
    const result = await installRoleFolder(src, join(dir, 'registry'))
    assert.equal(result.ok, false)
    assert.ok(result.message && result.message.length > 0)
  })
}

async function testListMissingRootIsEmpty(): Promise<void> {
  await withTempDir(async (dir) => {
    const listed = await loadUserRoleManifests(join(dir, 'does-not-exist'))
    assert.deepEqual(listed.roles, [])
    assert.deepEqual(listed.rejected, [])
  })
}

async function main(): Promise<void> {
  await testResolveRegistryFolder()
  await testInstallCopiesValidAndRejectsInvalid()
  await testInstallEmptyFolder()
  await testListMissingRootIsEmpty()
  console.log('sprintengine-role-registry tests passed')
}

void main()
