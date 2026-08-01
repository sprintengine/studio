import assert from 'node:assert/strict'

import {
  canonicalManifestPayload,
  parseThirdPartyModuleManifest,
  validateThirdPartyModuleManifest,
} from './third-party-manifest'
import type { ModuleSignature } from './manifest'

const VALID = {
  id: 'my-module',
  displayName: 'My module',
  version: 1,
  summary: 'Does a thing.',
  permissions: ['network'],
}

function testValidForcesThirdPartyAndStripsCore(): void {
  const result = validateThirdPartyModuleManifest({ ...VALID, core: true, source: 'bundled', defaultEnabled: true })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.manifest.source, 'third-party', 'source is forced to third-party')
    assert.equal((result.manifest as { core?: boolean }).core, undefined, 'core is stripped')
    assert.equal(result.manifest.defaultEnabled, true)
    assert.deepEqual(result.manifest.permissions, ['network'])
  }
}

function testDefaultEnabledDefaultsFalse(): void {
  const result = validateThirdPartyModuleManifest(VALID)
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.manifest.defaultEnabled, false, 'third-party defaults off')
}

function testRejectsBadId(): void {
  for (const id of ['Bad Id', 'UPPER', '../escape', 'a/b']) {
    const result = validateThirdPartyModuleManifest({ ...VALID, id })
    assert.equal(result.ok, false, `id "${id}" should be rejected`)
  }
}

function testRejectsBadVersion(): void {
  assert.equal(validateThirdPartyModuleManifest({ ...VALID, version: 0 }).ok, false)
  assert.equal(validateThirdPartyModuleManifest({ ...VALID, version: 1.5 }).ok, false)
  assert.equal(validateThirdPartyModuleManifest({ ...VALID, version: '1' }).ok, false)
}

function testRejectsEntryTraversal(): void {
  for (const main of ['../evil.js', '/abs/evil.js', 'a/../../escape.js', 'win\\path.js']) {
    const result = validateThirdPartyModuleManifest({ ...VALID, entry: { main } })
    assert.equal(result.ok, false, `entry.main "${main}" should be rejected`)
  }
  const ok = validateThirdPartyModuleManifest({ ...VALID, entry: { main: 'dist/main.js' } })
  assert.equal(ok.ok, true)
  if (ok.ok) assert.equal(ok.manifest.entry?.main, 'dist/main.js')
}

function testSignatureShape(): void {
  const bad = validateThirdPartyModuleManifest({ ...VALID, signature: { algorithm: 'rsa', publicKey: 'x', signature: 'y' } })
  assert.equal(bad.ok, false, 'only ed25519 accepted')
  const good = validateThirdPartyModuleManifest({
    ...VALID,
    signature: { algorithm: 'ed25519', publicKey: 'YWJj', signature: 'ZGVm' },
  })
  assert.equal(good.ok, true)
}

function testCanonicalPayloadExcludesSignatureAndIsStable(): void {
  const signedManifest: Record<string, unknown> & { signature?: ModuleSignature } = {
    id: 'm',
    displayName: 'M',
    version: 1,
    defaultEnabled: false,
    source: 'third-party',
    permissions: ['network'],
    signature: { algorithm: 'ed25519', publicKey: 'k', signature: 's' },
  }
  const a = canonicalManifestPayload(signedManifest)
  // Same fields, different insertion order, no signature → identical canonical bytes.
  const unsignedManifest: Record<string, unknown> & { signature?: ModuleSignature } = {
    source: 'third-party',
    permissions: ['network'],
    version: 1,
    defaultEnabled: false,
    displayName: 'M',
    id: 'm',
  }
  const b = canonicalManifestPayload(unsignedManifest)
  assert.equal(a, b, 'canonical payload is order-independent and excludes signature')
  assert.equal(a.includes('signature'), false)
}

function testParseInvalidJson(): void {
  assert.equal(parseThirdPartyModuleManifest('{nope').ok, false)
}

// Publisher-locked reserved ids (MC-1532): reserved-id policy is NOT the
// parser's — a manifest claiming a bundled id must parse cleanly WITH its
// signature intact, because the registry decides both directions (locked id +
// wrong signer rejected, locked id + verified first-party signer accepted)
// from the parsed signature. A parser that rejected reserved ids, or dropped
// the signature, would silently break the accept direction.
function testReservedIdParsesWithSignaturePreserved(): void {
  const signature: ModuleSignature = { algorithm: 'ed25519', publicKey: 'YWJj', signature: 'ZGVm' }
  const parsed = parseThirdPartyModuleManifest(
    JSON.stringify({ ...VALID, id: 'switchboard', signature })
  )
  assert.equal(parsed.ok, true, 'reserved ids are policy for the registry, not a parse error')
  if (parsed.ok) {
    assert.equal(parsed.manifest.id, 'switchboard')
    assert.deepEqual(
      (parsed.manifest as { signature?: ModuleSignature }).signature,
      signature,
      'the signature survives validation for the publisher-lock check'
    )
  }
}

testValidForcesThirdPartyAndStripsCore()
testDefaultEnabledDefaultsFalse()
testRejectsBadId()
testRejectsBadVersion()
testRejectsEntryTraversal()
testSignatureShape()
testCanonicalPayloadExcludesSignatureAndIsStable()
testParseInvalidJson()
testReservedIdParsesWithSignaturePreserved()
console.log('third-party-manifest tests passed')
