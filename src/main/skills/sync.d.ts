import type { SkillHarness } from '../../shared/electron-api';
import { type ScanResult, type ScannedSkill, type SkillFileRef } from '../../shared/skills';
export type SkillSyncChanges = {
    added: string[];
    removed: string[];
};
/**
 * What the refreshed scan holds that the cached one did not, and what it has
 * stopped holding. Skill ids only: this is the whole of what a sync can say
 * about a source without inventing prose about someone else's commits.
 */
export declare function diffScannedSkills(previous: ScanResult | null, next: ScanResult): SkillSyncChanges;
/** One installed skill directory, and the source whose install wrote it. */
export type InstalledSkillCopy = {
    harness: SkillHarness;
    sourceId: string;
};
/**
 * The installed copies this app can account for, keyed by the directory name an
 * install writes.
 *
 * Read across every harness directory rather than the CLIs detected on this
 * machine: a skill copied into `.claude/skills` is installed whether or not
 * that CLI answers `which` today, and a sync that quietly stopped refreshing it
 * would leave the workspace on bytes nobody chose. Copying back into exactly
 * the directories that hold it also means a sync never creates a copy the user
 * never installed.
 *
 * A directory carrying no provenance marker — a bundled skill, one made by
 * hand, a copy installed before markers existed — is left out entirely. Nothing
 * says which source it came from, so nothing may overwrite it; installing it
 * from a source is what claims it, and that writes the marker.
 */
export declare function installedSkillCopies(workspaceRoot: string): Promise<Map<string, InstalledSkillCopy[]>>;
export type SkillSyncCopyFailure = {
    skillId: string;
    message: string;
};
export type SkillSyncCopyResult = {
    refreshed: string[];
    failures: SkillSyncCopyFailure[];
};
/**
 * Re-copy the skills this workspace already holds *from this source*, out of
 * the refreshed scan.
 *
 * Only skills the new scan still lists are copied. One that disappeared
 * upstream keeps the copy it already has — dropping out of the source's list is
 * not a reason to take a working skill away from the agents reading it.
 *
 * A matching directory name is not enough to be copied over: the copy on disk
 * must name this source. Two repositories shipping a `prototype` skill is
 * ordinary, and the one the user installed is the one that gets updated. A copy
 * belonging to another source, or to nothing, is left alone and left out of
 * `refreshed` — sync only reports what it actually wrote.
 */
export declare function refreshInstalledSkills(options: {
    workspaceRoot: string;
    sourceId: string;
    scan: ScanResult;
    installedCopies: ReadonlyMap<string, InstalledSkillCopy[]>;
    readFile: (skill: ScannedSkill, file: SkillFileRef) => Promise<Buffer>;
}): Promise<SkillSyncCopyResult>;
