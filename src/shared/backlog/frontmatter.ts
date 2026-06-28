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
  const { sets, clears } = normalizeUpdates(updates)
  if (sets.size === 0 && clears.size === 0) return content

  const eol = content.includes('\r\n') ? '\r\n' : '\n'
  const match = FRONTMATTER_RE.exec(content)

  if (!match) {
    // No frontmatter block: clears are no-ops, and with nothing to set the file
    // is returned untouched so a clear-only call never injects an empty block.
    if (sets.size === 0) return content
    const lines = Array.from(sets, ([key, value]) => `${key}: ${formatScalar(value)}`)
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
    resultLines.push(`${key}: ${formatScalar(value)}`)
  }

  const body = content.slice(match[0].length)
  // Drop the whole block once it holds no real content, so creating a key on a
  // file with no frontmatter and then clearing it is a true byte-for-byte
  // inverse (rather than leaving an empty `---\n---` shell behind).
  if (!resultLines.some((line) => line.trim().length > 0)) return body
  const closeTrailing = /\r?\n$/.test(match[0]) ? eol : ''
  return `---${eol}${resultLines.join(eol)}${eol}---${closeTrailing}${body}`
}

function normalizeUpdates(updates: BacklogFrontmatterUpdates): {
  sets: Map<string, string>
  clears: Set<string>
} {
  const sets = new Map<string, string>()
  const clears = new Set<string>()
  for (const [rawKey, value] of Object.entries(updates)) {
    const key = rawKey.trim().toLowerCase()
    if (!key) continue
    if (value === null || value === undefined) {
      clears.add(key)
      sets.delete(key)
    } else {
      sets.set(key, value)
      clears.delete(key)
    }
  }
  return { sets, clears }
}

// Emit a bare scalar matching the existing `key: value` style, quoting only when
// a bare value would not round-trip through the flat-scalar parser: empty,
// surrounding whitespace, embedded newlines, a leading YAML indicator, an inline
// `: ` or ` #` sequence, or surrounding quotes the parser would strip.
function formatScalar(value: string): string {
  const needsQuote =
    value === '' ||
    value !== value.trim() ||
    /[\r\n]/.test(value) ||
    /^[\s"'#&*!|>%@`?:,\-[\]{}]/.test(value) ||
    /:\s/.test(value) ||
    /\s#/.test(value)
  if (!needsQuote) return value
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function stripYamlQuotes(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    const last = trimmed[trimmed.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return trimmed.slice(1, -1)
  }
  return trimmed
}
