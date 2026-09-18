// Sources that are directories on disk rather than repositories: a folder
// someone added, the connector catalogue's skills (resources/marketplace/skills)
// and the bundled seed of our own marketplace (resources/studio-plugin). They
// scan with the same rule as a repository — walk to SKILL.md, take the
// directory whole — just over a filesystem listing instead of a git tree.

import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'

import { parseSkillFrontmatter, SKILL_ENTRY_FILE, type ScanResult } from '../../shared/skills'
import { scanSkillTree, SKILL_MARKETPLACE_MANIFEST_PATH, type SkillTreeEntry } from './scan'
import { scanPluginTree } from './scan-plugins'

// Bounded so a mis-pointed root cannot walk a whole disk. Depth alone is not
// the bound that matters: a home directory is wide long before it is deep, and
// the walk runs on the main process — someone who picks `/` from the folder
// dialog would stat every file on the machine while the app sits still. The
// entry cap is the real stop, and hitting it is reported rather than silently
// truncating the listing into a source that says it holds fewer skills than it
// does.
const MAX_LOCAL_DEPTH = 12
const MAX_LOCAL_ENTRIES = 20_000

class LocalSourceTooLargeError extends Error {
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
export async function listLocalTree(root: string, maxEntries: number = MAX_LOCAL_ENTRIES): Promise<SkillTreeEntry[]> {
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
 * `maxEntries` is the walk's breadth cap, on by default. The bundled roots
 * pass `Infinity` deliberately: their size is a release decision the app made
 * and can measure, not a folder someone picked by mistake — the connector
 * catalogue alone is over ten thousand files today.
 *
 * `plugins` reads the same tree for the plugins and MCP servers it declares,
 * the way a repository scan does. Off by default, because a folder someone
 * pointed at is a folder of skills until it says otherwise and the extra pass
 * costs a read per manifest; on for the bundled marketplace seed
 * (studio-marketplace ruling, 2026-09-06), whose whole point is that the tab
 * lists the same plugins offline as it does over the network.
 */
export async function scanLocalSkillSource(
  root: string,
  options: { maxEntries?: number; plugins?: boolean } = {},
): Promise<ScanResult> {
  const entries = await listLocalTree(root, options.maxEntries ?? MAX_LOCAL_ENTRIES)
  const manifest = entries.some((entry) => entry.path === SKILL_MARKETPLACE_MANIFEST_PATH)
    ? await readFile(join(root, ...SKILL_MARKETPLACE_MANIFEST_PATH.split('/')), 'utf8').catch(() => null)
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
      // null is "not read"; '' is a zero-byte SKILL.md, which exists and
      // declares no description.
      const raw = await readFile(entryPath, 'utf8').catch(() => null)
      if (raw === null) continue
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
  const base: ScanResult = {
    ...scanned,
    skills: kept,
    skippedNoDescription: skipped.size,
    fileCount: kept.reduce((total, skill) => total + skill.files.length, 0),
  }
  if (options.plugins !== true) return base
  // Every directory, not just the listable ones — the same rule the repository
  // scan follows: a plugin's own manifest is the authority on what it ships,
  // and a skill this scan dropped is still a directory the plugin shipped.
  const declared = await scanPluginTree({
    entries,
    skills: scanned.skills,
    marketplaceManifest: manifest,
    readFile: (path) => readLocalFile(root, path),
  })
  return { ...base, ...declared }
}

/**
 * One file under `root`, or null. Confined to the tree: a manifest is
 * third-party content, and a `source` of `../../..` in it must not turn a scan
 * into a read of somebody's home directory.
 */
async function readLocalFile(root: string, path: string): Promise<string | null> {
  const full = resolve(root, ...path.split('/'))
  const base = resolve(root)
  if (full !== base && !full.startsWith(`${base}${sep}`)) return null
  return readFile(full, 'utf8').catch(() => null)
}
