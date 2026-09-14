// Module signing: ed25519 sign/verify over the canonical manifest payload.
//
// Subpath export `@sprintengine/module-sdk/signing` (not part of the root index:
// this file needs node:crypto, and the root index must stay loadable in a
// renderer). The Multicode app's signature verification
// (src/main/modules/module-signature.ts) and the `multicode-module` CLI both
// consume these functions, so signer and verifier can never disagree about
// what a valid signature is.
//
// The signature is a detached ed25519 signature over canonicalManifestPayload
// (the validated manifest minus its `signature` field, sorted-key JSON).
// Public API uses only strings (PEM / base64) so the published declaration
// surface carries no Node type dependency.

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto'

import type { ModuleSignature } from './index.js'
import { canonicalManifestPayload } from './manifest-validate.js'

/** The minimum a manifest needs for signature work; full manifests satisfy it. */
export type SignedManifest = {
  id: string
  signature?: ModuleSignature
}

// A content fingerprint of the manifest's security-relevant declaration
// (everything except the signature itself): id, version, permissions, entry,
// deps. The app records trust against this so a changed declaration voids
// trust. NOTE: this covers the declared manifest, not the entry bundle bytes —
// full content integrity (hashing the code) must land before third-party code
// is ever executed.
export function manifestFingerprint(manifest: SignedManifest): string {
  return createHash('sha256').update(canonicalManifestPayload(manifest)).digest('hex')
}

/** sha256 hex of the signer's normalized (SPKI DER) public key; undefined when malformed. */
export function publicKeyFingerprint(publicKeyB64: string): string | undefined {
  try {
    const der = Buffer.from(publicKeyB64, 'base64')
    const key = createPublicKey({ key: der, format: 'der', type: 'spki' })
    const normalized = key.export({ type: 'spki', format: 'der' })
    return createHash('sha256').update(normalized).digest('hex')
  } catch {
    return undefined
  }
}

// Verify the detached ed25519 signature over the canonical manifest payload
// (the manifest minus its signature field). Returns whether it's valid plus the
// signer's key fingerprint. Any malformed key/signature is treated as invalid,
// never thrown.
export function verifyModuleSignature(manifest: SignedManifest): { valid: boolean; fingerprint?: string } {
  const sig = manifest.signature
  if (!sig) return { valid: false }
  try {
    const der = Buffer.from(sig.publicKey, 'base64')
    const key = createPublicKey({ key: der, format: 'der', type: 'spki' })
    const payload = Buffer.from(canonicalManifestPayload(manifest), 'utf8')
    const valid = verify(null, payload, key, Buffer.from(sig.signature, 'base64'))
    return { valid, fingerprint: publicKeyFingerprint(sig.publicKey) }
  } catch {
    return { valid: false }
  }
}

export type ModuleSigningKeyPair = {
  /** PKCS#8 PEM — the secret. Keep it out of the module directory and out of git. */
  privateKeyPem: string
  /** Base64 SPKI DER — what lands in manifest.signature.publicKey. */
  publicKeyB64: string
  /** sha256 hex of the public key, as the app's trust UI displays it. */
  fingerprint: string
}

export function generateModuleSigningKeyPair(): ModuleSigningKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const publicKeyB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyB64,
    // The key was just exported in normalized form, so the fingerprint cannot
    // be undefined; the fallback only guards the type.
    fingerprint: publicKeyFingerprint(publicKeyB64) ?? '',
  }
}

// Produce the detached signature for a validated manifest. The caller must
// pass the manifest in its VALIDATED shape (validateThirdPartyModuleManifest
// output): the app verifies over that shape, so signing anything else (for
// example the raw file JSON with unknown keys) yields a signature the app
// rejects. Throws on a malformed private key — explicit failure, no fallback.
export function signManifest(manifest: SignedManifest, privateKeyPem: string): ModuleSignature {
  const key = createPrivateKey(privateKeyPem)
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error(`Signing key must be ed25519, got ${key.asymmetricKeyType ?? 'unknown'}.`)
  }
  const payload = Buffer.from(canonicalManifestPayload(manifest), 'utf8')
  const signature = sign(null, payload, key).toString('base64')
  const publicKeyB64 = createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64')
  return { algorithm: 'ed25519', publicKey: publicKeyB64, signature }
}
