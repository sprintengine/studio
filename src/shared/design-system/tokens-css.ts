// Reading a bundle's DTCG token document (`foundations/tokens.tokens.json`) —
// the declared source of truth — rather than its generated `foundations/tokens.css`.
//
// Why not the generated file: the Design door is read-only (item 2003). It never
// forks a bundle's `scripts/build-tokens.mjs`, so if an author edited the token
// JSON without regenerating, reading `tokens.css` would draw stale values and the
// staleness would look like ours. Reading the source means a stale generated file
// cannot make us lie.
//
// This module holds ONLY the resolution the door needs: walk the two declared
// tiers (`ref` raw scales, `sem` consumable meaning), resolve `{dotted.path}`
// aliases, and pick a mode. Item 2003 extends it with the full `:root` /
// `[data-mode="dark"]` emission that component previews need, kept honest against
// the bundle's own generator by a byte-equality drift test. Contract:
// knowledge/multicode/design-system-bundle.md.

/** The two modes the bundle format fixes (`manifest.modes`). */
export type DesignSystemTokenMode = 'light' | 'dark'

/** A resolved leaf token: its dotted path and its value in one mode. */
export interface ResolvedToken {
  /** Dotted path without a tier prefix stripped, e.g. `sem.color.accent.primary`. */
  path: string
  /** DTCG `$type` as authored (`color`, `dimension`, `fontFamily`, …). */
  type: string | null
  /** The value with aliases resolved. Null when resolution failed. */
  value: string | null
}

const VENDOR_KEY = 'com.multicode'
/** A DTCG alias is a whole-value reference: `{ref.color.green-700}`. */
const ALIAS_PATTERN = /^\{([^{}]+)\}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A DTCG leaf is any node carrying `$value`; groups are everything else. */
function isLeaf(node: Record<string, unknown>): boolean {
  return '$value' in node
}

/**
 * The mode-specific raw value a leaf declares, falling back to `$value`.
 *
 * A mode-varying token declares `modes: { light, dark }` inside
 * `$extensions["com.multicode"]`, and the format requires `$value` to equal
 * `modes.light`. A token with no `modes` block is mode-invariant, so `$value`
 * is correct for both.
 */
function rawValueForMode(leaf: Record<string, unknown>, mode: DesignSystemTokenMode): unknown {
  const extensions = leaf.$extensions
  if (isRecord(extensions)) {
    const vendor = extensions[VENDOR_KEY]
    if (isRecord(vendor) && isRecord(vendor.modes)) {
      const declared = vendor.modes[mode]
      if (declared !== undefined) return declared
    }
  }
  return leaf.$value
}

/** Walk the document to the leaf at a dotted path, or null. */
function leafAt(document: Record<string, unknown>, path: string): Record<string, unknown> | null {
  let node: unknown = document
  for (const segment of path.split('.')) {
    if (!isRecord(node)) return null
    node = node[segment]
  }
  return isRecord(node) && isLeaf(node) ? node : null
}

/**
 * Resolve one token's value in one mode, following `{dotted.path}` aliases.
 *
 * Alias chains are followed to a concrete value. A chain that does not terminate
 * — a missing target, or a cycle — resolves to `null` rather than to the alias
 * text, so a caller can say "unresolved" instead of rendering `{ref.color.x}` as
 * if it were a colour.
 */
export function resolveTokenValue(
  document: unknown,
  path: string,
  mode: DesignSystemTokenMode,
): string | null {
  if (!isRecord(document)) return null
  const seen = new Set<string>()
  let current = path
  // The chain length is bounded by `seen`, which refuses a repeat visit.
  for (;;) {
    if (seen.has(current)) return null
    seen.add(current)
    const leaf = leafAt(document, current)
    if (!leaf) return null
    const raw = rawValueForMode(leaf, mode)
    if (typeof raw !== 'string') return null
    const alias = ALIAS_PATTERN.exec(raw.trim())
    if (!alias) return raw
    current = alias[1].trim()
  }
}

/**
 * The bundle's own product accent, resolved for one mode.
 *
 * `sem.color.accent.primary` is the one accent the token contract fixes
 * (`principles.md`: one accent per view), so a bundle that follows the schema
 * declares it. A bundle that does not — or whose alias chain is broken —
 * returns null, and the caller shows no chip rather than a fabricated colour.
 */
export function resolveAccentColor(document: unknown, mode: DesignSystemTokenMode): string | null {
  const value = resolveTokenValue(document, 'sem.color.accent.primary', mode)
  return value !== null && isColorValue(value) ? value : null
}

/**
 * A DTCG color `$value` the door is willing to paint with: a hex string, or the
 * `rgb()`/`rgba()`/`hsl()`/`hsla()` forms the schema's soft tokens use. Anything
 * else is refused rather than passed into a style attribute unchecked — token
 * documents are third-party content.
 */
export function isColorValue(value: string): boolean {
  const trimmed = value.trim()
  if (/^#[0-9a-fA-F]{3,8}$/.test(trimmed)) return true
  return /^(rgb|rgba|hsl|hsla)\(\s*[0-9a-zA-Z.,%\s/-]+\)$/.test(trimmed)
}

/**
 * The bundle's declared display and mono families, for a specimen set in the
 * previewed system's own faces rather than in ours.
 *
 * Returns the raw DTCG `fontFamily` value as authored (a CSS family list). Null
 * when the bundle declares neither, in which case a specimen falls back to app
 * chrome and must still be legible.
 */
export function resolveFontFamilies(
  document: unknown,
  mode: DesignSystemTokenMode = 'light',
): { ui: string | null; mono: string | null } {
  return {
    ui: resolveTokenValue(document, 'sem.font.family.ui', mode),
    mono: resolveTokenValue(document, 'sem.font.family.mono', mode),
  }
}

/** Parse a bundle's token document, or null when it is absent/unparseable. */
export function parseTokenDocument(contents: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(contents)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}
