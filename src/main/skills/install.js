// Installing a skill: copy the whole skill directory into the harness skill
// directories under the active workspace root, preserving subdirectory shape,
// so `agents/`, `scripts/` and `reference/` land the way the skill expects to
// find them.
//
// Where skills go is unchanged from before sources existed — the harness dirs
// resolved by src/shared/skill-harnesses.ts. What changed is *what* is copied:
// the whole directory, not the entry document alone.
//
// Every copy carries a provenance marker naming the source that wrote it. Sync
// reads it to decide what it may overwrite; without it, two sources shipping a
// directory of the same name are indistinguishable on disk.
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { SKILL_HARNESS_DIR } from '../../shared/skill-harnesses';
import { SKILL_ENTRY_FILE, skillDirName, } from '../../shared/skills';
import { listLocalTree } from './local-source';
export const DEFAULT_SKILL_INSTALL_MAX_FILES = 1_000;
export const DEFAULT_SKILL_INSTALL_MAX_TOTAL_BYTES = 50 * 1024 * 1024;
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
export const SKILL_PROVENANCE_FILE = '.multicode-skill.json';
/** Provenance for a copy that came from a plugin bundle, not from a skill source. */
export const PLUGIN_BUNDLE_SKILL_SOURCE_ID = 'plugin-bundle';
/**
 * What installed the copy in `skillDir`, or null when nothing did — a bundled
 * skill, a hand-made directory, or a copy installed before markers existed.
 * Absent means "not ours", which is the reading that never overwrites someone
 * else's bytes.
 */
export async function readSkillProvenance(skillDir) {
    const raw = await readFile(join(skillDir, SKILL_PROVENANCE_FILE), 'utf8').catch(() => null);
    if (raw === null)
        return null;
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return null;
    }
    if (typeof parsed !== 'object' || parsed === null)
        return null;
    const record = parsed;
    if (typeof record.sourceId !== 'string' || record.sourceId === '')
        return null;
    return {
        sourceId: record.sourceId,
        skillId: typeof record.skillId === 'string' ? record.skillId : '',
        commitSha: typeof record.commitSha === 'string' ? record.commitSha : '',
    };
}
/**
 * Resolve every destination up front and refuse the whole install if any of
 * them escapes its skill directory. Skills are third-party content: a tree
 * entry named `../../.claude/settings.json` is not a file to sanitise and carry
 * on with, it is a source to stop reading.
 */
export function planSkillInstall(workspaceRoot, skill, harnesses) {
    const root = resolve(workspaceRoot);
    const dirName = skillDirName(skill.id);
    if (dirName.length === 0 || !isSafeSegment(dirName)) {
        return { ok: false, message: `Skill "${skill.id}" does not have a usable directory name.` };
    }
    if (harnesses.length === 0) {
        return { ok: false, message: 'No agent CLI on this machine reads workspace skills.' };
    }
    if (skill.files.length === 0) {
        return { ok: false, message: `Skill "${skill.id}" lists no files to install.` };
    }
    if (skill.files.length > DEFAULT_SKILL_INSTALL_MAX_FILES) {
        return {
            ok: false,
            message: `Skill "${skill.id}" contains more than ${DEFAULT_SKILL_INSTALL_MAX_FILES} files.`,
        };
    }
    const targets = [];
    for (const harness of harnesses) {
        const path = resolve(root, SKILL_HARNESS_DIR[harness], 'skills', dirName);
        if (!isInside(root, path)) {
            return { ok: false, message: `Skill "${skill.id}" resolves outside the workspace.` };
        }
        targets.push({ harness, path });
    }
    for (const file of skill.files) {
        // Checked against the first target only because every target shares the
        // same skill-relative layout; a path that stays inside one stays inside all.
        const escape = resolveSkillFilePath(targets[0].path, file.path);
        if (escape === null) {
            return {
                ok: false,
                message: `Skill "${skill.id}" contains a file path that escapes its own directory: ${file.path}`,
            };
        }
    }
    return { ok: true, plan: { dirName, targets, files: [...skill.files] } };
}
/**
 * The absolute destination for a skill-relative path, or null when it does not
 * stay inside the skill directory. Backslashes are rejected outright rather
 * than normalised: a repository path is POSIX, so a backslash is either a
 * literal filename character (which cannot survive a Windows install anyway) or
 * an attempt to smuggle a separator past a POSIX-shaped check.
 */
export function resolveSkillFilePath(targetDir, relativePath) {
    if (relativePath.length === 0)
        return null;
    if (relativePath.includes('\\') || relativePath.includes('\0'))
        return null;
    if (isAbsolute(relativePath) || relativePath.startsWith('/'))
        return null;
    const segments = relativePath.split('/');
    if (segments.some((segment) => !isSafeSegment(segment)))
        return null;
    const destination = resolve(targetDir, relativePath);
    return isInside(targetDir, destination) ? destination : null;
}
function isSafeSegment(segment) {
    return segment.length > 0 && segment !== '.' && segment !== '..' && !segment.includes('\\');
}
function isInside(parent, child) {
    const rel = relative(parent, child);
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}
/**
 * Stage the whole skill once, then copy the staged directory into each harness
 * target. Staging keeps a failed download from leaving a half-written skill
 * where an agent would read it, and keeps one install to one fetch per file no
 * matter how many harnesses are on this machine.
 */
export async function installSkill(options) {
    const planned = planSkillInstall(options.workspaceRoot, options.skill, options.harnesses);
    if (!planned.ok)
        return planned;
    const { plan } = planned;
    const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_SKILL_INSTALL_MAX_TOTAL_BYTES;
    const stagingRoot = options.stagingRoot ?? join(tmpdir(), 'multicode-skill-install');
    let stage = null;
    try {
        await mkdir(stagingRoot, { recursive: true });
        stage = await mkdtemp(join(stagingRoot, `${plan.dirName}-`));
        let total = 0;
        for (const file of plan.files) {
            const destination = resolveSkillFilePath(stage, file.path);
            if (destination === null) {
                return {
                    ok: false,
                    message: `Skill "${options.skill.id}" contains a file path that escapes its own directory: ${file.path}`,
                };
            }
            const bytes = await options.readFile(file);
            total += bytes.byteLength;
            if (total > maxTotalBytes) {
                return {
                    ok: false,
                    message: `Skill "${options.skill.id}" is larger than ${maxTotalBytes} bytes.`,
                };
            }
            await mkdir(dirname(destination), { recursive: true });
            await writeFile(destination, bytes);
        }
        // Written last, so a source shipping a file of this name cannot forge the
        // provenance of its own copy.
        const record = {
            ...options.provenance,
            installedAt: new Date().toISOString(),
        };
        await writeFile(join(stage, SKILL_PROVENANCE_FILE), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
        for (const target of plan.targets) {
            await rm(target.path, { recursive: true, force: true });
            await mkdir(dirname(target.path), { recursive: true });
            await cp(stage, target.path, { recursive: true });
        }
        return {
            ok: true,
            dirName: plan.dirName,
            harnesses: plan.targets.map((target) => target.harness),
            paths: plan.targets.map((target) => target.path),
            fileCount: plan.files.length,
        };
    }
    catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
    finally {
        if (stage)
            await rm(stage, { recursive: true, force: true }).catch(() => undefined);
    }
}
/**
 * Install a skill that is already a directory on this machine — a plugin
 * bundle's skill component. It goes through the same plan/stage/copy path as a
 * repository skill so a bundle cannot reach outside its own directory either;
 * only where the bytes are read from differs.
 */
export async function installSkillDirectory(options) {
    const entries = await listLocalTree(options.sourceDir);
    if (entries.length === 0) {
        return { ok: false, message: `${options.dirName} contains no files to install.` };
    }
    const skill = {
        id: options.dirName,
        name: options.dirName,
        description: '',
        group: '',
        files: entries.map((entry) => ({
            path: entry.path,
            size: entry.size ?? 0,
            blobSha: '',
            isEntry: entry.path === SKILL_ENTRY_FILE,
        })),
        allowedTools: [],
        hasExecutables: false,
    };
    return installSkill({
        workspaceRoot: options.workspaceRoot,
        skill,
        harnesses: options.harnesses,
        readFile: (file) => readFile(join(options.sourceDir, ...file.path.split('/'))),
        // A bundle is not a skill source, so no source sync ever owns this copy.
        provenance: {
            sourceId: PLUGIN_BUNDLE_SKILL_SOURCE_ID,
            skillId: options.dirName,
            commitSha: '',
        },
    });
}
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
export async function uninstallSkill(options) {
    const root = resolve(options.workspaceRoot);
    const dirName = options.dirName.trim();
    // One path segment, or nothing: a name carrying a separator is refused
    // outright rather than resolved and then found to point outside the
    // workspace, so the refusal is stated instead of looking like a sweep that
    // happened to remove nothing.
    if (dirName.length === 0 || dirName.includes('/') || !isSafeSegment(dirName)) {
        return { ok: false, message: `"${options.dirName}" is not a skill directory name.` };
    }
    const removedPaths = [];
    for (const harness of options.harnesses) {
        const path = resolve(root, SKILL_HARNESS_DIR[harness], 'skills', dirName);
        if (!isInside(root, path))
            continue;
        try {
            // Not `force`: a harness that never held this skill must not be reported
            // as one this call cleaned up.
            await rm(path, { recursive: true });
            removedPaths.push(path);
        }
        catch (error) {
            if (error?.code === 'ENOENT')
                continue;
            return { ok: false, message: error instanceof Error ? error.message : String(error) };
        }
    }
    return { ok: true, dirName, removedPaths };
}
/** Absolute path a skill occupies for one harness, for status and removal. */
export function skillInstallPath(workspaceRoot, harness, dirName) {
    return join(resolve(workspaceRoot), SKILL_HARNESS_DIR[harness], 'skills', dirName);
}
