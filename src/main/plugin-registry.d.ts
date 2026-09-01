import type { ConversationProviderListEntry, LoadedConversationProvider, LoadedPlugin, PluginManifest, PluginManifestValidationIssue, PluginManifestValidationResult, PluginRegistryListEntry } from '../shared/plugin-manifest';
import { type ModuleTrustContext } from './modules/module-signature';
export type PluginRegistryOptions = {
    bundledRoot: string;
    userRoot?: string;
    providerTrustContext?: ModuleTrustContext;
    productionMode?: boolean;
    allowUnsignedExecutableAdapters?: boolean;
};
export type PluginRegistry = {
    load: () => Promise<PluginRegistryLoadReport>;
    loadSync: () => PluginRegistryLoadReport;
    list: () => PluginRegistryListEntry[];
    listConversationProviders: () => ConversationProviderListEntry[];
    loaded: () => LoadedPlugin[];
    loadedConversationProviders: () => LoadedConversationProvider[];
    get: (id: string) => LoadedPlugin | undefined;
    getConversationProvider: (id: string) => LoadedConversationProvider | undefined;
    validateManifestSource: (source: string) => PluginManifestValidationResult;
};
export type PluginRegistryLoadReport = {
    loaded: LoadedPlugin[];
    loadedConversationProviders: LoadedConversationProvider[];
    rejected: Array<{
        source: 'bundled' | 'user';
        manifestPath: string;
        issues: PluginManifestValidationIssue[];
    }>;
};
export declare function defaultUserPluginRoot(): string;
export declare function createPluginRegistry(options: PluginRegistryOptions): PluginRegistry;
export declare function validateManifestSource(source: string): PluginManifestValidationResult;
export declare function manifestToListEntry(plugin: LoadedPlugin): PluginRegistryListEntry;
export declare function providerManifestToListEntry(provider: LoadedConversationProvider): ConversationProviderListEntry;
export type { PluginManifest, LoadedPlugin, LoadedConversationProvider };
