import type { AgentCli, CliDetectResult, CliInstallInput, CliInstallMethodInfo, CliInstallResult, CliRuntimeSettings } from '../shared/electron-api';
import type { PluginInstallPlatform } from '../shared/plugin-manifest';
export type SpawnDescriptor = {
    file: string;
    args: string[];
};
export declare function resolveInstallPlatform(platform: NodeJS.Platform, useWsl: boolean): PluginInstallPlatform;
export declare function buildProbeDescriptor(input: {
    binary: string;
    versionArgs: string[];
    target: PluginInstallPlatform;
}): SpawnDescriptor;
export declare function userShellProbeSupported(target: PluginInstallPlatform, shell: string | undefined): shell is string;
export declare function buildUserShellProbeDescriptor(input: {
    binary: string;
    versionArgs: string[];
    target: PluginInstallPlatform;
    shell: string | undefined;
}): SpawnDescriptor | null;
export declare function buildExistsDescriptor(input: {
    binary: string;
    target: PluginInstallPlatform;
}): SpawnDescriptor;
export declare function buildInstallDescriptor(input: {
    shell: string;
    target: PluginInstallPlatform;
}): SpawnDescriptor;
export declare function parseProbeOutput(code: number, stdout: string): {
    installed: boolean;
    version: string | null;
    resolvedPath: string | null;
};
export type ProbeVerdict = {
    parsed: ReturnType<typeof parseProbeOutput>;
    inconclusive: boolean;
};
export type BinaryVersionProbe = {
    outcome: 'resolved';
    version: string;
    resolvedPath: string | null;
} | {
    outcome: 'not_installed';
} | {
    outcome: 'probe_failed';
};
export declare function binaryVersionProbeFrom({ parsed, inconclusive }: ProbeVerdict): BinaryVersionProbe;
export declare function probeBinaryVersion(binary: string): Promise<BinaryVersionProbe>;
export declare function detectCli(cli: AgentCli, runtime?: Partial<CliRuntimeSettings>, env?: NodeJS.ProcessEnv): Promise<CliDetectResult>;
export declare function cliInstallMethods(cli: AgentCli, runtime?: Partial<CliRuntimeSettings>): Promise<CliInstallMethodInfo[]>;
export declare function installCli(input: CliInstallInput, runtime: Partial<CliRuntimeSettings> | undefined, onData?: (chunk: string) => void): Promise<CliInstallResult>;
export declare function buildUpdateDescriptor(input: {
    binary: string;
    args: string[];
    target: PluginInstallPlatform;
}): SpawnDescriptor;
export declare function updateCli(cli: AgentCli, runtime: Partial<CliRuntimeSettings> | undefined, onData?: (chunk: string) => void): Promise<CliInstallResult>;
