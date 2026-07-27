import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  deleteUserRole,
  getUserRole,
  installRoleFolder,
  loadUserRoleManifests,
  resolveRoleInstallTargets,
  saveUserRole,
} from './sprintengine-role-registry'

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

const VALID_ROLE = JSON.stringify({
  id: 'auditor',
  label: 'Auditor',
  summary: 'Audits the change.',
  directives: { implement: [{ skill: 'auditor' }] },
})

const INVALID_ROLE = JSON.stringify({ id: 'Bad Id', label: '', directives: { implement: [] } })

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

async function testSaveGetRoundTrip(): Promise<void> {
  await withTempDir(async (dir) => {
    const root = join(dir, 'registry')
    const saved = await saveUserRole(
      {
        id: 'auditor',
        label: 'Auditor',
        summary: 'Audits the change.',
        aliases: ['audit'],
        body: '<what-to-do>\n# Role\nYou are Auditor.\n</what-to-do>\n',
      },
      root
    )
    assert.equal(saved.ok, true)
    assert.equal(saved.id, 'auditor')

    // Real files landed in the canonical layout.
    const onDisk = await readFile(join(root, 'roles', 'auditor.json'), 'utf8')
    assert.equal(onDisk.endsWith('\n'), true)
    assert.ok(await exists(join(root, 'skills', 'auditor', 'SKILL.md')))

    const fetched = await getUserRole('auditor', root)
    assert.equal(fetched.ok, true)
    if (fetched.ok) {
      assert.equal(fetched.manifest.id, 'auditor')
      assert.deepEqual(fetched.manifest.directives, { implement: [{ skill: 'auditor' }] })
      assert.deepEqual(fetched.manifest.aliases, ['audit'])
      assert.ok(fetched.body.includes('You are Auditor.'))
    }

    // The role is discoverable through the existing list path.
    const listed = await loadUserRoleManifests(root)
    assert.deepEqual(
      listed.roles.map((role) => role.id),
      ['auditor']
    )
  })
}

async function testDeleteIsIdempotent(): Promise<void> {
  await withTempDir(async (dir) => {
    const root = join(dir, 'registry')
    await saveUserRole({ id: 'auditor', label: 'Auditor', body: '# Auditor' }, root)
    assert.ok(await exists(join(root, 'roles', 'auditor.json')))

    const removed = await deleteUserRole('auditor', root)
    assert.equal(removed.ok, true)
    assert.equal(await exists(join(root, 'roles', 'auditor.json')), false)
    assert.equal(await exists(join(root, 'skills', 'auditor')), false)

    // Deleting again is fine, not an error.
    const again = await deleteUserRole('auditor', root)
    assert.equal(again.ok, true)

    const fetched = await getUserRole('auditor', root)
    assert.equal(fetched.ok, false)
  })
}

async function testSaveRejectsInvalidManifestWithoutWriting(): Promise<void> {
  await withTempDir(async (dir) => {
    const root = join(dir, 'registry')
    // Empty label fails validateRoleManifest.
    const result = await saveUserRole({ id: 'auditor', label: '   ', body: '# Auditor' }, root)
    assert.equal(result.ok, false)
    assert.ok(result.issues && result.issues.some((issue) => issue.path === 'label'))
    assert.equal(await exists(join(root, 'roles', 'auditor.json')), false)
    assert.equal(await exists(join(root, 'skills', 'auditor')), false)
  })
}

async function testSaveRejectsEmptyBodyWithoutWriting(): Promise<void> {
  await withTempDir(async (dir) => {
    const root = join(dir, 'registry')
    const result = await saveUserRole({ id: 'auditor', label: 'Auditor', body: '   ' }, root)
    assert.equal(result.ok, false)
    assert.ok(result.issues && result.issues.some((issue) => issue.path === 'body'))
    assert.equal(await exists(join(root, 'roles', 'auditor.json')), false)
  })
}

async function testSaveAndDeleteRejectTraversalIds(): Promise<void> {
  await withTempDir(async (dir) => {
    const root = join(dir, 'registry')
    for (const badId of ['../escape', 'a/b', 'Bad', '..']) {
      const saved = await saveUserRole({ id: badId, label: 'X', body: '# X' }, root)
      assert.equal(saved.ok, false, `save must reject id ${JSON.stringify(badId)}`)
      assert.ok(saved.issues && saved.issues.some((issue) => issue.path === 'id'))
      const removed = await deleteUserRole(badId, root)
      assert.equal(removed.ok, false, `delete must reject id ${JSON.stringify(badId)}`)
    }
    // No stray files or directories were created outside the (still-absent) root.
    assert.equal(await exists(join(dir, 'escape.json')), false)
    assert.equal(await exists(root), false)
  })
}

async function main(): Promise<void> {
  await testResolveRegistryFolder()
  await testInstallCopiesValidAndRejectsInvalid()
  await testInstallEmptyFolder()
  await testListMissingRootIsEmpty()
  await testSaveGetRoundTrip()
  await testDeleteIsIdempotent()
  await testSaveRejectsInvalidManifestWithoutWriting()
  await testSaveRejectsEmptyBodyWithoutWriting()
  await testSaveAndDeleteRejectTraversalIds()
  console.log('sprintengine-role-registry tests passed')
}

void main()
