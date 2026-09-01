import type { ConversationCliRuntimeOverrides, ConversationEvent, ConversationImageAttachment, ConversationPermissionPreset } from '../../shared/conversation-runtime';
export type ConversationProviderEventStream = ConversationEvent[] | AsyncIterable<ConversationEvent> | Promise<ConversationEvent[] | AsyncIterable<ConversationEvent>>;
export type ConversationProviderLiveSession = {
    sessionId: string;
    workspaceId: string;
    agentId: string;
    workspaceRoot: string;
    providerSessionId: string | null;
    hasChildProcess: boolean;
    childPid: number | null;
    turnActive: boolean;
    pendingApproval: boolean;
    lastActivityAt: number;
    spawnedAt: number | null;
};
export type ConversationProviderAdapter = {
    id: string;
    listModels(): string[];
    sessions?: 'stateless' | 'stateful';
    startSession(input: MockAdapterSessionInput): ConversationProviderEventStream;
    sendTurn(input: MockAdapterTurnInput): ConversationProviderEventStream;
    resolveApproval(input: MockAdapterApprovalInput): ConversationProviderEventStream;
    interrupt(input: MockAdapterSessionInput): ConversationProviderEventStream;
    stopSession(input: MockAdapterSessionInput): ConversationProviderEventStream;
    setPermissionPreset?(input: MockAdapterPermissionInput): Promise<ConversationProviderPermissionResult>;
    listLiveSessions?(): ConversationProviderLiveSession[];
    disposeChildProcess?(sessionId: string): boolean;
    disposeAll?(): void;
};
export type MockAdapterSessionInput = {
    sessionId: string;
    workspaceId: string;
    agentId: string;
    providerId: string;
    modelId: string;
    workspaceRoot?: string;
    resumeSessionId?: string;
    cliRuntimes?: ConversationCliRuntimeOverrides;
    permissionPreset?: ConversationPermissionPreset;
    allowedTools?: string[];
    onSessionEvent?: ConversationSessionEventSink;
};
export type ConversationSessionEventSink = (event: ConversationEvent) => void;
export type ConversationMessage = {
    role: 'system' | 'user' | 'assistant';
    content: string;
    attachments?: ConversationImageAttachment[];
};
export type MockAdapterTurnInput = MockAdapterSessionInput & {
    turnId: string;
    requestId: string;
    message: string;
    attachments?: ConversationImageAttachment[];
    messages?: ConversationMessage[];
    signal?: AbortSignal;
};
export type MockAdapterPermissionInput = MockAdapterSessionInput & {
    permissionPreset: ConversationPermissionPreset;
};
export type ConversationProviderPermissionResult = {
    ok: true;
    notice?: string;
} | {
    ok: false;
    message: string;
};
export type MockAdapterApprovalInput = MockAdapterSessionInput & {
    turnId: string;
    requestId: string;
    approved: boolean;
    answers?: Record<string, string>;
};
export declare function createMockConversationProvider(): ConversationProviderAdapter;
