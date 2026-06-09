import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { manifestFingerprint, type ModuleTrustContext } from './module-signature'
import { discoverUserModules, discoverUserModulesSync, installModuleFolder } from './user-module-registry'

const EMPTY_TRUST: ModuleTrustContext = { trustedModules: new Map() }

function manifestJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: 'demo',
    displayName: 'Demo module',
    version: 1,
    summary: 'A demo.',
    permissions: ['network'],
    ...overrides,
  })
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'mc-modules-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function writeModuleFolder(parent: string, folderName: string, json: string): Promise<string> {
  const dir = join(parent, folderName)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'manifest.json'), json)
  return dir
}

async function testInstallThenDiscover(): Promise<void> {
  await withTempDir(async (dir) => {
    const src = await writeModuleFolder(dir, 'anything', manifestJson({ id: 'demo' }))
    const root = join(dir, 'modules')

    const install = await installModuleFolder(src, root, EMPTY_TRUST)
    assert.equal(install.ok, true)
    if (install.ok) {
      assert.equal(install.id, 'demo')
      assert.equal(install.trust.status, 'unsigned', 'a fresh unsigned module is untrusted')
    }

    const listed = await discoverUserModules(root, EMPTY_TRUST)
    assert.deepEqual(listed.modules.map((m) => m.manifest.id), ['demo'])
    assert.equal(listed.modules[0].trust.status, 'unsigned')
    assert.equal(listed.modules[0].manifest.source, 'third-party')
    assert.equal(listed.rejected.length, 0)

    const syncListed = discoverUserModulesSync(root, EMPTY_TRUST)
    assert.deepEqual(syncListed.modules.map((m) => m.manifest.id), ['demo'])
    assert.equal(syncListed.modules[0].trust.status, 'unsigned')
    assert.equal(syncListed.rejected.length, 0)
  })
}

async function testTrustedClassification(): Promise<void> {
  await withTempDir(async (dir) => {
    const root = join(dir, 'modules')
    await writeModuleFolder(root, 'demo', manifestJson({ id: 'demo' }))
    // Trust must bind to the installed manifest's fingerprint.
    const discovered = await discoverUserModules(root, EMPTY_TRUST)
    const fp = manifestFingerprint(discovered.modules[0].manifest)
    const trusted = await discoverUserModules(root, { trustedModules: new Map([['demo', fp]]) })
    assert.equal(trusted.modules[0].trust.status, 'trusted')
    // A stale/wrong fingerprint does not trust.
    const stale = await discoverUserModules(root, { trustedModules: new Map([['demo', 'deadbeef']]) })
    assert.equal(stale.modules[0].trust.status, 'unsigned')
  })
}

async function testReservedIdRejected(): Promise<void> {
  await withTempDir(async (dir) => {
    const src = await writeModuleFolder(dir, 'git', manifestJson({ id: 'git' }))
    const install = await installModuleFolder(src, join(dir, 'modules'), EMPTY_TRUST)
    assert.equal(install.ok, false, 'cannot install a module that shadows a built-in id')
  })
}

async function testIdDirMismatchRejected(): Promise<void> {
  await withTempDir(async (dir) => {
    const root = join(dir, 'modules')
    // Folder name "wrong" but manifest id "demo" → discovery rejects it.
    await writeModuleFolder(root, 'wrong', manifestJson({ id: 'demo' }))
    const listed = await discoverUserModules(root, EMPTY_TRUST)
    assert.deepEqual(listed.modules, [])
    assert.equal(listed.rejected.length, 1)
    assert.match(listed.rejected[0].issues[0].message, /must match its folder name/)
  })
}

async function testInvalidManifestRejected(): Promise<void> {
  await withTempDir(async (dir) => {
    const root = join(dir, 'modules')
    await writeModuleFolder(root, 'broken', '{ not json')
    const listed = await discoverUserModules(root, EMPTY_TRUST)
    assert.deepEqual(listed.modules, [])
    assert.equal(listed.rejected.length, 1)
  })
}

async function main(): Promise<void> {
  await testInstallThenDiscover()
  await testTrustedClassification()
  await testReservedIdRejected()
  await testIdDirMismatchRejected()
  await testInvalidManifestRejected()
  console.log('user-module-registry tests passed')
}

void main()
