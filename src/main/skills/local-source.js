// The two sources that are always present: the skills Multicode ships
// (resources/skills) and the skills its connector catalogue ships
// (resources/marketplace/skills). Both are directories on disk, so they scan
// with the same rule as a repository — walk to SKILL.md, take the directory
// whole — just over a filesystem listing instead of a git tree.
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { parseSkillFrontmatter, SKILL_ENTRY_FILE } from '../../shared/skills';
import { scanSkillTree, SKILL_MARKETPLACE_MANIFEST_PATH } from './scan';
// Bounded so a mis-pointed root cannot walk a whole disk.
const MAX_LOCAL_DEPTH = 12;
const IGNORED_DIR_NAMES = new Set(['.git', 'node_modules']);
const ENTRY_READ_CONCURRENCY = 16;
/**
 * List a directory as tree entries the scan rule can read. Local files have no
 * git blob identity, so `blobSha` stays empty rather than carrying an invented
 * digest — nothing downstream compares a local skill by blob.
 */
export async function listLocalTree(root) {
    const entries = [];
    const walk = async (dir, depth) => {
        if (depth > MAX_LOCAL_DEPTH)
            return;
        let dirents;
        try {
            dirents = await readdir(dir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const dirent of dirents) {
            const full = join(dir, dirent.name);
            if (dirent.isDirectory()) {
                if (IGNORED_DIR_NAMES.has(dirent.name))
                    continue;
                await walk(full, depth + 1);
                continue;
            }
            // Symlinks are skipped for the same reason the tree scan skips them:
            // their content is a path, not a skill file.
            if (!dirent.isFile())
                continue;
            const size = await stat(full)
                .then((stats) => stats.size)
                .catch(() => 0);
            entries.push({
                path: relative(root, full).split(sep).join('/'),
                mode: '100644',
                type: 'blob',
                sha: '',
                size,
            });
        }
    };
    await walk(root, 0);
    return entries;
}
/**
 * Scan a directory of skills, reading each entry's frontmatter for the name and
 * description the surface lists. Local reads are cheap enough to do inline;
 * a repository defers the same enrichment behind the network.
 */
export async function scanLocalSkillSource(root) {
    const entries = await listLocalTree(root);
    const manifest = entries.some((entry) => entry.path === SKILL_MARKETPLACE_MANIFEST_PATH)
        ? await readFile(join(root, ...SKILL_MARKETPLACE_MANIFEST_PATH.split('/')), 'utf8').catch(() => null)
        : null;
    const scanned = scanSkillTree({ entries, commitSha: '', marketplaceManifest: manifest });
    // Bounded rather than one open handle per skill: the connector catalogue
    // carries over a thousand skills, and reading them all at once trades a
    // meaningless speedup for EMFILE.
    const skills = [...scanned.skills];
    let cursor = 0;
    const readers = Array.from({ length: Math.min(ENTRY_READ_CONCURRENCY, skills.length) }, async () => {
        while (cursor < skills.length) {
            const index = cursor;
            cursor += 1;
            const entryPath = join(root, ...skills[index].id.split('/').filter(Boolean), SKILL_ENTRY_FILE);
            const frontmatter = parseSkillFrontmatter(await readFile(entryPath, 'utf8').catch(() => ''));
            skills[index] = {
                ...skills[index],
                name: frontmatter.name || skills[index].name,
                description: frontmatter.description,
                allowedTools: frontmatter.allowedTools,
            };
        }
    });
    await Promise.all(readers);
    return { ...scanned, skills };
}
