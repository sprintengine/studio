import { type ScannedSkill, type SkillFileRef, type SkillHarness } from '../../shared/skills';
/** Reads one file's bytes from whichever source the skill came from. */
export type SkillFileReader = (file: SkillFileRef) => Promise<Buffer>;
export declare const DEFAULT_SKILL_INSTALL_MAX_FILES = 1000;
export declare const DEFAULT_SKILL_INSTALL_MAX_TOTAL_BYTES: number;
/**
 * The provenance marker, written into each installed copy and never into the
 * source it was read from — so it cannot appear in the file list the skill
 * reader renders.
 *
 * Same filename as the manifest src/main/builtin-skills.ts writes for the
 * skills the app ships, deliberately: one convention for "Multicode put this
 * here", not two. The shapes differ and each reader recognises only its own —
 * a bundled skill's manifest names no `sourceId`, so no sync claims it, and a
 * source's marker fails the built-in reader's `source: 'multicode-builtin'`
 * check, so the built-in installer treats that directory as local and refuses
 * to overwrite it.
 */
export declare const SKILL_PROVENANCE_FILE = ".multicode-skill.json";
/** Which source an installed copy was taken from, and at which commit. */
export type SkillInstallProvenance = {
    sourceId: string;
    skillId: string;
    /** '' for sources with no git identity. */
    commitSha: string;
};
/** Provenance for a copy that came from a plugin bundle, not from a skill source. */
export declare const PLUGIN_BUNDLE_SKILL_SOURCE_ID = "plugin-bundle";
/**
 * What installed the copy in `skillDir`, or null when nothing did — a bundled
 * skill, a hand-made directory, or a copy installed before markers existed.
 * Absent means "not ours", which is the reading that never overwrites someone
 * else's bytes.
 */
export declare function readSkillProvenance(skillDir: string): Promise<SkillInstallProvenance | null>;
export type SkillInstallTarget = {
    harness: SkillHarness;
    path: string;
};
export type SkillInstallPlan = {
    dirName: string;
    targets: SkillInstallTarget[];
    files: SkillFileRef[];
};
export type SkillInstallPlanResult = {
    ok: true;
    plan: SkillInstallPlan;
} | {
    ok: false;
    message: string;
};
export type SkillInstallResult = {
    ok: true;
    dirName: string;
    harnesses: SkillHarness[];
    paths: string[];
    fileCount: number;
} | {
    ok: false;
    message: string;
};
/**
 * Resolve every destination up front and refuse the whole install if any of
 * them escapes its skill directory. Skills are third-party content: a tree
 * entry named `../../.claude/settings.json` is not a file to sanitise and carry
 * on with, it is a source to stop reading.
 */
export declare function planSkillInstall(workspaceRoot: string, skill: ScannedSkill, harnesses: readonly SkillHarness[]): SkillInstallPlanResult;
/**
 * The absolute destination for a skill-relative path, or null when it does not
 * stay inside the skill directory. Backslashes are rejected outright rather
 * than normalised: a repository path is POSIX, so a backslash is either a
 * literal filename character (which cannot survive a Windows install anyway) or
 * an attempt to smuggle a separator past a POSIX-shaped check.
 */
export declare function resolveSkillFilePath(targetDir: string, relativePath: string): string | null;
export type InstallSkillOptions = {
    workspaceRoot: string;
    skill: ScannedSkill;
    harnesses: readonly SkillHarness[];
    readFile: SkillFileReader;
    /** Recorded in the installed copy; what a later sync checks before overwriting it. */
    provenance: SkillInstallProvenance;
    stagingRoot?: string;
    maxTotalBytes?: number;
};
/**
 * Stage the whole skill once, then copy the staged directory into each harness
 * target. Staging keeps a failed download from leaving a half-written skill
 * where an agent would read it, and keeps one install to one fetch per file no
 * matter how many harnesses are on this machine.
 */
export declare function installSkill(options: InstallSkillOptions): Promise<SkillInstallResult>;
/**
 * Install a skill that is already a directory on this machine — a plugin
 * bundle's skill component. It goes through the same plan/stage/copy path as a
 * repository skill so a bundle cannot reach outside its own directory either;
 * only where the bytes are read from differs.
 */
export declare function installSkillDirectory(options: {
    workspaceRoot: string;
    sourceDir: string;
    dirName: string;
    harnesses: readonly SkillHarness[];
}): Promise<SkillInstallResult>;
export type SkillUninstallResult = {
    ok: true;
    dirName: string;
    removedPaths: string[];
} | {
    ok: false;
    message: string;
};
/**
 * Take an installed skill back out of a workspace. Removal is by directory
 * name across every harness that could hold a copy, because that is how the
 * install wrote it — and a copy left behind in one harness dir is a skill the
 * user believes they removed and an agent still reads.
 *
 * The whole directory goes, provenance marker included: a marker outliving its
 * skill would claim a source still owns a directory that is no longer there.
 *
 * Removing nothing is not a failure here: `removedPaths` says what went, and
 * each caller decides what an empty sweep means to it. A plugin uninstall wants
 * "already gone" to be success; a user pressing Remove on a row wants to be
 * told the row was stale.
 */
export declare function uninstallSkill(options: {
    workspaceRoot: string;
    dirName: string;
    harnesses: readonly SkillHarness[];
}): Promise<SkillUninstallResult>;
/** Absolute path a skill occupies for one harness, for status and removal. */
export declare function skillInstallPath(workspaceRoot: string, harness: SkillHarness, dirName: string): string;
