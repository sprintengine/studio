import { createHash, createPublicKey, verify } from 'crypto'

import type { CapabilityManifest, ModuleTrustStatus } from '../../shared/modules/manifest'
import { canonicalManifestPayload } from '../../shared/modules/third-party-manifest'

export type { ModuleTrustStatus } from '../../shared/modules/manifest'

export type ModuleTrustContext = {
  /**
   * Trusted modules, keyed by id to the manifest fingerprint that was trusted.
   * Trust binds to content: if a module is reinstalled with a different manifest
   * (escalated permissions, new entry points, …) the fingerprint no longer
   * matches and the module reverts to needing approval. This closes the
   * "reinstall different code under an already-trusted id" bypass.
   */
  trustedModules: ReadonlyMap<string, string>
  /** Accepted publisher key fingerprints (reserved for the marketplace tier). */
  trustedKeyFingerprints?: ReadonlySet<string>
}

// A content fingerprint of the manifest's security-relevant declaration
// (everything except the signature itself): id, version, permissions, entry,
// deps. Trust is recorded against this so a changed declaration voids trust.
// NOTE: this covers the declared manifest, not the entry bundle bytes — full
// content integrity (hashing the code) must land before third-party code is
// ever executed (a later Phase 7 increment).
export function manifestFingerprint(manifest: CapabilityManifest): string {
  return createHash('sha256').update(canonicalManifestPayload(manifest)).digest('hex')
}

export type ModuleTrust = {
  status: ModuleTrustStatus
  /** sha256 of the signer's normalized public key (hex), when signed. */
  fingerprint?: string
}

function publicKeyFingerprint(publicKeyB64: string): string | undefined {
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
export function verifyModuleSignature(manifest: CapabilityManifest): { valid: boolean; fingerprint?: string } {
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

export function classifyModuleTrust(manifest: CapabilityManifest, ctx: ModuleTrustContext): ModuleTrust {
  // Trust is honored only if the user trusted *this exact* manifest content.
  const idTrusted = ctx.trustedModules.get(manifest.id) === manifestFingerprint(manifest)
  if (!manifest.signature) {
    return idTrusted ? { status: 'trusted' } : { status: 'unsigned' }
  }
  const { valid, fingerprint } = verifyModuleSignature(manifest)
  if (!valid) return { status: 'invalid', fingerprint }
  const keyAccepted = fingerprint !== undefined && (ctx.trustedKeyFingerprints?.has(fingerprint) ?? false)
  if (idTrusted || keyAccepted) return { status: 'trusted', fingerprint }
  return { status: 'signed', fingerprint }
}

// Only fully-trusted modules are eligible to load; everything else is gated.
export function isLoadEligible(trust: ModuleTrustStatus): boolean {
  return trust === 'trusted'
}
