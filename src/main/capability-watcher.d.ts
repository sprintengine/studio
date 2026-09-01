import type { PluginManifest, PluginRegistryListEntry } from '../shared/plugin-manifest';
import type { AgentCapabilitiesInvalidation, CapabilityDiagnostic } from '../shared/skills';
/**
 * The paths one invalidation group covers. A group is a harness (its skills
 * directory plus the MCP configs of every CLI bound to it), or a single CLI
 * that declares an MCP config and no harness.
 */
export type CapabilityWatchGroup = {
    harnessId: string;
    pluginIds: string[];
    /** Absolute; null when the group has no skills directory to read. */
    skillsDir: string | null;
    /** Absolute config files, deduplicated — four CLIs share one `.mcp.json`. */
    configFiles: string[];
};
export type WatchHandle = {
    close(): void;
};
/**
 * Port so tests can count opens and closes, and force a start failure. The
 * default is `fs.watch`; `recursive` is a request, not a guarantee — the
 * implementation falls back to a non-recursive watch where the platform
 * rejects it, exactly as `fs:watch-start` does.
 */
export type WatchDirectory = (target: {
    path: string;
    recursive: boolean;
}, onChange: (filename: string | null) => void) => WatchHandle;
export type CapabilityWatcher = {
    /**
     * Refcounted per workspace: the first subscriber starts the watchers and the
     * last one to unsubscribe tears them down, so a closed pane costs nothing.
     */
    subscribe(workspaceRoot: string, onInvalidate: (event: AgentCapabilitiesInvalidation) => void): () => void;
    /**
     * Freshness faults for one CLI, merged into that CLI's capability result.
     * Empty when nothing is subscribed for that workspace: nothing is watching
     * it, and nothing claims to be.
     */
    diagnosticsFor(workspaceRoot: string, pluginId: string): CapabilityDiagnostic[];
    /**
     * Say a harness changed because Multicode just changed it. Writes made in
     * process do not wait on `fs.watch` to notice them — and on a mount where
     * watching failed, nothing would notice at all. Goes through the same
     * debounce as a filesystem event, so a write and the events it causes are one
     * invalidation rather than two.
     */
    invalidate(workspaceRoot: string, harnessId: string): void;
};
export declare function createFsWatchDirectory(): WatchDirectory;
export declare function createCapabilityWatcher(options: {
    listPlugins: () => PluginRegistryListEntry[];
    lookupManifest: (pluginId: string) => PluginManifest | undefined;
    watchDirectory?: WatchDirectory;
    /** Focus signal for the degraded fallback; returns its own unsubscribe. */
    onWorkspaceFocus?: (listener: () => void) => () => void;
    homeDir?: () => string;
    /** Whether a watched path is still there; the port exists for the same reason `watchDirectory` does. */
    pathExists?: (path: string) => boolean;
    debounceMs?: number;
    maxWorkspaces?: number;
    log?: (message: string) => void;
}): CapabilityWatcher;
/**
 * The paths to watch for one workspace, derived from the same harness map and
 * the same manifests the resolver reads — never a hardcoded list, so a
 * thirteenth CLI is watched with no edit here.
 */
export declare function capabilityWatchGroups(input: {
    plugins: readonly PluginRegistryListEntry[];
    lookupManifest: (pluginId: string) => PluginManifest | undefined;
    workspaceRoot: string;
    homeDir: () => string;
}): CapabilityWatchGroup[];
