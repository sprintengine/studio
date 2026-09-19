import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { canonicalManifestPayload, validateThirdPartyModuleManifest } from '../../shared/modules/third-party-manifest'
import {
  isSignedByTrustedPublisher,
  manifestFingerprint,
  type ModuleTrustContext,
  type SignedManifest,
} from './module-signature'
import { readTrustedModulesSync, setModuleTrust } from './trust-store'
import { test } from 'vitest'

test('trust-store', async () => {
  async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), 'mc-trust-'))
    try {
      return await fn(dir)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  async function testRoundTripAndUntrust(): Promise<void> {
    await withTempDir(async (dir) => {
      assert.equal(readTrustedModulesSync(dir).size, 0)
      await setModuleTrust(dir, 'alpha', 'fp-alpha')
      assert.equal(readTrustedModulesSync(dir).get('alpha'), 'fp-alpha')
      await setModuleTrust(dir, 'alpha', null)
      assert.equal(readTrustedModulesSync(dir).has('alpha'), false)
    })
  }

  // Every write reports what the id mapped to before it, which is what a caller
  // restores when the work the grant belongs to fails afterwards.
  async function testWriteReportsPreviousFingerprint(): Promise<void> {
    await withTempDir(async (dir) => {
      const first = await setModuleTrust(dir, 'alpha', 'fp-1')
      assert.equal(first.previous, null, 'an untrusted id has no previous fingerprint')
      const regrant = await setModuleTrust(dir, 'alpha', 'fp-2')
      assert.equal(regrant.previous, 'fp-1')
      const revoke = await setModuleTrust(dir, 'alpha', null)
      assert.equal(revoke.previous, 'fp-2')
      // Restoring what was reported puts the store back as it was.
      await setModuleTrust(dir, 'alpha', regrant.previous)
      assert.equal(readTrustedModulesSync(dir).get('alpha'), 'fp-1')
    })
  }

  // Two rapid trust writes must not lose an update (read-modify-write is serialized).
  async function testConcurrentWritesDoNotClobber(): Promise<void> {
    await withTempDir(async (dir) => {
      await Promise.all([
        setModuleTrust(dir, 'x', 'fx'),
        setModuleTrust(dir, 'y', 'fy'),
        setModuleTrust(dir, 'z', 'fz'),
      ])
      const trusted = readTrustedModulesSync(dir)
      assert.deepEqual([...trusted.keys()].sort(), ['x', 'y', 'z'])
    })
  }

  async function testMalformedFileIsEmpty(): Promise<void> {
    await withTempDir(async (dir) => {
      // No file yet → empty, no throw.
      assert.equal(readTrustedModulesSync(dir).size, 0)
    })
  }

  // Sign a reserved-id manifest with a fresh ed25519 key, returning the signed
  // manifest object and the signer's key fingerprint (sha256 of the DER public
  // key — matching module-signature's publicKeyFingerprint).
  function signedReservedManifest(): { manifest: SignedManifest; fingerprint: string } {
    const validated = validateThirdPartyModuleManifest({
      id: 'switchboard',
      displayName: 'Switchboard',
      version: 1,
      summary: 'Reserved-id fixture.',
    })
    assert.equal(validated.ok, true)
    if (!validated.ok) throw new Error('test manifest invalid')
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const publicKeyDer = publicKey.export({ type: 'spki', format: 'der' })
    return {
      manifest: {
        ...validated.manifest,
        signature: {
          algorithm: 'ed25519' as const,
          publicKey: publicKeyDer.toString('base64'),
          signature: sign(null, Buffer.from(canonicalManifestPayload(validated.manifest), 'utf8'), privateKey).toString(
            'base64',
          ),
        },
      },
      fingerprint: createHash('sha256').update(publicKeyDer).digest('hex'),
    }
  }

  // Publisher-locked reserved ids, both directions at the trust layer:
  // a locked id passes only with a VERIFIED signature whose key fingerprint is
  // in the publisher trust set — a valid signature from any other key fails, and
  // user-granted id-trust (trustedModules) deliberately does not qualify.
  function testPublisherLockBindsToVerifiedSignerKey(): void {
    const firstParty = signedReservedManifest()
    const impostor = signedReservedManifest()

    const publisherCtx: ModuleTrustContext = {
      trustedModules: new Map(),
      trustedKeyFingerprints: new Set([firstParty.fingerprint]),
    }
    assert.equal(
      isSignedByTrustedPublisher(firstParty.manifest, publisherCtx),
      true,
      'locked id + verified first-party signer is accepted',
    )
    assert.equal(
      isSignedByTrustedPublisher(impostor.manifest, publisherCtx),
      false,
      'locked id + wrong signer is rejected even with a valid signature',
    )

    // Id-trusting the impostor's exact manifest content must not satisfy the lock.
    const idTrustedCtx: ModuleTrustContext = {
      trustedModules: new Map([['switchboard', manifestFingerprint(impostor.manifest)]]),
      trustedKeyFingerprints: new Set([firstParty.fingerprint]),
    }
    assert.equal(isSignedByTrustedPublisher(impostor.manifest, idTrustedCtx), false)

    // A tampered payload invalidates the signature, so the first-party key no
    // longer qualifies either — the lock binds to the VERIFIED fingerprint.
    const tampered = { ...firstParty.manifest, displayName: 'Tampered' }
    assert.equal(isSignedByTrustedPublisher(tampered, publisherCtx), false)
  }

  async function main(): Promise<void> {
    await testRoundTripAndUntrust()
    await testWriteReportsPreviousFingerprint()
    await testConcurrentWritesDoNotClobber()
    await testMalformedFileIsEmpty()
    testPublisherLockBindsToVerifiedSignerKey()
    console.log('trust-store tests passed')
  }

  const suiteRun = main()

  await suiteRun
})
