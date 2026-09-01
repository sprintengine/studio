import type { ConversationProviderTestResult } from '../../shared/conversation-runtime';
import type { ConversationProviderModel, LoadedConversationProvider } from '../../shared/plugin-manifest';
import type { ConversationProviderAdapter } from './mock-conversation-provider';
export type ProviderSecretResolver = (providerId: string) => Promise<{
    ok: true;
    value: string;
} | {
    ok: false;
    message: string;
}>;
export type OpenAiCompatibleProviderOptions = {
    getProviderById: (providerId: string) => LoadedConversationProvider | undefined;
    resolveSecret: ProviderSecretResolver;
    fetch?: typeof fetch;
};
export declare function createOpenAiCompatibleProvider(options: OpenAiCompatibleProviderOptions): ConversationProviderAdapter;
export declare function testOpenAiCompatibleConnection(input: {
    providerId: string;
    modelId?: string;
    getProviderById: (providerId: string) => LoadedConversationProvider | undefined;
    resolveSecret: ProviderSecretResolver;
    fetch?: typeof fetch;
}): Promise<ConversationProviderTestResult>;
export declare function listOpenAiCompatibleModels(input: {
    providerId: string;
    getProviderById: (providerId: string) => LoadedConversationProvider | undefined;
    resolveSecret: ProviderSecretResolver;
    fetch?: typeof fetch;
}): Promise<{
    ok: true;
    models: ConversationProviderModel[];
} | {
    ok: false;
    message: string;
}>;
