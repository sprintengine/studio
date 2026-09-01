// Sync: the scan that added a source, pointed at a source that already exists.
//
// Two things happen and neither is a merge. The cached scan is replaced by a
// fresh one taken at the repository's current head, and every skill from that
// source the workspace already holds is copied again from it. Installing is a
// file copy, so updating is the same file copy — there are no hunks to choose,
// which is why nothing here computes a diff and nothing above it renders one.
//
// The re-copy is deliberately blind *within* a source: a skill edited in place
// is overwritten. That trade is recorded in
// backlog/2026-07-28-skill-source-sync.md, with the cheap fix (compare each
// file's blob SHA before writing) named there for the day it bites. It does not
// extend across sources — what a sync may overwrite is what that same source
// installed, proven by the provenance marker install writes.
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { SKILL_HARNESS_DIR, SKILL_PACK_HARNESSES } from '../../shared/skill-harnesses';
import { skillDirName } from '../../shared/skills';
import { installSkill, readSkillProvenance } from './install';
/**
 * What the refreshed scan holds that the cached one did not, and what it has
 * stopped holding. Skill ids only: this is the whole of what a sync can say
 * about a source without inventing prose about someone else's commits.
 */
export function diffScannedSkills(previous, next) {
    const before = new Set((previous?.skills ?? []).map((skill) => skill.id));
    const after = new Set(next.skills.map((skill) => skill.id));
    return {
        added: next.skills.filter((skill) => !before.has(skill.id)).map((skill) => skill.id),
        removed: (previous?.skills ?? []).filter((skill) => !after.has(skill.id)).map((skill) => skill.id),
    };
}
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
export async function installedSkillCopies(workspaceRoot) {
    const byDirName = new Map();
    for (const harness of SKILL_PACK_HARNESSES) {
        const skillsDir = join(workspaceRoot, SKILL_HARNESS_DIR[harness], 'skills');
        const entries = await readdir(skillsDir, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
            if (!entry.isDirectory())
                continue;
            const provenance = await readSkillProvenance(join(skillsDir, entry.name));
            if (!provenance)
                continue;
            const copy = { harness, sourceId: provenance.sourceId };
            const copies = byDirName.get(entry.name);
            if (copies)
                copies.push(copy);
            else
                byDirName.set(entry.name, [copy]);
        }
    }
    return byDirName;
}
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
export async function refreshInstalledSkills(options) {
    const refreshed = [];
    const failures = [];
    for (const skill of options.scan.skills) {
        const copies = options.installedCopies.get(skillDirName(skill.id)) ?? [];
        const harnesses = copies
            .filter((copy) => copy.sourceId === options.sourceId)
            .map((copy) => copy.harness);
        if (harnesses.length === 0)
            continue;
        // Sequential on purpose: each copy fetches every file of its skill, and a
        // fan-out of those reads is what a rate limit is for.
        const result = await installSkill({
            workspaceRoot: options.workspaceRoot,
            skill,
            harnesses,
            readFile: (file) => options.readFile(skill, file),
            provenance: { sourceId: options.sourceId, skillId: skill.id, commitSha: options.scan.commitSha },
        }).catch((error) => ({
            ok: false,
            message: error instanceof Error ? error.message : String(error),
        }));
        if (result.ok)
            refreshed.push(skill.id);
        else
            failures.push({ skillId: skill.id, message: result.message });
    }
    return { refreshed, failures };
}
