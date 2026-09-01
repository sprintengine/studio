import type { PluginManifest, PluginRenderContext, PluginRenderedCommand } from '../shared/plugin-manifest';
export declare function renderPluginLaunch(manifest: PluginManifest, context: PluginRenderContext): PluginRenderedCommand;
export declare function renderPluginResume(manifest: PluginManifest, context: PluginRenderContext): PluginRenderedCommand | null;
export declare function renderReasoningArgs(manifest: PluginManifest, reasoning: string | undefined, scope?: Map<string, string | string[] | undefined>): string[];
