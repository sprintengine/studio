import type { ConversationProviderListEntry, LoadedConversationProvider, LoadedPlugin, PluginManifest, PluginRegistryListEntry } from '../shared/plugin-manifest';
import { type PluginRegistry, type PluginRegistryOptions, type PluginRegistryLoadReport } from './plugin-registry';
export declare function resolveBundledPluginRoot(): string;
export declare function createAppPluginRegistryOptions(userDataDir: string, bundledRoot?: string, userRoot?: string): PluginRegistryOptions;
export declare function getPluginRegistry(): PluginRegistry;
/**
 * Re-scan the bundled and user plugin roots so a plugin installed (or removed)
 * while the app is running is reflected without a restart. Used by the
 * `plugins:install-folder` / `plugins:reload` IPC after a drop-in change.
 */
export declare function reloadPluginRegistry(): PluginRegistryLoadReport;
export declare function getPluginById(id: string): LoadedPlugin | undefined;
export declare function getPluginManifest(id: string): PluginManifest | undefined;
export declare function listPluginRegistryEntries(): PluginRegistryListEntry[];
export declare function listConversationProviderRegistryEntries(): ConversationProviderListEntry[];
export declare function getConversationProviderById(id: string): LoadedConversationProvider | undefined;
export declare function getLastPluginRegistryReport(): PluginRegistryLoadReport | null;
export declare function getPluginRegistryUserRoot(): string;
export type PluginSprintEngineRegistryRoot = {
    id: string;
    root: string;
};
export declare function getPluginSprintEngineRegistryRoots(): PluginSprintEngineRegistryRoot[];
export declare function __setPluginRegistryForTest(custom: PluginRegistry, report: PluginRegistryLoadReport, userRoot?: string): void;
export declare function __resetPluginRegistryForTest(): void;
