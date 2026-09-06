// The two sources that are always present: the skills Multicode ships
// (resources/skills) and the skills its connector catalogue ships
// (resources/marketplace/skills). Both are directories on disk, so they scan
// with the same rule as a repository — walk to SKILL.md, take the directory
// whole — just over a filesystem listing instead of a git tree.

import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

import { parseSkillFrontmatter, SKILL_ENTRY_FILE, type ScanResult } from '../../shared/skills'
import { scanSkillTree, SKILL_MARKETPLACE_MANIFEST_PATH, type SkillTreeEntry } from './scan'

// Bounded so a mis-pointed root cannot walk a whole disk. Depth alone is not
// the bound that matters: a home directory is wide long before it is deep, and
// the walk runs on the main process — someone who picks `/` from the folder
// dialog would stat every file on the machine while the app sits still. The
// entry cap is the real stop, and hitting it is reported rather than silently
// truncating the listing into a source that says it holds fewer skills than it
// does.
const MAX_LOCAL_DEPTH = 12
const MAX_LOCAL_ENTRIES = 20_000

export class LocalSourceTooLargeError extends Error {
  constructor(root: string) {
    super(
      `${root} holds more than ${MAX_LOCAL_ENTRIES.toLocaleString('en-US')} files. Pick the folder that holds the skills rather than the tree that contains it.`,
    )
    this.name = 'LocalSourceTooLargeError'
  }
}
const IGNORED_DIR_NAMES = new Set(['.git', 'node_modules'])
const ENTRY_READ_CONCURRENCY = 16

/**
 * List a directory as tree entries the scan rule can read. Local files have no
 * git blob identity, so `blobSha` stays empty rather than carrying an invented
 * digest — nothing downstream compares a local skill by blob.
 */
export async function listLocalTree(
  root: string,
  maxEntries: number = MAX_LOCAL_ENTRIES,
): Promise<SkillTreeEntry[]> {
  const entries: SkillTreeEntry[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_LOCAL_DEPTH) return
    if (entries.length >= maxEntries) throw new LocalSourceTooLargeError(root)
    let dirents
    try {
      dirents = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const dirent of dirents) {
      const full = join(dir, dirent.name)
      if (dirent.isDirectory()) {
        if (IGNORED_DIR_NAMES.has(dirent.name)) continue
        await walk(full, depth + 1)
        continue
      }
      // Symlinks are skipped for the same reason the tree scan skips them:
      // their content is a path, not a skill file.
      if (!dirent.isFile()) continue
      const size = await stat(full)
        .then((stats) => stats.size)
        .catch(() => 0)
      entries.push({
        path: relative(root, full).split(sep).join('/'),
        mode: '100644',
        type: 'blob',
        sha: '',
        size,
      })
      if (entries.length >= maxEntries) throw new LocalSourceTooLargeError(root)
    }
  }
  await walk(root, 0)
  return entries
}

/**
 * Scan a directory of skills, reading each entry's frontmatter for the name and
 * description the surface lists. Local reads are cheap enough to do inline;
 * a repository defers the same enrichment behind the network.
 *
 * `maxEntries` is the walk's breadth cap, on by default. The two bundled roots
 * pass `Infinity` deliberately: their size is a release decision the app made
 * and can measure, not a folder someone picked by mistake — the connector
 * catalogue alone is over ten thousand files today.
 */
export async function scanLocalSkillSource(
  root: string,
  options: { maxEntries?: number } = {},
): Promise<ScanResult> {
  const entries = await listLocalTree(root, options.maxEntries ?? MAX_LOCAL_ENTRIES)
  const manifest = entries.some((entry) => entry.path === SKILL_MARKETPLACE_MANIFEST_PATH)
    ? await readFile(join(root, ...SKILL_MARKETPLACE_MANIFEST_PATH.split('/')), 'utf8').catch(
        () => null
      )
    : null
  const scanned = scanSkillTree({ entries, commitSha: '', marketplaceManifest: manifest })

  // Bounded rather than one open handle per skill: the connector catalogue
  // carries over a thousand skills, and reading them all at once trades a
  // meaningless speedup for EMFILE.
  const skills = [...scanned.skills]
  // An entry that was read and declares no description is not a skill
  // (https://agentskills.io/specification, fetched 2026-09-06); one that could
  // not be read is a skill nobody read, and keeps its row.
  const skipped = new Set<number>()
  let cursor = 0
  const readers = Array.from({ length: Math.min(ENTRY_READ_CONCURRENCY, skills.length) }, async () => {
    while (cursor < skills.length) {
      const index = cursor
      cursor += 1
      const entryPath = join(root, ...skills[index].id.split('/').filter(Boolean), SKILL_ENTRY_FILE)
      const raw = await readFile(entryPath, 'utf8').catch(() => '')
      if (raw === '') continue
      const frontmatter = parseSkillFrontmatter(raw)
      if (frontmatter.description === '') {
        skipped.add(index)
        continue
      }
      skills[index] = {
        ...skills[index],
        name: frontmatter.name || skills[index].name,
        description: frontmatter.description,
        allowedTools: frontmatter.allowedTools,
        license: frontmatter.license,
        compatibility: frontmatter.compatibility,
        metadata: frontmatter.metadata,
      }
    }
  })
  await Promise.all(readers)
  const kept = skills.filter((_, index) => !skipped.has(index))
  return {
    ...scanned,
    skills: kept,
    skippedNoDescription: skipped.size,
    fileCount: kept.reduce((total, skill) => total + skill.files.length, 0),
  }
}
