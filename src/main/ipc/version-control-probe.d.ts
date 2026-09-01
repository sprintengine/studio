import { type VersionControlProviderId, type VersionControlProviderProbe } from '../../shared/version-control';
import type { BinaryVersionProbe } from '../cli-runtime-install';
export type VersionControlProbeDeps = {
    probeVersion(binary: VersionControlProviderId): Promise<BinaryVersionProbe>;
    readGhLogin(): Promise<string | null>;
};
export declare function probeVersionControlProviders(deps: VersionControlProbeDeps): Promise<VersionControlProviderProbe[]>;
export declare function parseGhAuthLogin(output: string): string | null;
