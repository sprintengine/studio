import type { ManifestAuth } from '../shared/plugin-manifest';
export type CredentialOwner = {
    manifest: {
        auth?: ManifestAuth;
    };
};
export declare function resolveCredentialOwner(id: string): CredentialOwner | undefined;
