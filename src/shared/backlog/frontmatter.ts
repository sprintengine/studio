// Single source of truth for reading and writing Backlog markdown frontmatter.
//
// Both the renderer read model (src/renderer/src/utils/backlog.ts) and the
// main-process Backlog service write through this module, so it must stay free
// of renderer-only or main-only imports. Frontmatter is a flat block of scalar
// `key: value` lines (the v2 schema in docs/backlog-item-schema.md). Existing
// files may also carry a single nested `section:` block, which the parser still
// reads as `section.key` entries for backward compatibility; the writer only
// ever touches top-level keys and never reserializes the parsed object.
//
// The hard contract — pinned by round-trip property tests over every file in
// this repo's backlog/ — is that serializeBacklogFrontmatterFields preserves the
// document body byte-for-byte and preserves unknown frontmatter keys and their
// order. Clearing a key removes its line; setting a key absent from the original
// then clearing it returns byte-identical content.

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/

export type ParsedBacklogFrontmatter = {
  body: string
  fields: Record<string, string>
}

// A string value sets (or replaces) a top-level key; null/undefined clears it.
export type BacklogFrontmatterUpdates = Record<string, string | null | undefined>

export function parseBacklogFrontmatter(content: string): ParsedBacklogFrontmatter {
  const match = FRONTMATTER_RE.exec(content)
  if (!match) return { body: content, fields: {} }

  const fields: Record<string, string> = {}
  let currentSection: string | null = null
  for (const rawLine of match[1].split(/\r?\n/)) {
    const trimmed = rawLine.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const section = /^([A-Za-z0-9_-]+)\s*:\s*$/.exec(rawLine)
    if (section) {
      currentSection = section[1].toLowerCase()
      continue
    }

    const kv = /^(\s*)([A-Za-z0-9_-]+)\s*:\s*(.+)$/.exec(rawLine)
    if (!kv) continue
    const indent = kv[1].length
    const key = kv[2].toLowerCase()
    const value = stripYamlQuotes(kv[3])
    if (indent > 0 && currentSection) {
      fields[`${currentSection}.${key}`] = value
    } else {
      currentSection = null
      fields[key] = value
    }
  }
  return { body: content.slice(match[0].length), fields }
}

export function serializeBacklogFrontmatterFields(
  content: string,
  updates: BacklogFrontmatterUpdates,
): string {
  const { sets, clears, spellings } = normalizeUpdates(updates)
  if (sets.size === 0 && clears.size === 0) return content

  const eol = content.includes('\r\n') ? '\r\n' : '\n'
  const match = FRONTMATTER_RE.exec(content)

  if (!match) {
    // No frontmatter block: clears are no-ops, and with nothing to set the file
    // is returned untouched so a clear-only call never injects an empty block.
    if (sets.size === 0) return content
    const lines = Array.from(sets, ([key, value]) => `${spellings.get(key) ?? key}: ${formatScalar(value)}`)
    return `---${eol}${lines.join(eol)}${eol}---${eol}${content}`
  }

  const resultLines: string[] = []
  const handled = new Set<string>()
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([ \t]*)([A-Za-z0-9_-]+)([ \t]*:)([ \t]*)(.*)$/.exec(line)
    // Preserve comments, blank lines, nested entries, and any line we cannot
    // recognize as a top-level scalar; only top-level keys are update targets.
    if (!kv || kv[1].length > 0) {
      resultLines.push(line)
      continue
    }
    const key = kv[2].toLowerCase()
    if (clears.has(key)) {
      handled.add(key)
      continue
    }
    if (sets.has(key)) {
      handled.add(key)
      resultLines.push(`${kv[2]}${kv[3]}${kv[4]}${formatScalar(sets.get(key)!)}`)
      continue
    }
    resultLines.push(line)
  }

  for (const [key, value] of sets) {
    if (handled.has(key)) continue
    // A key already in the file keeps its own spelling (the loop above rewrites
    // the value in place); a NEW line is written the way the caller spelled it,
    // so `dependsOn` lands as `dependsOn:` rather than flattened to lowercase.
    // Matching stays case-insensitive either way — the parser lowercases keys.
    resultLines.push(`${spellings.get(key) ?? key}: ${formatScalar(value)}`)
  }

  const body = content.slice(match[0].length)
  // Drop the whole block once it holds no real content, so creating a key on a
  // file with no frontmatter and then clearing it is a true byte-for-byte
  // inverse (rather than leaving an empty `---\n---` shell behind).
  if (!resultLines.some((line) => line.trim().length > 0)) return body
  const closeTrailing = /\r?\n$/.test(match[0]) ? eol : ''
  return `---${eol}${resultLines.join(eol)}${eol}---${closeTrailing}${body}`
}

// Backlog identifiers — the `epic:` pointer and each `dependsOn:` prerequisite —
// reference an item by its filename stem, so a valid slug is one filename-stem
// token: letters, digits, dot, underscore, hyphen, never whitespace, a path
// separator, or the `.`/`..` directory names. Mirrors the service-side epic-slug
// check so the read model and the write path agree on what a slug may contain.
const BACKLOG_SLUG_RE = /^[A-Za-z0-9._-]+$/

export function isValidBacklogSlug(value: unknown): value is string {
  return typeof value === 'string' && BACKLOG_SLUG_RE.test(value) && value !== '.' && value !== '..'
}

// An epic's `dependenciesPlanned:` mark (MC-2137): the author asserting that the
// ordering pass over this epic's children is finished, whoever ran it — a hand
// edit, a planning agent, `/backlog` closing an ordering session. It is what
// disambiguates the two meanings of "no `dependsOn` edges": deliberately
// parallel (flag set) versus never ordered (flag absent).
//
// An assertion of intent, never a computed property: nothing recomputes or
// unsets it, so editing an epic's membership is the author's cue to re-check it.
// Absent means false, and only the literal `true` sets it — a value the writer
// never emits ("maybe", "1") must not read as a planning pass that never
// happened, so it reads false rather than being guessed either way.
export const BACKLOG_DEPENDENCIES_PLANNED_KEY = 'dependenciesPlanned'

export function parseBacklogDependenciesPlanned(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().toLowerCase() === 'true'
}

// The same answer from a parsed frontmatter block. Parsed keys are lowercased,
// so every reader must look the camelCase field up at its lowercased spelling —
// this is the one place that knows it.
export function backlogDependenciesPlannedFromFields(fields: Record<string, string>): boolean {
  return parseBacklogDependenciesPlanned(fields[BACKLOG_DEPENDENCIES_PLANNED_KEY.toLowerCase()])
}

// Parse a flat comma-separated scalar — the frontmatter format has no array
// support, so list fields like `dependsOn:` are authored as a single
// `a-item, b-item` line — into a clean list: split on commas, trim, drop
// empties, and dedupe keeping first-seen order. `formatBacklogCsvList` is its
// inverse for any already-clean list.
export function parseBacklogCsvList(value: string | null | undefined): string[] {
  if (!value) return []
  const items: string[] = []
  const seen = new Set<string>()
  for (const part of value.split(',')) {
    const slug = part.trim()
    if (!slug || seen.has(slug)) continue
    seen.add(slug)
    items.push(slug)
  }
  return items
}

// Serialize a list back to the single comma-separated scalar one frontmatter
// line holds. Inverse of parseBacklogCsvList for a clean list (trimmed,
// non-empty, deduped); an empty list yields '' so the write path clears the line.
export function formatBacklogCsvList(values: string[]): string {
  return values.join(', ')
}

// The markdown body with the frontmatter block removed — the item content a
// reader shows. Shared by every non-panel consumer (mobile bridge, automation
// server) so "body" means the same bytes everywhere.
export function stripBacklogFrontmatter(raw: string): string {
  if (!raw.startsWith('---')) {
    return raw
  }
  const end = raw.indexOf('\n---', 3)
  return end === -1 ? raw : raw.slice(raw.indexOf('\n', end + 1) + 1)
}

// An item's display title: the first `# Heading` of the body, else a
// humanized filename stem (date prefix dropped, dashes to spaces).
export function extractBacklogTitle(body: string, relativePath: string): string {
  for (const line of body.split(/\r?\n/)) {
    const heading = line.match(/^#\s+(.+)$/)
    if (heading) {
      return heading[1].trim()
    }
  }
  return backlogTitleFromPath(relativePath)
}

export function backlogTitleFromPath(relativePath: string): string {
  const stem = (relativePath.split(/[\\/]/).pop() ?? relativePath).replace(/\.md$/i, '')
  return stem.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/[-_]+/g, ' ').trim() || stem
}

function normalizeUpdates(updates: BacklogFrontmatterUpdates): {
  sets: Map<string, string>
  clears: Set<string>
  // Lowercased key -> the spelling the caller used, for lines this write appends.
  spellings: Map<string, string>
} {
  const sets = new Map<string, string>()
  const clears = new Set<string>()
  const spellings = new Map<string, string>()
  for (const [rawKey, value] of Object.entries(updates)) {
    const trimmed = rawKey.trim()
    const key = trimmed.toLowerCase()
    if (!key) continue
    spellings.set(key, trimmed)
    if (value === null || value === undefined) {
      clears.add(key)
      sets.delete(key)
    } else {
      sets.set(key, value)
      clears.delete(key)
    }
  }
  return { sets, clears, spellings }
}

// Emit a bare scalar matching the existing `key: value` style. Embedded CR/LF are
// collapsed to a space first: the parser is line-based, so a quoted multi-line
// value would still spill onto extra physical lines that re-parse as injected
// `key: value` frontmatter (sec F1). Flat frontmatter is single-line by
// construction, so a newline-bearing scalar cannot round-trip regardless. After
// flattening, quote only when a bare value would not round-trip through the
// parser: empty, surrounding whitespace, a leading YAML indicator, an inline
// `: ` or ` #` sequence, or surrounding quotes the parser would strip.
function formatScalar(value: string): string {
  const flat = value.replace(/[\r\n]+/g, ' ')
  const needsQuote =
    flat === '' ||
    flat !== flat.trim() ||
    /^[\s"'#&*!|>%@`?:,\-[\]{}]/.test(flat) ||
    /:\s/.test(flat) ||
    /\s#/.test(flat)
  if (!needsQuote) return flat
  return `"${flat.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function stripYamlQuotes(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    const last = trimmed[trimmed.length - 1]
    // Double quotes reverse formatScalar's escaping (\" -> ", \\ -> \) so an
    // embedded-quote value round-trips (sec F2); single quotes are emitted raw.
    if (first === '"' && last === '"') return trimmed.slice(1, -1).replace(/\\(["\\])/g, '$1')
    if (first === "'" && last === "'") return trimmed.slice(1, -1)
  }
  return trimmed
}
