import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { test } from 'vitest'

import type { CapabilityManifest } from '../../shared/modules/manifest'
import { canonicalManifestPayload, parseThirdPartyModuleManifest } from '../../shared/modules/third-party-manifest'
import { findMarketplaceResourcePath } from '../marketplace/resources'
import {
  classifyModuleTrust,
  classifySignedManifestTrust,
  computeModuleFileDigestsSync,
  isLoadEligible,
  isTrustedByPublisher,
  manifestFingerprint,
  moduleContentFingerprint,
  moduleContentFingerprintSync,
  verifyModuleSignature,
  type ModuleTrustContext,
} from './module-signature'

const MAIN_SOURCE = 'exports.registerMain = () => {}\n'

function baseManifest(): CapabilityManifest {
  return {
    id: 'signed-module',
    displayName: 'Signed module',
    version: 1,
    defaultEnabled: false,
    source: 'third-party',
    permissions: ['network'],
    entry: { main: 'dist/main.cjs' },
  }
}

type Signer = { sign: (manifest: CapabilityManifest) => CapabilityManifest; fingerprint: string }

function newSigner(): Signer {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const publicKeyB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
  const signer = {
    sign: (manifest: CapabilityManifest): CapabilityManifest => {
      const payload = Buffer.from(canonicalManifestPayload(manifest), 'utf8')
      const signature = sign(null, payload, privateKey).toString('base64')
      return { ...manifest, signature: { algorithm: 'ed25519', publicKey: publicKeyB64, signature } }
    },
    fingerprint: '',
  }
  signer.fingerprint = verifyModuleSignature(signer.sign(baseManifest())).fingerprint!
  return signer
}

// A module folder holding dist/main.cjs, with the manifest written beside it.
function moduleFolder(): string {
  const root = mkdtempSync(join(tmpdir(), 'mc-module-signature-'))
  mkdirSync(join(root, 'dist'), { recursive: true })
  writeFileSync(join(root, 'dist', 'main.cjs'), MAIN_SOURCE)
  return root
}

function withManifest(root: string, manifest: CapabilityManifest): CapabilityManifest {
  writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest))
  return manifest
}

// Signed the way `sprintengine-module sign` signs: with the folder's digests.
function signedWithFiles(root: string, signer: Signer, manifest = baseManifest()): CapabilityManifest {
  const files = computeModuleFileDigestsSync(root).files
  return withManifest(root, signer.sign({ ...manifest, files }))
}

function withTemp(fn: (root: string) => void): void {
  const root = moduleFolder()
  try {
    fn(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const NO_TRUST: ModuleTrustContext = { trustedModules: new Map() }

test('a valid signature verifies and a changed signed field does not', () => {
  const signed = newSigner().sign(baseManifest())
  assert.equal(verifyModuleSignature(signed).valid, true)
  const renamed: CapabilityManifest = { ...signed, displayName: 'Evil module' }
  assert.equal(verifyModuleSignature(renamed).valid, false)
})

test('a signature over a manifest without files still verifies byte for byte', () => {
  // The first-party review module was signed before `files` existed. Its
  // signature must keep verifying: the payload only grows a `files` key when
  // the manifest has one.
  const path = findMarketplaceResourcePath('plugins/review/module/manifest.json')
  assert.ok(path)
  const parsed = parseThirdPartyModuleManifest(readFileSync(path, 'utf8'))
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  assert.equal(parsed.manifest.files, undefined)
  assert.equal(canonicalManifestPayload(parsed.manifest).includes('"files"'), false)
  assert.equal(verifyModuleSignature(parsed.manifest).valid, true)
})

test('the files map is part of the signed payload', () => {
  const signer = newSigner()
  const signed = signer.sign({ ...baseManifest(), files: { 'dist/main.cjs': 'a'.repeat(64) } })
  assert.equal(verifyModuleSignature(signed).valid, true)
  const otherDigest: CapabilityManifest = { ...signed, files: { 'dist/main.cjs': 'b'.repeat(64) } }
  const noDigests: CapabilityManifest = { ...signed, files: undefined }
  assert.equal(verifyModuleSignature(otherDigest).valid, false)
  assert.equal(verifyModuleSignature(noDigests).valid, false)
})

test('a signed manifest without files is not trusted by its publisher key', () => {
  withTemp((root) => {
    const signer = newSigner()
    const manifest = withManifest(root, signer.sign(baseManifest()))
    const trust = classifyModuleTrust(manifest, root, {
      trustedModules: new Map(),
      trustedKeyFingerprints: new Set([signer.fingerprint]),
    })
    assert.equal(trust.status, 'signed')
    assert.equal(isTrustedByPublisher(trust), false)
    assert.match(trust.issues?.[0]?.message ?? '', /lists no digests of its code/)
  })
})

test('a signed manifest whose files match is trusted by its publisher key', () => {
  withTemp((root) => {
    const signer = newSigner()
    const manifest = signedWithFiles(root, signer)
    const trust = classifyModuleTrust(manifest, root, {
      trustedModules: new Map(),
      trustedKeyFingerprints: new Set([signer.fingerprint]),
    })
    assert.equal(trust.status, 'trusted')
    assert.equal(trust.via, 'publisher')
    assert.deepEqual(Object.keys(trust.verifiedFiles ?? {}), ['dist/main.cjs'])
  })
})

test('a changed code file under signed digests is invalid and tampered', () => {
  withTemp((root) => {
    const signer = newSigner()
    const manifest = signedWithFiles(root, signer)
    writeFileSync(join(root, 'dist', 'main.cjs'), 'require("child_process").exec("curl evil")\n')
    const trust = classifyModuleTrust(manifest, root, {
      trustedModules: new Map([[manifest.id, manifestFingerprint(manifest)]]),
      trustedKeyFingerprints: new Set([signer.fingerprint]),
    })
    assert.equal(trust.status, 'invalid')
    assert.equal(trust.tampered, true)
    assert.equal(isLoadEligible(trust.status), false)
    assert.deepEqual(trust.issues, [{ path: 'files.dist/main.cjs', message: 'does not match the signed digests.' }])
  })
})

test('a file the signed digests do not list is refused', () => {
  withTemp((root) => {
    const signer = newSigner()
    const manifest = signedWithFiles(root, signer)
    writeFileSync(join(root, 'dist', 'payload.cjs'), 'module.exports = 1\n')
    const trust = classifyModuleTrust(manifest, root, {
      trustedModules: new Map(),
      trustedKeyFingerprints: new Set([signer.fingerprint]),
    })
    assert.equal(trust.status, 'invalid')
    assert.deepEqual(trust.issues, [
      { path: 'files.dist/payload.cjs', message: 'is not listed in the signed digests.' },
    ])
  })
})

test('a symlink in the module folder is refused', () => {
  withTemp((root) => {
    const signer = newSigner()
    const manifest = signedWithFiles(root, signer)
    writeFileSync(join(root, 'elsewhere.cjs'), MAIN_SOURCE)
    rmSync(join(root, 'dist', 'main.cjs'))
    symlinkSync(join(root, 'elsewhere.cjs'), join(root, 'dist', 'main.cjs'))
    const scan = computeModuleFileDigestsSync(root)
    assert.equal(scan.ok, false)
    const trust = classifyModuleTrust(manifest, root, {
      trustedModules: new Map(),
      trustedKeyFingerprints: new Set([signer.fingerprint]),
    })
    assert.equal(trust.status, 'invalid')
    assert.ok(trust.issues?.some((issue) => /symbolic link/.test(issue.message)))
  })
})

test('a grant binds to the manifest fingerprint, which covers the files', () => {
  withTemp((root) => {
    const manifest = withManifest(root, { ...baseManifest(), files: computeModuleFileDigestsSync(root).files })
    const ctx: ModuleTrustContext = { trustedModules: new Map([[manifest.id, manifestFingerprint(manifest)]]) }
    const trusted = classifyModuleTrust(manifest, root, ctx)
    assert.equal(trusted.status, 'trusted')
    assert.equal(trusted.via, 'grant')
    assert.deepEqual(Object.keys(trusted.verifiedFiles ?? {}), ['dist/main.cjs'])

    // The same manifest over different code no longer matches what it lists.
    writeFileSync(join(root, 'dist', 'main.cjs'), 'require("child_process").exec("curl evil")\n')
    const swapped = classifyModuleTrust(manifest, root, ctx)
    assert.equal(swapped.status, 'invalid')
    assert.equal(swapped.tampered, true)
  })
})

test('a grant for a manifest without files trusts nothing', () => {
  withTemp((root) => {
    const manifest = withManifest(root, baseManifest())
    const content = moduleContentFingerprintSync(manifest, root)
    assert.ok(content.ok)
    for (const fingerprint of [manifestFingerprint(manifest), content.fingerprint]) {
      const trust = classifyModuleTrust(manifest, root, { trustedModules: new Map([[manifest.id, fingerprint]]) })
      assert.equal(trust.status, 'unsigned')
      assert.equal(trust.verifiedFiles, undefined)
      assert.match(trust.issues?.[0]?.message ?? '', /a trust grant cannot cover it/)
    }
  })
})

test('a grant for a changed manifest does not carry over', () => {
  withTemp((root) => {
    const files = computeModuleFileDigestsSync(root).files
    const original = withManifest(root, { ...baseManifest(), files })
    const swapped = withManifest(root, { ...original, permissions: ['process:spawn', 'network'] })
    const ctx: ModuleTrustContext = { trustedModules: new Map([[original.id, manifestFingerprint(original)]]) }
    assert.equal(classifyModuleTrust(swapped, root, ctx).status, 'unsigned')
  })
})

test('a verified marketplace install vouches for exactly the code it installed', () => {
  withTemp((root) => {
    const signer = newSigner()
    const manifest = withManifest(root, signer.sign(baseManifest()))
    const installed = moduleContentFingerprint(manifest, computeModuleFileDigestsSync(root).files)
    const ctx: ModuleTrustContext = {
      trustedModules: new Map(),
      trustedKeyFingerprints: new Set([signer.fingerprint]),
      verifiedModuleInstalls: new Map([[manifest.id, installed]]),
    }
    const trust = classifyModuleTrust(manifest, root, ctx)
    assert.equal(trust.status, 'trusted')
    assert.equal(trust.via, 'publisher')

    writeFileSync(join(root, 'dist', 'main.cjs'), 'require("child_process").exec("curl evil")\n')
    const swapped = classifyModuleTrust(manifest, root, ctx)
    assert.equal(swapped.status, 'signed')
    assert.match(swapped.issues?.[0]?.message ?? '', /do not match the ones its marketplace install verified/)
  })
})

test('an invalid signature stays invalid even when its content is granted', () => {
  withTemp((root) => {
    const signed = newSigner().sign(baseManifest())
    const tampered = withManifest(root, { ...signed, displayName: 'Evil' })
    const trust = classifyModuleTrust(tampered, root, {
      trustedModules: new Map([[tampered.id, manifestFingerprint(tampered)]]),
    })
    assert.equal(trust.status, 'invalid')
    assert.equal(trust.tampered, undefined)
  })
})

test('manifest-only trust for bundle manifests is unchanged', () => {
  const unsigned = baseManifest()
  assert.equal(classifySignedManifestTrust(unsigned, NO_TRUST).status, 'unsigned')
  assert.equal(
    classifySignedManifestTrust(unsigned, { trustedModules: new Map([[unsigned.id, manifestFingerprint(unsigned)]]) })
      .status,
    'trusted',
  )
  const signer = newSigner()
  const signed = signer.sign(baseManifest())
  assert.equal(classifySignedManifestTrust(signed, NO_TRUST).status, 'signed')
  assert.equal(
    classifySignedManifestTrust(signed, {
      trustedModules: new Map(),
      trustedKeyFingerprints: new Set([signer.fingerprint]),
    }).status,
    'trusted',
  )
})

test('only trusted is load eligible', () => {
  assert.equal(isLoadEligible('trusted'), true)
  assert.equal(isLoadEligible('signed'), false)
  assert.equal(isLoadEligible('unsigned'), false)
  assert.equal(isLoadEligible('invalid'), false)
})
