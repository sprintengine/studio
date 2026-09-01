import type { ConversationEvent, ConversationInterruptInput, ConversationListSessionsInput, ConversationListSessionsResult, ConversationRespondToRequestInput, ConversationSendTurnInput, ConversationSessionActionResult, ConversationSessionStatus, ConversationStartSessionInput, ConversationStartSessionResult, ConversationStopSessionInput } from '../shared/conversation-runtime';
export type CompanionConversationRuntime = {
    startSession(input: ConversationStartSessionInput): Promise<ConversationStartSessionResult>;
    sendTurn(input: ConversationSendTurnInput): Promise<ConversationSessionActionResult>;
    respondToRequest(input: ConversationRespondToRequestInput): Promise<ConversationSessionActionResult>;
    interrupt(input: ConversationInterruptInput): Promise<ConversationSessionActionResult>;
    stopSession(input: ConversationStopSessionInput): Promise<ConversationSessionActionResult>;
    listSessions(input?: ConversationListSessionsInput): ConversationListSessionsResult;
    onEvent(listener: (event: ConversationEvent) => void): () => void;
};
export type CompanionAgentStatus = ConversationSessionStatus | 'absent';
export type CompanionAgentSpec = {
    workspaceId: string;
    /** Stable, module-chosen id (e.g. 'review-guide'); the projection key. */
    agentId: string;
    /** Display name in the Sessions popover / Attention Queue. */
    name: string;
    /**
     * Absolute workspace folder. The main process has no workspaceId → folder
     * registry (workspaceRoot is caller-supplied everywhere conversation sessions
     * are started), so the caller provides it here, exactly as
     * ConversationStartSessionInput requires.
     */
    workspaceRoot: string;
    /** Engine selection; resolves to a provider/model pair (defaults claude-agent/sonnet). */
    engine?: {
        cli?: string;
        model?: string;
    };
    /** Advisory context roots. The provider already resolves knowledge from workspaceRoot. */
    contextRoots?: {
        knowledge?: boolean;
    };
    /** Role instructions, delivered as a preamble on the first turn. */
    systemPrompt: string;
};
export type CompanionValidateResult<T> = {
    ok: true;
    value: T;
} | {
    ok: false;
    errors: string[];
};
export type CompanionRunStructuredOptions<T> = {
    prompt: string;
    validate: (raw: unknown) => CompanionValidateResult<T>;
    /** Validator errors are fed back to the agent and the turn retried. Default 1. */
    retries?: number;
    onPhase?: (phase: string) => void;
};
export type Unsubscribe = () => void;
export type CompanionAgentHandle = {
    readonly workspaceId: string;
    readonly agentId: string;
    status(): CompanionAgentStatus;
    onStatus(cb: (status: CompanionAgentStatus) => void): Unsubscribe;
    runStructured<T>(opts: CompanionRunStructuredOptions<T>): Promise<T>;
    send(message: string): Promise<void>;
    onEvent(cb: (event: ConversationEvent) => void): Unsubscribe;
    interrupt(): void;
    dispose(): void;
};
export type CompanionAgentService = {
    attach(spec: CompanionAgentSpec): CompanionAgentHandle;
    /** Unsubscribe from the runtime event stream. App-level teardown only. */
    dispose(): void;
};
export declare class CompanionValidationError extends Error {
    readonly errors: string[];
    constructor(errors: string[]);
}
export declare class CompanionTurnError extends Error {
    constructor(message: string);
}
export type CreateCompanionAgentServiceOptions = {
    runtime: CompanionConversationRuntime;
    /** Maps an engine spec to a provider/model pair. Default: claude-agent / sonnet. */
    resolveEngineDefaults?: (engine?: CompanionAgentSpec['engine']) => {
        providerId: string;
        modelId: string;
    };
};
export declare function createCompanionAgentService(options: CreateCompanionAgentServiceOptions): CompanionAgentService;
export type CompanionAgentsModuleRegistry = {
    attach(moduleId: string, spec: CompanionAgentSpec): CompanionAgentHandle;
};
export declare function createCompanionAgentsModuleRegistry(input: {
    service: CompanionAgentService;
    /** The permissions the module declared in its manifest (disclosure list). */
    getModulePermissions: (moduleId: string) => readonly string[] | undefined;
}): CompanionAgentsModuleRegistry;
export declare function extractJson(text: string): unknown | undefined;
export declare function redactEvent(event: ConversationEvent): ConversationEvent;
