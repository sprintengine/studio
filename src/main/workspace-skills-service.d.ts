import type { WorkspaceSkillsListInput, WorkspaceSkillsListResult } from '../shared/electron-api';
import type { CapabilityWatcher } from './capability-watcher';
import type { PluginManifest, PluginRegistryListEntry } from '../shared/plugin-manifest';
import type { McpServerResolver } from './mcp-config-readers/resolve-servers';
import { type AgentCapabilitiesInput, type AgentCapabilitiesResult, type AgentSkillSource } from '../shared/skills';
export type WorkspaceSkillsService = {
    listWorkspaceSkills(input: WorkspaceSkillsListInput): Promise<WorkspaceSkillsListResult>;
};
export declare function createWorkspaceSkillsService(): WorkspaceSkillsService;
/** One skill directory as it exists on disk, before it is attributed to a CLI. */
export type RawSkill = {
    id: string;
    name: string;
    description: string;
    source: AgentSkillSource;
};
export type ReadSkillsResult = {
    ok: true;
    skills: RawSkill[];
} | {
    ok: false;
    reason: 'missing' | 'unreadable';
    message: string;
};
/**
 * Reads a directory of skills. `missing` and `unreadable` are deliberately
 * different answers: a directory the CLI never created is normal, and a
 * permission error is a fault the surface must report rather than render as
 * "no skills".
 */
export interface SkillDirectoryReader {
    read(absoluteDir: string): Promise<ReadSkillsResult>;
}
export type AgentCapabilityService = {
    resolve(input: AgentCapabilitiesInput): Promise<AgentCapabilitiesResult>;
};
export declare function createFsSkillDirectoryReader(): SkillDirectoryReader;
export declare function createAgentCapabilityService(options: {
    reader: SkillDirectoryReader;
    listPlugins: () => PluginRegistryListEntry[];
    /** Manifests, not list entries: `mcpConfig` is not projected to the renderer. */
    lookupManifest: (pluginId: string) => PluginManifest | undefined;
    mcpResolver: McpServerResolver;
    /**
     * The freshness watcher, when one is running. It answers whether this list
     * can be kept true; a workspace it could not watch is stale-but-correct, and
     * the surface must be able to say so rather than present it as live.
     */
    freshness?: Pick<CapabilityWatcher, 'diagnosticsFor'>;
}): AgentCapabilityService;
