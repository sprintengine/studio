// Skill sources: the shapes the whole Skills surface is built on.
//
// A *source* is somewhere skills come from — the skills Multicode ships
// (`builtin`), the skills its connector catalogue ships (`connectors`), or any
// public GitHub repository the user adds (`github`). Scanning a source turns it
// into a list of skills; a skill is a directory containing SKILL.md, taken
// whole.
//
// Renderer-safe on purpose (no node imports): the Extensions surface, the
// reader, and the main-process scanner all speak these types.

export type SkillSourceKind = 'builtin' | 'connectors' | 'github'

/**
 * An agent CLI that reads workspace skills. Which directory each one reads is
 * `SKILL_HARNESS_DIR` in src/shared/skill-harnesses.ts; this is the identity
 * alone, so renderer code can name a harness without importing a node module.
 */
export type SkillHarness = 'claude' | 'codex' | 'cursor' | 'gemini' | 'opencode' | 'grok' | 'agents'

/** A place skills come from. `repo` is `owner/name` for github, '' otherwise. */
export type SkillSource = {
  id: string
  kind: SkillSourceKind
  name: string
  repo: string
  /** 1-2 character badge shown in the source rail. */
  monogram: string
  blurb: string
  /** Commit the cached scan was taken at; '' for sources with no git identity. */
  commitSha: string
  /** ISO timestamp of the cached scan; '' when never scanned. */
  scannedAt: string
}

/**
 * One file inside a skill. `path` is skill-relative with forward slashes, so
 * `agents/openai.yaml` keeps its shape when installed. `blobSha` is the git
 * blob id from the tree listing, and is '' for sources with no git identity.
 */
export type SkillFileRef = {
  path: string
  size: number
  blobSha: string
  isEntry: boolean
}

export type ScannedSkill = {
  /** Source-relative directory path — the skill's identity within its source. */
  id: string
  name: string
  description: string
  /** Group name, or '' when the source carries no grouping signal. */
  group: string
  files: SkillFileRef[]
  allowedTools: string[]
  hasExecutables: boolean
}

export type SkillGroupingSignal = 'manifest' | 'folders' | 'none'

export type ScanResult = {
  skills: ScannedSkill[]
  groups: string[]
  groupingSignal: SkillGroupingSignal
  fileCount: number
  commitSha: string
}

export type SkillSourceLayout = 'solo' | 'flat' | 'grouped' | 'search' | 'none'

export const SKILL_ENTRY_FILE = 'SKILL.md'

/** Group name for skills that sit directly at a source's root. */
export const SKILL_REPO_ROOT_GROUP = '(repo root)'

export const BUILTIN_SKILL_SOURCE_ID = 'builtin'
export const CONNECTORS_SKILL_SOURCE_ID = 'connectors'

/**
 * How a source's skill list should be presented. Derived on read, never
 * persisted: the same scan renders differently as a repository grows, and a
 * stored layout would go stale the moment Sync moved the commit.
 *
 * A grouped source stays browsable much further than a flat one, because the
 * groups do the narrowing a search box would otherwise have to do.
 */
export function sourceLayout(result: ScanResult): SkillSourceLayout {
  const count = result.skills.length
  if (count === 0) return 'none'
  if (count === 1) return 'solo'
  if (result.groupingSignal !== 'none' && result.groups.length > 0) {
    return count <= 60 ? 'grouped' : 'search'
  }
  return count <= 24 ? 'flat' : 'search'
}

// Discover: finding a skill you do not already have the repository for.
//
// Repository search matches a repo's name, description and README, so it finds
// repos that *mention* a capability. Code search matches inside `SKILL.md`, so
// it finds skills that *do* it — including skills vendored inside repos that are
// not skill collections at all. Discover produces candidates; scanning one is
// the existing add-a-source path.

/**
 * Why a Discover query could not answer in full. Always stated: an empty list
 * with no condition means "GitHub has no match", and nothing else may borrow
 * that meaning.
 */
export type SkillDiscoveryCondition = {
  reason: 'needs_token' | 'rate_limited' | 'query_too_short' | 'unavailable'
  message: string
  /** Seconds until the limit resets; 0 when GitHub did not say, or not a limit. */
  retryAfterSeconds: number
}

/** What GitHub reported about the budget the query spent from. */
export type SkillRateLimit = {
  limit: number
  remaining: number
  /** ISO timestamp the window resets at; '' when GitHub did not say. */
  resetAt: string
}

/** One skill found inside a repository — a candidate to scan, not a source. */
export type SkillSearchHit = {
  /** `owner/name`. */
  repo: string
  /** Repo-relative path of the matched SKILL.md. */
  path: string
  /** Directory holding the skill — its id once the repo is scanned; '' at the root. */
  skillId: string
  /** From the matched frontmatter, falling back to the directory name. */
  name: string
  /** From the matched frontmatter; '' when the fragment carried none. */
  description: string
  htmlUrl: string
}

/**
 * A repository Discover offers to scan. It carries no skill count on purpose:
 * the count is unknown until the repo is scanned, and stars do not predict it —
 * one 52k-star repo holds a single skill while a 4.9k-star one holds 103.
 */
export type SkillRepoHit = {
  repo: string
  description: string
  /** null when the result did not come with a star count — never shown as 0. */
  stars: number | null
  htmlUrl: string
  /** Carries `.claude-plugin/marketplace.json`: someone curated the contents. */
  curated: boolean
}

export type SkillDiscoveryResult<T> = {
  results: T[]
  rateLimit: SkillRateLimit | null
  degraded: SkillDiscoveryCondition | null
}

/** Shortest query code search is asked to run; below it GitHub matches everything. */
export const MIN_SKILL_SEARCH_QUERY_LENGTH = 3

// Agent capabilities: what the agent in one terminal can actually reach.
//
// Derived on demand from the harness directories and CLI config files, never
// from a record of what we intended to install — someone who hand-edits
// `.claude/skills` or `.mcp.json` sees the result here. One query answers the
// whole question so no surface joins several calls and drifts from the next.

/** Where an installed skill directory came from, read from its provenance marker. */
export type AgentSkillSource = 'builtin' | 'source' | 'local'

export type AgentSkill = {
  /** Directory name, which is the skill's identity to every CLI that reads it. */
  id: string
  name: string
  /** '' when the SKILL.md carries no description; never invented copy. */
  description: string
  /** How to invoke it in this CLI, rendered from the plugin's own template. */
  invocation: string
  source: AgentSkillSource
  /**
   * Every CLI bound to this harness. The skill lives in one directory, and each
   * of these can read it — this is the attribution that stops a shared skill
   * being counted once per CLI.
   */
  pluginIds: string[]
}

/**
 * An MCP server a CLI is configured with, read from that CLI's own config file
 * by the format adapter its manifest declares. Configured, not necessarily
 * loaded: a config that marks a server disabled still declares it, and both
 * CLIs that express that state list it as disabled rather than omitting it, so
 * dropping it here would hide something the user wrote.
 */
export type AgentMcpServer = {
  id: string
  transport: string
  /** Absent unless the config states it — a count is never guessed. */
  toolCount?: number
  /** Which of the CLI's two declared config files this entry won from. */
  scope: 'workspace' | 'user'
  configPath: string
}

/**
 * Why one path could not be read. A union, not a boolean: `malformed` (a file
 * that opened but could not be parsed) is a different fault from one that could
 * not be opened at all, and the likeliest real-world one for a config file.
 */
export type CapabilityDiagnosticReason = 'unreadable' | 'malformed'

/** Which half of the answer a fault belongs to. */
export type CapabilityKind = 'skills' | 'servers'

export type CapabilityDiagnostic = {
  /**
   * A surface that renders one half must not be blanked by the other half's
   * fault: an unparseable `.mcp.json` is not a reason to stop listing skills.
   */
  capability: CapabilityKind
  reason: CapabilityDiagnosticReason
  /** The path that failed, so the surface can name it. */
  path: string
  message: string
}

export type AgentCapabilitiesInput = {
  workspaceRoot: string
  pluginId: string
}

/**
 * `ok: false` is reserved for a question that could not be asked (no workspace).
 * A CLI with no skill support, and a harness directory that was never created,
 * are both `ok: true` with a stated `support` — an unavailable capability is a
 * result, never an empty list.
 */
export type AgentCapabilitiesResult =
  | {
      ok: true
      support: 'native' | 'prompt-shim' | 'unsupported'
      /** '' when the plugin declares no skill integration at all. */
      harnessId: string
      skills: AgentSkill[]
      servers: AgentMcpServer[]
      diagnostics: CapabilityDiagnostic[]
    }
  | { ok: false; message: string }

export type SkillFrontmatter = {
  name: string
  description: string
  allowedTools: string[]
}

/**
 * Read the SKILL.md frontmatter fields the surface discloses. Deliberately not
 * a YAML parser: skill frontmatter is a flat block of scalars plus the one
 * `allowed-tools` sequence, and a real YAML dependency would buy nothing but a
 * larger parse surface for third-party bytes.
 */
export function parseSkillFrontmatter(raw: string): SkillFrontmatter {
  const block = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  const result: SkillFrontmatter = { name: '', description: '', allowedTools: [] }
  if (!block) return result

  const lines = block[1].split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const scalar = lines[index].match(/^(name|description):\s*(.*)$/)
    if (scalar) {
      const value = unquoteYamlScalar(scalar[2])
      if (scalar[1] === 'name' && !result.name) result.name = value
      if (scalar[1] === 'description' && !result.description) result.description = value
      continue
    }
    const tools = lines[index].match(/^allowed-tools:\s*(.*)$/)
    if (!tools || result.allowedTools.length > 0) continue
    const inline = unquoteYamlScalar(tools[1])
    if (inline) {
      result.allowedTools = splitToolList(inline)
      continue
    }
    // Block sequence: `allowed-tools:` followed by indented `- ` items.
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const item = lines[cursor].match(/^\s+-\s*(.+?)\s*$/)
      if (!item) break
      const value = unquoteYamlScalar(item[1])
      if (value) result.allowedTools.push(value)
    }
  }
  return result
}

/**
 * Name and description out of a code-search text-match fragment.
 *
 * The fragment is a window into SKILL.md rather than the whole file, so the
 * `---` fences are usually missing and `parseSkillFrontmatter` would return
 * nothing. Fields it cannot find come back empty: the row then shows the path
 * it did find, never invented copy.
 */
export function parseSkillFragment(fragment: string): { name: string; description: string } {
  const lines = fragment.split(/\r?\n/)
  const found = { name: '', description: '' }
  for (let index = 0; index < lines.length; index += 1) {
    const field = lines[index].match(/^(name|description):\s*(.*)$/)
    if (!field) continue
    const key = field[1] as 'name' | 'description'
    if (found[key]) continue
    const inline = unquoteYamlScalar(field[2])
    found[key] = isYamlBlockMarker(inline) ? foldedBlockValue(lines, index + 1) : inline
  }
  return found
}

function isYamlBlockMarker(value: string): boolean {
  return value === '' || /^[|>][+-]?$/.test(value)
}

/** The indented lines under a folded or empty scalar, joined the way YAML folds them. */
function foldedBlockValue(lines: readonly string[], start: number): string {
  const collected: string[] = []
  for (let cursor = start; cursor < lines.length; cursor += 1) {
    const line = lines[cursor]
    if (!/^\s+\S/.test(line)) break
    collected.push(line.trim())
  }
  return collected.join(' ')
}

function splitToolList(value: string): string[] {
  const inner = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value
  return inner
    .split(',')
    .map((token) => unquoteYamlScalar(token))
    .filter((token) => token.length > 0)
}

function unquoteYamlScalar(value: string): string {
  const trimmed = value.trim()
  if (
    trimmed.length >= 2
    && ((trimmed.startsWith('"') && trimmed.endsWith('"'))
      || (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1).trim()
  }
  return trimmed
}

/** Directory name a skill installs under — the last segment of its id. */
export function skillDirName(skillId: string): string {
  const segments = skillId.split('/').filter((segment) => segment.length > 0)
  return segments.length > 0 ? segments[segments.length - 1] : ''
}

/** Up to two uppercase letters for the source rail badge. */
export function skillSourceMonogram(name: string): string {
  const words = name.split(/[^A-Za-z0-9]+/).filter((word) => word.length > 0)
  if (words.length === 0) return '?'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return `${words[0][0]}${words[1][0]}`.toUpperCase()
}
