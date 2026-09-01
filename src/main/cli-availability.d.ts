import type { AgentCli, AgentCliAvailabilityMap, CliDetectResult, CliRuntimeSettings, PluginDetectAvailabilityInput, TerminalSpawnResult } from '../shared/electron-api';
import type { PluginRegistryListEntry } from '../shared/plugin-manifest';
export declare function invalidateCliAvailability(cli?: AgentCli): void;
export declare function clearCliAvailabilityCache(): void;
export type DetectAgentCliAvailabilityDeps = {
    listEntries?: () => PluginRegistryListEntry[];
    detect?: (cli: AgentCli, runtime?: Partial<CliRuntimeSettings>) => Promise<CliDetectResult>;
    now?: () => number;
    ttlMs?: number;
};
export declare function detectAgentCliAvailability(input?: PluginDetectAvailabilityInput, deps?: DetectAgentCliAvailabilityDeps): Promise<AgentCliAvailabilityMap>;
export declare const AGENT_CLI_NOT_FOUND_EXIT = 127;
export type AgentCliLaunchPreflight = {
    status: 'resolved';
    binaryPath: string;
} | {
    status: 'unknown';
} | {
    status: 'missing';
    message: string;
};
export declare function preflightAgentCliLaunch(input: {
    cli: AgentCli;
    cliRuntimes?: Partial<Record<AgentCli, Partial<CliRuntimeSettings>>>;
    platform?: NodeJS.Platform;
    shell?: string;
}, deps?: DetectAgentCliAvailabilityDeps): Promise<AgentCliLaunchPreflight>;
export declare function agentCliLaunchFailureResult(preflight: AgentCliLaunchPreflight, sessionId: string): TerminalSpawnResult | null;
