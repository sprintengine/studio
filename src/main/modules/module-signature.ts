// Trust classification for third-party modules.
//
// The pure sign/verify/canonicalization logic lives in the published SDK
// (packages/module-sdk/src/signing.ts) so the app and the `sprintengine-module`
// CLI can never disagree about what a valid signature is; this module re-exports
// it and adds the app's trust policy on top.

import {
  manifestFingerprint,
  verifyModuleSignature,
  type SignedManifest,
} from '../../../packages/module-sdk/src/signing'

import type { CapabilityManifest, ModuleTrustStatus } from '../../shared/modules/manifest'

export type { ModuleTrustStatus } from '../../shared/modules/manifest'
export { manifestFingerprint, verifyModuleSignature }
export type { SignedManifest }

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

export type ModuleTrust = {
  status: ModuleTrustStatus
  /** sha256 of the signer's normalized public key (hex), when signed. */
  fingerprint?: string
}

export function classifyModuleTrust(manifest: CapabilityManifest, ctx: ModuleTrustContext): ModuleTrust {
  return classifySignedManifestTrust(manifest, ctx)
}

export function classifySignedManifestTrust(manifest: SignedManifest, ctx: ModuleTrustContext): ModuleTrust {
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

// Publisher-locked reserved ids: a module claiming a bundled id
// must carry a VALID signature from a first-party marketplace publisher key
// (trusted-publishers.json → ctx.trustedKeyFingerprints). User-granted id
// trust deliberately does NOT satisfy this — trusting a third-party module
// must never let it shadow a bundled id.
export function isSignedByTrustedPublisher(manifest: SignedManifest, ctx: ModuleTrustContext): boolean {
  if (!manifest.signature) return false
  const { valid, fingerprint } = verifyModuleSignature(manifest)
  return valid && fingerprint !== undefined && (ctx.trustedKeyFingerprints?.has(fingerprint) ?? false)
}

// Only fully-trusted modules are eligible to load; everything else is gated.
export function isLoadEligible(trust: ModuleTrustStatus): boolean {
  return trust === 'trusted'
}
