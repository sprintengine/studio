import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ConversationCliRuntimeOverrides, ConversationEvent, ConversationImageAttachment } from '../../shared/conversation-runtime';
import type { ConversationProviderAdapter, ConversationProviderLiveSession, ConversationProviderPermissionResult, MockAdapterPermissionInput } from './mock-conversation-provider';
export declare const CLAUDE_AGENT_PROVIDER_ID = "claude-agent";
export declare const CLAUDE_AGENT_MODELS: readonly ["claude-opus-5", "sonnet", "opus", "haiku"];
export declare const CLAUDE_AGENT_SESSION_ENV_KEY = "MULTICODE_CONVERSATION_SESSION_ID";
type SdkQueryFunction = typeof import('@anthropic-ai/claude-agent-sdk').query;
export type ClaudeAgentProviderOptions = {
    loadQuery?: () => Promise<SdkQueryFunction>;
    resolveExecutable?: (cliRuntimes?: ConversationCliRuntimeOverrides) => Promise<string>;
    buildEnv?: (input: {
        workspaceId: string;
        agentId: string;
        sessionId: string;
    }) => Record<string, string> | Promise<Record<string, string>>;
    now?: () => number;
};
export type ClaudeAgentProviderAdapter = ConversationProviderAdapter & {
    listLiveSessions(): ConversationProviderLiveSession[];
    disposeChildProcess(sessionId: string): boolean;
    disposeAll(): void;
    setPermissionPreset(input: MockAdapterPermissionInput): Promise<ConversationProviderPermissionResult>;
};
export declare function createClaudeAgentProvider(options?: ClaudeAgentProviderOptions): ClaudeAgentProviderAdapter;
export declare function buildUserMessageContent(message: string, attachments: ConversationImageAttachment[] | undefined): SDKUserMessage['message']['content'];
export declare const STRIPPED_ANTHROPIC_AUTH_ENV_KEYS: readonly ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"];
export declare function stripAnthropicAuthEnv(env: Record<string, string>): Record<string, string>;
export declare function mapSdkMessage(state: {
    sessionId: string;
    workspaceId: string;
    agentId: string;
    providerId: string;
    modelId: string;
    providerSessionId: string | null;
    turn: {
        turnId: string;
    } | null;
}, message: Record<string, unknown>): ConversationEvent[];
export declare function computeEditDiffCounts(tool: string, input: Record<string, unknown>): {
    addedLines: number;
    removedLines?: number;
} | null;
export declare function summarizeToolInput(tool: string, input: Record<string, unknown>): string;
export {};
