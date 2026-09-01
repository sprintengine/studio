import type { AgentCliAvailabilityMap, AgentSkillWriteInput, AgentSkillWriteResult, BuiltinSkill } from '../shared/electron-api';
import type { PluginRegistryListEntry } from '../shared/plugin-manifest';
export type AgentSkillInstaller = {
    /** Write the skill into every installed, skill-capable harness directory. */
    attach(input: AgentSkillWriteInput): Promise<AgentSkillWriteResult>;
    /** Delete it from the harness directories Multicode wrote it into. */
    remove(input: AgentSkillWriteInput): Promise<AgentSkillWriteResult>;
};
/** What is at one harness's copy of a skill right now. */
export type InstalledSkillCopy = {
    exists: boolean;
    /** Carries a Multicode provenance marker: ours to replace or delete. */
    managed: boolean;
    /** Content identity ignoring the marker; '' when the directory is absent. */
    contentHash: string;
};
export type SkillCopyMarker = {
    kind: 'builtin';
    skill: Pick<BuiltinSkill, 'id' | 'version'>;
    sourceHash: string;
} | {
    kind: 'attached';
    skillId: string;
    copiedFrom: string;
};
/**
 * The filesystem the installer writes through. One implementation ships; the
 * port exists so the per-target outcomes — including a write that fails while
 * its neighbours succeed — are testable without arranging a permission error.
 */
export interface SkillCopyIo {
    inspect(dir: string): Promise<InstalledSkillCopy>;
    write(input: {
        sourceDir: string;
        destinationDir: string;
        marker?: SkillCopyMarker;
    }): Promise<void>;
    remove(dir: string): Promise<void>;
}
export type AgentSkillInstallerOptions = {
    listPlugins?: () => PluginRegistryListEntry[];
    detectAvailability?: () => Promise<AgentCliAvailabilityMap>;
    builtinSourceRoot?: () => string;
    io?: SkillCopyIo;
    /**
     * Freshness: say only *that* a harness changed and let the pane re-read
     * through `agentCapabilities`. Pushing the new list from here would make the
     * write path a second source of truth for the same query, and a surface that
     * renders what it was told can claim an install that failed.
     */
    invalidate?: (workspaceRoot: string, harnessId: string) => void;
};
export declare function createFsSkillCopyIo(): SkillCopyIo;
export declare function createAgentSkillInstaller(options?: AgentSkillInstallerOptions): AgentSkillInstaller;
