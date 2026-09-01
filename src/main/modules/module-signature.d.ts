import { manifestFingerprint, verifyModuleSignature, type SignedManifest } from '../../../packages/module-sdk/src/signing';
import type { CapabilityManifest, ModuleTrustStatus } from '../../shared/modules/manifest';
export type { ModuleTrustStatus } from '../../shared/modules/manifest';
export { manifestFingerprint, verifyModuleSignature };
export type { SignedManifest };
export type ModuleTrustContext = {
    /**
     * Trusted modules, keyed by id to the manifest fingerprint that was trusted.
     * Trust binds to content: if a module is reinstalled with a different manifest
     * (escalated permissions, new entry points, …) the fingerprint no longer
     * matches and the module reverts to needing approval. This closes the
     * "reinstall different code under an already-trusted id" bypass.
     */
    trustedModules: ReadonlyMap<string, string>;
    /** Accepted publisher key fingerprints (reserved for the marketplace tier). */
    trustedKeyFingerprints?: ReadonlySet<string>;
};
export type ModuleTrust = {
    status: ModuleTrustStatus;
    /** sha256 of the signer's normalized public key (hex), when signed. */
    fingerprint?: string;
};
export declare function classifyModuleTrust(manifest: CapabilityManifest, ctx: ModuleTrustContext): ModuleTrust;
export declare function classifySignedManifestTrust(manifest: SignedManifest, ctx: ModuleTrustContext): ModuleTrust;
export declare function isSignedByTrustedPublisher(manifest: SignedManifest, ctx: ModuleTrustContext): boolean;
export declare function isLoadEligible(trust: ModuleTrustStatus): boolean;
