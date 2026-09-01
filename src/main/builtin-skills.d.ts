import type { LoadedPlugin } from '../shared/plugin-manifest';
import type { BuiltinSkill, BuiltinSkillInstallResult, BuiltinSkillStatus } from '../shared/electron-api';
export declare const MANAGED_SKILL_MANIFEST_FILE = ".multicode-skill.json";
export type ManagedSkillManifest = {
    id: string;
    source: 'multicode-builtin';
    version: string;
    sourceHash: string;
    installedSkillHash: string;
    installedAt: string;
    updatedAt: string;
};
export declare const BUILTIN_SKILLS: BuiltinSkill[];
type BuiltinSkillManagerOptions = {
    sourceRoot?: string;
    listPlugins?: () => LoadedPlugin[];
};
/**
 * Content identity of a skill directory: every file's path and bytes, in a
 * stable order. Exported because the attach path compares a source against an
 * installed copy with it, and two different hashes of "the same" directory
 * would make an unchanged copy look modified. Pass `MANAGED_SKILL_MANIFEST_FILE`
 * to ignore the marker, which is written after the hash is taken.
 */
export declare function hashSkillDirectory(root: string, ignoredNames?: Set<string>): Promise<string>;
/**
 * Replace `destinationDir` with a copy of `sourceDir`, parents included. The
 * two skill install paths — this manager's policy fan-out and the pane's attach
 * (src/main/agent-skill-installer.ts) — share it so a skill copy is made one
 * way. Whether the destination may be replaced at all is the caller's decision:
 * both refuse to overwrite a directory Multicode did not write.
 */
export declare function copySkillDirectory(sourceDir: string, destinationDir: string): Promise<void>;
/**
 * Stamp a freshly written copy of a bundled skill with the manifest
 * `getTargetState` reads back. Without it the copy is indistinguishable from a
 * hand-made directory, and every later install would refuse to touch it.
 */
export declare function writeManagedSkillManifest(input: {
    destinationDir: string;
    skill: Pick<BuiltinSkill, 'id' | 'version'>;
    sourceHash: string;
    now?: string;
}): Promise<void>;
export declare function findBuiltinSkill(skillId: string): BuiltinSkill | null;
/** Where the skills Multicode ships live, bundled or in the checkout. */
export declare function builtinSkillSourceRoot(): string;
export declare function createBuiltinSkillManager(options?: BuiltinSkillManagerOptions): {
    list: () => Promise<BuiltinSkill[]>;
    getStatus: (workspaceRoot: string | null, skillId: string) => Promise<BuiltinSkillStatus>;
    install: (workspaceRoot: string | null, skillId: string) => Promise<BuiltinSkillInstallResult>;
};
export {};
