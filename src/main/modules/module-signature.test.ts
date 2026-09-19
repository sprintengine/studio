import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'crypto'

import type { CapabilityManifest } from '../../shared/modules/manifest'
import { canonicalManifestPayload } from '../../shared/modules/third-party-manifest'
import { classifyModuleTrust, isLoadEligible, manifestFingerprint, verifyModuleSignature } from './module-signature'

function baseManifest(): CapabilityManifest {
  return {
    id: 'signed-module',
    displayName: 'Signed module',
    version: 1,
    defaultEnabled: false,
    source: 'third-party',
    permissions: ['network'],
  }
}

function signManifest(manifest: CapabilityManifest): CapabilityManifest {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const payload = Buffer.from(canonicalManifestPayload(manifest), 'utf8')
  const signature = sign(null, payload, privateKey).toString('base64')
  const publicKeyB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
  return { ...manifest, signature: { algorithm: 'ed25519', publicKey: publicKeyB64, signature } }
}

function testValidSignatureVerifies(): void {
  const signed = signManifest(baseManifest())
  const { valid, fingerprint } = verifyModuleSignature(signed)
  assert.equal(valid, true)
  assert.equal(typeof fingerprint, 'string')
}

function testTamperedSignatureFails(): void {
  const signed = signManifest(baseManifest())
  // Mutate a signed field — the canonical payload no longer matches the signature.
  const tampered: CapabilityManifest = { ...signed, displayName: 'Evil module' }
  assert.equal(verifyModuleSignature(tampered).valid, false)
}

function testUnsignedTrustMatrix(): void {
  const unsigned = baseManifest()
  const fp = manifestFingerprint(unsigned)
  assert.equal(classifyModuleTrust(unsigned, { trustedModules: new Map() }).status, 'unsigned')
  // Trusting the exact content fingerprint → trusted.
  assert.equal(classifyModuleTrust(unsigned, { trustedModules: new Map([['signed-module', fp]]) }).status, 'trusted')
}

// Regression for the reinstall-under-trusted-id bypass: trusting one manifest
// must NOT trust a different manifest reinstalled under the same id.
function testTrustIsContentBound(): void {
  const original = baseManifest()
  const trustedFp = manifestFingerprint(original)
  // Attacker reinstalls different code/permissions under the same id.
  const swapped: CapabilityManifest = { ...original, permissions: ['process:spawn', 'network'] }
  const ctx = { trustedModules: new Map([['signed-module', trustedFp]]) }
  assert.equal(classifyModuleTrust(original, ctx).status, 'trusted')
  assert.equal(
    classifyModuleTrust(swapped, ctx).status,
    'unsigned',
    'a changed manifest does not inherit the prior trust',
  )
}

function testSignedTrustMatrix(): void {
  const signed = signManifest(baseManifest())
  const contentFp = manifestFingerprint(signed)
  // Valid signature, signer not accepted, content not trusted → 'signed'.
  assert.equal(classifyModuleTrust(signed, { trustedModules: new Map() }).status, 'signed')
  // User trusts this content → 'trusted'.
  assert.equal(
    classifyModuleTrust(signed, { trustedModules: new Map([['signed-module', contentFp]]) }).status,
    'trusted',
  )
  // Signer key accepted (marketplace path) → 'trusted'.
  const keyFp = verifyModuleSignature(signed).fingerprint!
  assert.equal(
    classifyModuleTrust(signed, { trustedModules: new Map(), trustedKeyFingerprints: new Set([keyFp]) }).status,
    'trusted',
  )
}

function testInvalidStaysInvalidEvenIfTrusted(): void {
  const signed = signManifest(baseManifest())
  const tampered: CapabilityManifest = { ...signed, displayName: 'Evil' }
  // Even if the user "trusts" the content, a broken signature is never loadable.
  const ctx = { trustedModules: new Map([['signed-module', manifestFingerprint(tampered)]]) }
  const trust = classifyModuleTrust(tampered, ctx)
  assert.equal(trust.status, 'invalid')
  assert.equal(isLoadEligible(trust.status), false)
}

function testEligibility(): void {
  assert.equal(isLoadEligible('trusted'), true)
  assert.equal(isLoadEligible('signed'), false)
  assert.equal(isLoadEligible('unsigned'), false)
  assert.equal(isLoadEligible('invalid'), false)
}

testValidSignatureVerifies()
testTamperedSignatureFails()
testUnsignedTrustMatrix()
testTrustIsContentBound()
testSignedTrustMatrix()
testInvalidStaysInvalidEvenIfTrusted()
testEligibility()
console.log('module-signature tests passed')
