import type { AgentCli, CliRuntimeSettings, SprintEngineCliPermissionPreset, TerminalPathStyle } from '../shared/electron-api';
export type ShellLaunchConfig = {
    command: string;
    args: string[];
    cwd?: string;
    pathStyle: TerminalPathStyle;
    initialInput?: string;
    env?: Record<string, string>;
    startupScriptPath?: string;
};
export declare function getTerminalEnv(): Record<string, string>;
export declare function agentIdentityEnv(input: {
    workspaceId?: string;
    agentId?: string;
    agentName?: string;
}): Record<string, string>;
export declare function applyAgentIdentityEnv(baseEnv: Record<string, string>, input: {
    workspaceId?: string;
    agentId?: string;
    agentName?: string;
}): Record<string, string>;
export declare function mergeProviderLaunchEnv(base: Record<string, string>, providerEnv: Record<string, string> | undefined): Record<string, string>;
/**
 * What a plain terminal session in this app will actually run, by name:
 * `zsh`, `bash`, `powershell`. Resolved from the same shell the spawn uses, so
 * a surface that names the shell (the spawn picker's terminal row, MC-2122)
 * cannot advertise one and launch another.
 */
export declare function resolveDefaultShellName(): string;
export declare function cleanupTerminalStartupScript(scriptPath: string | undefined): void;
export declare function getShellLaunchConfig(cwd: string, sessionId: string, resume?: boolean, sprintEngineStatePath?: string, cli?: AgentCli, initialPrompt?: string, cliRuntimes?: Partial<Record<AgentCli, Partial<CliRuntimeSettings>>>, cliPermissionPreset?: SprintEngineCliPermissionPreset, cliModel?: string, memoryRootPath?: string, memoryRelativeRoot?: string, managedMcpEnv?: Record<string, string>, debugMode?: boolean, cliAuthToken?: string, cliReasoning?: string, resolvedBinaryPath?: string): ShellLaunchConfig;
export declare function getPlainShellLaunchConfig(cwd: string, sprintEngineStatePath?: string, sessionId?: string): ShellLaunchConfig;
export declare function buildCodexLegacyNativeAgentLaunchPowerShellScript(sessionId: string, resume: boolean, cwd: string, initialPrompt: string | undefined, cliRuntime: CliRuntimeSettings, cliPermissionPreset?: SprintEngineCliPermissionPreset, cliModel?: string, debugMode?: boolean, cliReasoning?: string): string;
