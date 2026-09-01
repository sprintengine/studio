// Trust classification for third-party modules.
//
// The pure sign/verify/canonicalization logic lives in the published SDK
// (packages/module-sdk/src/signing.ts) so the app and the `multicode-module`
// CLI can never disagree about what a valid signature is; this module re-exports
// it and adds the app's trust policy on top.
import { manifestFingerprint, verifyModuleSignature, } from '../../../packages/module-sdk/src/signing';
export { manifestFingerprint, verifyModuleSignature };
export function classifyModuleTrust(manifest, ctx) {
    return classifySignedManifestTrust(manifest, ctx);
}
export function classifySignedManifestTrust(manifest, ctx) {
    // Trust is honored only if the user trusted *this exact* manifest content.
    const idTrusted = ctx.trustedModules.get(manifest.id) === manifestFingerprint(manifest);
    if (!manifest.signature) {
        return idTrusted ? { status: 'trusted' } : { status: 'unsigned' };
    }
    const { valid, fingerprint } = verifyModuleSignature(manifest);
    if (!valid)
        return { status: 'invalid', fingerprint };
    const keyAccepted = fingerprint !== undefined && (ctx.trustedKeyFingerprints?.has(fingerprint) ?? false);
    if (idTrusted || keyAccepted)
        return { status: 'trusted', fingerprint };
    return { status: 'signed', fingerprint };
}
// Publisher-locked reserved ids (MC-1532): a module claiming a bundled id
// must carry a VALID signature from a first-party marketplace publisher key
// (trusted-publishers.json → ctx.trustedKeyFingerprints). User-granted id
// trust deliberately does NOT satisfy this — trusting a third-party module
// must never let it shadow a bundled id.
export function isSignedByTrustedPublisher(manifest, ctx) {
    if (!manifest.signature)
        return false;
    const { valid, fingerprint } = verifyModuleSignature(manifest);
    return valid && fingerprint !== undefined && (ctx.trustedKeyFingerprints?.has(fingerprint) ?? false);
}
// Only fully-trusted modules are eligible to load; everything else is gated.
export function isLoadEligible(trust) {
    return trust === 'trusted';
}
