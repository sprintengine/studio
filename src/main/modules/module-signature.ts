// Trust classification for third-party modules.
//
// The pure sign/verify/canonicalization logic and the walk that digests a
// module folder live in the published SDK (packages/module-sdk/src/signing.ts)
// so the app and the `sprintengine-module` CLI can never disagree about what a
// valid signature is or which files a module ships; this module re-exports
// them and adds the app's trust policy on top.

import {
  computeModuleFileDigestsSync,
  manifestFingerprint,
  moduleFileDigestIssuesSync,
  verifyModuleSignature,
  type SignedManifest,
} from '../../../packages/module-sdk/src/signing'
import { compareModuleFileDigests } from '../../../packages/module-sdk/src/manifest-validate'

import type { CapabilityManifest, ModuleFileDigests, ModuleTrustStatus } from '../../shared/modules/manifest'

export type { ModuleTrustStatus } from '../../shared/modules/manifest'
export { computeModuleFileDigestsSync, manifestFingerprint, moduleFileDigestIssuesSync, verifyModuleSignature }
export type { SignedManifest }

export type ModuleTrustContext = {
  /**
   * Trusted modules, keyed by id to the manifest fingerprint that was trusted.
   * Trust binds to content: the fingerprint covers the manifest's `files`
   * digests, and a grant counts only for a manifest that has them and whose
   * folder matches them exactly — so reinstalling a different manifest, or the
   * same manifest over different code, reverts the module to needing approval.
   */
  trustedModules: ReadonlyMap<string, string>
  /** Accepted publisher key fingerprints (trusted-publishers.json). */
  trustedKeyFingerprints?: ReadonlySet<string>
  /**
   * Modules a verified marketplace install put in place, keyed by id to the
   * content fingerprint of what it installed. The bundle a verified install
   * comes from is signed by a trusted publisher and signs a digest of every
   * file in its module component, so the code was vouched for even when the
   * module's own manifest predates `files`. Read from the install receipts
   * (marketplace/plugin-lifecycle.ts).
   */
  verifiedModuleInstalls?: ReadonlyMap<string, string>
}

export type ModuleTrustIssue = { path: string; message: string }

export type ModuleTrust = {
  status: ModuleTrustStatus
  /** sha256 of the signer's normalized public key (hex), when signed. */
  fingerprint?: string
  /**
   * What made a 'trusted' module trusted: its publisher key (with code the key
   * vouches for) or the user's grant for exactly this manifest and its files.
   */
  via?: 'publisher' | 'grant'
  /**
   * When 'trusted': the digests the module's files were verified against. The
   * loader holds the files to these again immediately before it runs them.
   */
  verifiedFiles?: ModuleFileDigests
  /** The files do not match the digests the manifest declares. */
  tampered?: boolean
  /** Why the module's code is not vouched for, when that is what held it back. */
  issues?: ModuleTrustIssue[]
}

// The fingerprint of a manifest together with a set of file digests: the
// manifest's fingerprint taken with `files` set to them. For a manifest whose
// own `files` match, this IS manifestFingerprint — the value a grant binds to.
// For one without, it is how a verified marketplace install records exactly
// what it installed (see verifiedModuleInstalls).
export function moduleContentFingerprint(manifest: SignedManifest, files: ModuleFileDigests): string {
  const withFiles: SignedManifest & { files: ModuleFileDigests } = { ...manifest, files }
  return manifestFingerprint(withFiles)
}

export type ModuleContentFingerprintResult =
  { ok: true; fingerprint: string; files: ModuleFileDigests } | { ok: false; issues: ModuleTrustIssue[] }

/** The content fingerprint of a module folder, or why it has none (a symlink, a .git …). */
export function moduleContentFingerprintSync(
  manifest: SignedManifest,
  moduleRoot: string,
): ModuleContentFingerprintResult {
  const scan = computeModuleFileDigestsSync(moduleRoot)
  if (!scan.ok) return { ok: false, issues: scan.issues }
  return { ok: true, fingerprint: moduleContentFingerprint(manifest, scan.files), files: scan.files }
}

const NO_DIGESTS_FOR_GRANT: ModuleTrustIssue = {
  path: 'files',
  message:
    'the manifest lists no digests of its code, so a trust grant cannot cover it; ' +
    'sign it with `sprintengine-module sign`, which records them.',
}

// Trust for a module on disk. A publisher key is trusted for the module's
// CODE, not only its manifest, so it counts only when the code is vouched for:
// by `files` digests inside the signed manifest that match the folder exactly,
// or by a verified marketplace install of exactly these bytes. A signed
// manifest with no digests is otherwise just a declaration anybody can copy
// next to code of their own. A grant is the user vouching instead of a key,
// and it too needs `files` to vouch for: it binds to the manifest fingerprint,
// which covers them, so it counts only for the manifest it was given for over
// the files that manifest lists. Digests that do not match are 'invalid'
// whoever signed them.
export function classifyModuleTrust(
  manifest: CapabilityManifest,
  moduleRoot: string,
  ctx: ModuleTrustContext,
): ModuleTrust {
  let signer: string | undefined
  if (manifest.signature) {
    const { valid, fingerprint } = verifyModuleSignature(manifest)
    if (!valid) return { status: 'invalid', fingerprint }
    signer = fingerprint
  }
  const untrusted: ModuleTrustStatus = manifest.signature ? 'signed' : 'unsigned'
  const publisherKey = signer !== undefined && (ctx.trustedKeyFingerprints?.has(signer) ?? false)
  const granted = ctx.trustedModules.get(manifest.id)
  const vouchedInstall = publisherKey ? ctx.verifiedModuleInstalls?.get(manifest.id) : undefined

  // Nothing could make this module trusted, so there is nothing to hash.
  if (!manifest.files && !publisherKey) {
    return granted === undefined
      ? { status: untrusted, fingerprint: signer }
      : { status: untrusted, fingerprint: signer, issues: [NO_DIGESTS_FOR_GRANT] }
  }

  const scan = computeModuleFileDigestsSync(moduleRoot)
  if (manifest.files) {
    const issues = [...(scan.ok ? [] : scan.issues), ...compareModuleFileDigests(manifest.files, scan.files)]
    if (issues.length > 0) return { status: 'invalid', fingerprint: signer, tampered: true, issues }
  }
  if (!scan.ok) return { status: untrusted, fingerprint: signer, issues: scan.issues }

  const codeVouched = manifest.files !== undefined || vouchedInstall === moduleContentFingerprint(manifest, scan.files)
  if (publisherKey && codeVouched) {
    return { status: 'trusted', fingerprint: signer, via: 'publisher', verifiedFiles: scan.files }
  }
  // The folder matched `files` exactly above, so this fingerprint covers the
  // very bytes the loader will be held to.
  if (manifest.files && granted === manifestFingerprint(manifest)) {
    return { status: 'trusted', fingerprint: signer, via: 'grant', verifiedFiles: scan.files }
  }
  if (!publisherKey) return { status: untrusted, fingerprint: signer }
  return {
    status: untrusted,
    fingerprint: signer,
    issues: [
      vouchedInstall === undefined
        ? {
            path: 'files',
            message:
              'the manifest is signed by a trusted publisher but lists no digests of its code, so the signature ' +
              'does not vouch for the files beside it.',
          }
        : {
            path: 'files',
            message:
              'the files do not match the ones its marketplace install verified; reinstall it from the marketplace.',
          },
    ],
  }
}

// Trust for a manifest alone — a plugin bundle's plugin.json or a provider
// manifest, whose bytes are covered by per-component digests checked
// separately. Never use it for a capability module on disk: it does not look
// at the module's code (classifyModuleTrust does).
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

// Publisher-locked reserved ids: a module claiming a bundled id must be
// trusted through a first-party marketplace publisher key
// (trusted-publishers.json → ctx.trustedKeyFingerprints) — which, per
// classifyModuleTrust, also means its code is vouched for. User-granted id
// trust deliberately does NOT satisfy this — trusting a third-party module
// must never let it shadow a bundled id.
export function isTrustedByPublisher(trust: ModuleTrust): boolean {
  return trust.status === 'trusted' && trust.via === 'publisher'
}

// Whether a manifest carries a valid signature by a trusted publisher key. A
// statement about the manifest only: whether that key vouches for the code
// beside it is isTrustedByPublisher's question.
export function isSignedByTrustedPublisher(manifest: SignedManifest, ctx: ModuleTrustContext): boolean {
  if (!manifest.signature) return false
  const { valid, fingerprint } = verifyModuleSignature(manifest)
  return valid && fingerprint !== undefined && (ctx.trustedKeyFingerprints?.has(fingerprint) ?? false)
}

// Only fully-trusted modules are eligible to load; everything else is gated.
export function isLoadEligible(trust: ModuleTrustStatus): boolean {
  return trust === 'trusted'
}
