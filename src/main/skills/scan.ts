// The scan rule: a repository tree becomes a list of skills.
//
// A skill is any directory containing SKILL.md, and that directory *in full* is
// the skill. The walk does not descend past a hit, which is what keeps a skill
// with four files one skill rather than one skill plus three orphaned
// documents.
//
// Pure on purpose: everything here is derived from paths, modes and blob SHAs,
// which is exactly what `GET /git/trees/{sha}?recursive=1` returns in a single
// request. No file bytes are read to decide what a source contains, so the
// scan costs one HTTP call regardless of repository size, and the unit suite
// runs against recorded trees with no network at all.

import {
  SKILL_ENTRY_FILE,
  SKILL_REPO_ROOT_GROUP,
  SKILL_UNLISTED_GROUP,
  skillDirName,
  type ScanResult,
  type ScannedSkill,
  type SkillFileRef,
  type SkillGroupingSignal,
} from '../../shared/skills'

export const SKILL_MARKETPLACE_MANIFEST_PATH = '.claude-plugin/marketplace.json'

/** A `git/trees` entry, trimmed to the fields the scan actually reads. */
export type SkillTreeEntry = {
  path: string
  mode: string
  type: string
  sha: string
  size?: number
}

export type SkillTreeScanInput = {
  entries: readonly SkillTreeEntry[]
  commitSha: string
  /** Raw `.claude-plugin/marketplace.json` bytes, when the tree carries one. */
  marketplaceManifest?: string | null
}

// git mode for a symlink. A symlink's "content" is its target path, so writing
// one during install would either recreate a link out of the skill directory or
// drop a file full of someone else's path. Neither is a skill file.
const SYMLINK_MODE = '120000'
const EXECUTABLE_MODE = '100755'

// Extensions the disclosure treats as executable even at mode 100644, because a
// skill that ships `scripts/context.mjs` and instructs the agent to run it is
// shipping an executable whatever its permission bits say.
const SCRIPT_EXTENSIONS = ['.sh', '.bash', '.zsh', '.ps1', '.py', '.rb', '.pl', '.js', '.mjs', '.cjs']

// Directory names that hold a per-harness *copy* of a skill rather than a skill
// of their own. `plugin/` is the Claude Code plugin convention; the rest are the
// dot-directories each agent CLI reads.
const HARNESS_ROOT_NAMES = ['plugin']

export function scanSkillTree(input: SkillTreeScanInput): ScanResult {
  const files = input.entries.filter(
    (entry) => entry.type === 'blob' && entry.mode !== SYMLINK_MODE
  )
  const skillDirs = collapseHarnessMirrors(findSkillDirs(files))

  const owned = new Set(skillDirs)
  const filesByDir = new Map<string, SkillFileRef[]>()
  const executableDirs = new Set<string>()
  for (const dir of skillDirs) filesByDir.set(dir, [])
  for (const file of files) {
    const dir = ownerSkillDir(file.path, owned)
    if (dir === null) continue
    const relativePath = dir === '' ? file.path : file.path.slice(dir.length + 1)
    filesByDir.get(dir)?.push({
      path: relativePath,
      size: file.size ?? 0,
      blobSha: file.sha,
      isEntry: relativePath === SKILL_ENTRY_FILE,
    })
    if (isExecutableFile(relativePath, file.mode)) executableDirs.add(dir)
  }

  const scanned: ScannedSkill[] = skillDirs.map((dir) => ({
    id: dir,
    name: skillDirName(dir),
    description: '',
    group: '',
    files: (filesByDir.get(dir) ?? []).sort((a, b) => comparePaths(a.path, b.path)),
    allowedTools: [],
    hasExecutables: executableDirs.has(dir),
  }))

  return { commitSha: input.commitSha, ...group(scanned, input.marketplaceManifest ?? null) }
}

/**
 * Every directory holding a SKILL.md, minus any that sits under another one —
 * a skill cannot nest a skill, so the outer directory owns the inner files.
 */
function findSkillDirs(files: readonly SkillTreeEntry[]): string[] {
  const dirs = new Set<string>()
  for (const file of files) {
    const cut = file.path.lastIndexOf('/')
    const base = cut === -1 ? file.path : file.path.slice(cut + 1)
    if (base === SKILL_ENTRY_FILE) dirs.add(cut === -1 ? '' : file.path.slice(0, cut))
  }
  const all = [...dirs].sort(comparePaths)
  return all.filter((dir) => !all.some((other) => other !== dir && isUnder(dir, other)))
}

/**
 * Collapse the same skill republished once per agent harness.
 *
 * A repository that ships one skill for fifteen harnesses lays it out as
 * `.claude/skills/x`, `.cursor/skills/x`, `plugin/skills/x` and so on: paths
 * that are identical once their harness root is removed. Matching on that shape
 * is the signal, and it costs nothing beyond the tree that has already been
 * fetched.
 *
 * Byte identity looked like the cheaper signal and is not: measured against
 * pbakaus/impeccable the fifteen SKILL.md copies have fourteen distinct blob
 * SHAs, because each one rewrites its own harness path into the prose, so bytes
 * collapse nothing. Worse, they collapse the wrong things — browser-act/skills
 * publishes one skill under two categories with byte-identical entry files, and
 * those are two real entries the source itself lists twice.
 *
 * The canonical copy is the one with the fewest path segments; ties break to
 * the first non-dot-prefixed path, then lexicographically.
 */
function collapseHarnessMirrors(skillDirs: readonly string[]): string[] {
  const canonicalByMirrorKey = new Map<string, string>()
  for (const dir of skillDirs) {
    const key = harnessMirrorKey(dir)
    const incumbent = canonicalByMirrorKey.get(key)
    if (incumbent === undefined || compareCanonical(dir, incumbent) < 0) {
      canonicalByMirrorKey.set(key, dir)
    }
  }
  return skillDirs
    .filter((dir) => canonicalByMirrorKey.get(harnessMirrorKey(dir)) === dir)
    .sort(comparePaths)
}

/**
 * The path a skill shares with its harness mirrors: its own path with a leading
 * harness root removed. A skill that sits under no harness root keys on its own
 * path, so a repository that ships `skills/x` alongside `.claude/skills/x`
 * collapses to the one at `skills/x` rather than listing the same skill twice.
 */
function harnessMirrorKey(dir: string): string {
  const segments = dir.split('/')
  if (segments.length < 2) return dir
  const root = segments[0]
  if (!root.startsWith('.') && !HARNESS_ROOT_NAMES.includes(root)) return dir
  return segments.slice(1).join('/')
}

function compareCanonical(a: string, b: string): number {
  const depth = a.split('/').length - b.split('/').length
  if (depth !== 0) return depth
  const aHidden = a.startsWith('.')
  const bHidden = b.startsWith('.')
  if (aHidden !== bHidden) return aHidden ? 1 : -1
  return comparePaths(a, b)
}

/**
 * The skill directory a file belongs to, or null when it belongs to none.
 * Walks the file's own parents rather than scanning every skill, so a source
 * with thousands of skills stays linear in the size of the tree.
 */
function ownerSkillDir(path: string, skillDirs: ReadonlySet<string>): string | null {
  let cut = path.lastIndexOf('/')
  while (cut > 0) {
    const dir = path.slice(0, cut)
    if (skillDirs.has(dir)) return dir
    cut = dir.lastIndexOf('/')
  }
  return skillDirs.has('') ? '' : null
}

function isExecutableFile(relativePath: string, mode: string): boolean {
  if (mode === EXECUTABLE_MODE) return true
  const lower = relativePath.toLowerCase()
  return SCRIPT_EXTENSIONS.some((extension) => lower.endsWith(extension))
}

type Grouping = Pick<ScanResult, 'skills' | 'groups' | 'groupingSignal' | 'fileCount'>

/**
 * Grouping, first signal that exists wins: a marketplace manifest that
 * enumerates skills, else the folders the skills sit in, else nothing — and
 * none is invented.
 *
 * The manifest beats the folders deliberately: anthropics/skills is flat on
 * disk yet its manifest authors five real groups, which folder grouping could
 * never have produced.
 *
 * It is additive, not exclusive (2026-09-06). A manifest is a Claude Code
 * convention; the Agent Skills specification defines no collection manifest at
 * all, so the manifest says how a source groups its skills and never which
 * directories are skills. A directory with a SKILL.md that the manifest does
 * not list lands under "Everything else" rather than disappearing —
 * anthropics/skills' `template/` was the skill this hid.
 */
function group(skills: readonly ScannedSkill[], manifest: string | null): Grouping {
  const listed = parseManifestSkills(manifest)
  if (listed !== null) {
    const grouped: ScannedSkill[] = []
    const groups: string[] = []
    for (const [path, name] of listed) {
      const skill = skills.find((candidate) => candidate.id === path)
      if (!skill) continue
      grouped.push({ ...skill, group: name })
      if (!groups.includes(name)) groups.push(name)
    }
    if (grouped.length > 0) {
      const claimed = new Set(grouped.map((skill) => skill.id))
      const unlisted = skills
        .filter((skill) => !claimed.has(skill.id))
        .map((skill) => ({ ...skill, group: SKILL_UNLISTED_GROUP }))
      const all = [...grouped, ...unlisted]
      // `includes` because a manifest is free to have authored a group of that
      // name itself, and two headings reading the same word is a bug the reader
      // cannot explain.
      const withUnlisted =
        unlisted.length > 0 && !groups.includes(SKILL_UNLISTED_GROUP)
          ? [...groups, SKILL_UNLISTED_GROUP]
          : groups
      return {
        skills: all,
        groups: withUnlisted,
        groupingSignal: 'manifest',
        fileCount: countFiles(all),
      }
    }
  }

  const folders = [...new Set(skills.map((skill) => folderGroup(skill.id)))].sort(comparePaths)
  const signal: SkillGroupingSignal = folders.length >= 2 ? 'folders' : 'none'
  if (signal === 'none') {
    return { skills: [...skills], groups: [], groupingSignal: 'none', fileCount: countFiles(skills) }
  }
  const grouped = skills.map((skill) => ({ ...skill, group: folderGroup(skill.id) }))
  return { skills: grouped, groups: folders, groupingSignal: 'folders', fileCount: countFiles(grouped) }
}

/**
 * The skill paths a `.claude-plugin/marketplace.json` enumerates, or null when
 * it enumerates none. A manifest whose plugins carry no `skills` array — the
 * common "this whole repository is one plugin" shape — says nothing about
 * grouping, so it must fall through to the folders rather than flatten a
 * repository into a single group.
 */
function parseManifestSkills(manifest: string | null): Map<string, string> | null {
  if (!manifest) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(manifest)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const plugins = (parsed as { plugins?: unknown }).plugins
  if (!Array.isArray(plugins)) return null

  const listed = new Map<string, string>()
  for (const plugin of plugins) {
    if (!plugin || typeof plugin !== 'object') continue
    const name = (plugin as { name?: unknown }).name
    const skills = (plugin as { skills?: unknown }).skills
    if (typeof name !== 'string' || name.length === 0 || !Array.isArray(skills)) continue
    for (const raw of skills) {
      if (typeof raw !== 'string') continue
      const path = raw.replace(/^\.\//, '').replace(/\/+$/, '')
      if (path.length > 0 && !listed.has(path)) listed.set(path, name)
    }
  }
  return listed.size > 0 ? listed : null
}

function folderGroup(skillId: string): string {
  const segments = skillId.split('/').filter((segment) => segment.length > 0)
  return segments.length >= 2 ? segments[segments.length - 2] : SKILL_REPO_ROOT_GROUP
}

function countFiles(skills: readonly ScannedSkill[]): number {
  return skills.reduce((total, skill) => total + skill.files.length, 0)
}

function isUnder(path: string, dir: string): boolean {
  return dir === '' ? path.length > 0 : path.startsWith(`${dir}/`)
}

function comparePaths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
