import type { AgentCli, CliRuntimeSettings, ColorScheme, SprintEngineCliPermissionPreset } from '../shared/electron-api';
import type { LoadedPlugin } from '../shared/plugin-manifest';
export declare function pluginIdForCli(cli: AgentCli): string;
export declare function resolveDebugSkillInvocation(plugin: LoadedPlugin): string | undefined;
export declare function resolveCliRuntimeSettings(cli: AgentCli, cliRuntimes?: Partial<Record<AgentCli, Partial<CliRuntimeSettings>>>): CliRuntimeSettings;
export type AgentLaunchRenderInput = {
    cli: AgentCli;
    sessionId: string;
    resume?: boolean;
    initialPrompt?: string;
    cliRuntime?: CliRuntimeSettings;
    cliPermissionPreset?: SprintEngineCliPermissionPreset;
    cliModel?: string;
    cliReasoning?: string;
    debugMode?: boolean;
    colorScheme?: ColorScheme;
    secretToken?: string;
    resolvedBinaryPath?: string;
};
export type RenderedAgentLaunch = {
    argv: string[];
    binary: string;
    plugin: LoadedPlugin;
    env: Record<string, string>;
};
export declare class AgentLaunchRenderError extends Error {
}
export declare function renderAgentLaunchArgv(input: AgentLaunchRenderInput): RenderedAgentLaunch;
export declare function cliCredentialLaunchBlock(input: {
    displayName: string;
    auth?: {
        label: string;
    };
    secretConfigured: boolean;
}): {
    message: string;
} | null;
export declare function renderCliLaunchEnv(input: AgentLaunchRenderInput): Record<string, string>;
export declare function quotePosixToken(value: string): string;
export declare function quotePosixForced(value: string): string;
export declare function argvToPosixShellCommand(argv: string[]): string;
/**
 * The invocation a spawn WOULD make, rendered for display before it happens
 * (MC-2147: the new-agent tab's receipt line).
 *
 * It goes through `renderAgentLaunchArgv` — the same call the spawn makes — for
 * the reason the surface exists: a hand-written preview of `--permission-mode`
 * flags is a promise the launch path is free to break, and the first flag that
 * moved would turn the receipt into a lie. Sharing the renderer means a manifest
 * change reaches the preview and the spawn in one step.
 *
 * The prompt is deliberately NOT rendered: it is visible in the composer a line
 * above, it would re-render the preview on every keystroke, and on the CLIs that
 * pass it as argv it would bury the flags the line exists to show. `binary` is
 * the resolved command; callers show it plus `args`.
 *
 * `debugMode` is absent from the input for the same reason, and it is the
 * orthogonality invariant showing through: debug mode prepends a directive to
 * the PROMPT and never touches a flag, so on a prompt-free preview it has
 * nothing to say — and rendering it anyway would print a multi-line directive
 * into a one-line receipt. The row's own Debug chip carries that state.
 */
export declare function renderAgentLaunchPreview(input: Omit<AgentLaunchRenderInput, 'sessionId' | 'resume' | 'initialPrompt' | 'debugMode'>): {
    binary: string;
    args: string[];
    display: string;
};
export declare function buildAgentShellCommand(input: AgentLaunchRenderInput): string;
