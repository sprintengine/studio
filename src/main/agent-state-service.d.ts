import type { PluginAgentStateSpec } from '../shared/plugin-manifest';
import type { AgentStateFrame } from './agent-state';
export type AgentStateServiceOptions = {
    resolveUserDataDir: () => string;
    resolveAgentStateSpec: (cli: string) => PluginAgentStateSpec | null;
    resolveReporterScriptPath: () => string | null;
    resolveReporterTemplatePath: (template: string) => string | null;
    resolveHomeDir?: () => string;
    onFrame: (frame: AgentStateFrame) => void;
    logDiagnostic?: (diagnostic: {
        level: 'warning';
        title: string;
        message: string;
        details?: string;
    }) => void;
    now?: () => number;
};
export type AgentStateService = ReturnType<typeof createAgentStateService>;
export declare function createAgentStateService(options: AgentStateServiceOptions): {
    initialize: () => Promise<void>;
    shutdown: () => Promise<void>;
    getSocketPath: () => string;
    installForWorkspace: (workspaceRoot: string, cli: string) => Promise<void>;
    isRunning: () => boolean;
};
export declare function resolveAgentStateSocketPath(userDataDir: string): string;
