// Reading a bundle's DTCG token document (`foundations/tokens.tokens.json`) —
// the declared source of truth — rather than its generated `foundations/tokens.css`.
//
// Why not the generated file: the Design door is read-only (item 2003). It never
// forks a bundle's `scripts/build-tokens.mjs`, so if an author edited the token
// JSON without regenerating, reading `tokens.css` would draw stale values and the
// staleness would look like ours. Reading the source means a stale generated file
// cannot make us lie.
//
// Two things live here. The resolution the rail needs (walk the `ref`/`sem`
// tiers, follow `{dotted.path}` aliases, pick a mode), and `emitTokensCss` —
// the full `:root` / `[data-mode="dark"]` block component previews are rendered
// against.
//
// `emitTokensCss` is a SECOND implementation of the emission the bundle's own
// `scripts/build-tokens.mjs` performs, which the KG otherwise forbids. It is
// allowed here for one reason: this one WRITES NOTHING. Regeneration still
// belongs to the bundle's own script (forked by `derived-file-runner.ts`); this
// only composes a string in memory so a scripts-off iframe has the right
// variables. What keeps the two honest is `test:shared:design-system-tokens-css`,
// which runs the template script over the example bundle and asserts
// byte-equality with this function. If you change either emitter, that test
// fails — which is the point. Contract:
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
    ui: resolveFontFamily(document, 'sem.font.family.ui', mode),
    mono: resolveFontFamily(document, 'sem.font.family.mono', mode),
  }
}

/**
 * Resolve one `fontFamily` token to a CSS family list.
 *
 * DTCG `fontFamily` values are ARRAYS (`["Inter", "SF Pro Text", …]`), not
 * strings, so `resolveTokenValue` — which is about single values — cannot read
 * them. Joining follows the same rule the bundle's own generator uses: comma
 * separated, quoting any family whose name contains whitespace.
 */
function resolveFontFamily(
  document: unknown,
  path: string,
  mode: DesignSystemTokenMode,
): string | null {
  if (!isRecord(document)) return null
  const leaf = leafAt(document, path)
  if (!leaf) return null
  const raw = rawValueForMode(leaf, mode)
  if (typeof raw === 'string') {
    // A string value may still be an alias to another family token.
    return resolveTokenValue(document, path, mode)
  }
  if (!Array.isArray(raw)) return null
  const families = raw.filter((entry): entry is string => typeof entry === 'string')
  if (families.length === 0) return null
  return families.map((family) => (/\s/.test(family) ? `"${family}"` : family)).join(', ')
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

// ── Emission ─────────────────────────────────────────────────────────────────
// Byte-identical to `resources/design-system/templates/scripts/build-tokens.mjs`,
// held by a drift test. Emission contract, restated so a reader need not diff
// the two: one custom property per token (`--` + path with `.` → `-`); `:root`
// carries every token at its light/default `$value`; `[data-mode="dark"]`
// re-declares only tokens whose `modes.dark` differs from `modes.light`; aliases
// emit `var(--target)`; `fontFamily` arrays join with commas, quoting entries
// containing whitespace.

const EMIT_ALIAS_PATTERN = /^\{([a-z0-9.-]+)\}$/

interface CollectedToken {
  path: string
  node: Record<string, unknown>
}

function collectTokens(
  node: unknown,
  path: string[],
  out: CollectedToken[],
): CollectedToken[] {
  if (!isRecord(node)) return out
  if ('$value' in node) {
    out.push({ path: path.join('.'), node })
    return out
  }
  for (const [key, child] of Object.entries(node)) collectTokens(child, [...path, key], out)
  return out
}

function cssVariableName(tokenPath: string): string {
  return `--${tokenPath.replace(/\./g, '-')}`
}

function modesOf(token: CollectedToken): Record<string, unknown> | null {
  const extensions = token.node.$extensions
  if (!isRecord(extensions)) return null
  const vendor = extensions[VENDOR_KEY]
  if (!isRecord(vendor)) return null
  return isRecord(vendor.modes) ? vendor.modes : null
}

export interface EmitTokensCssResult {
  /** The `:root` + `[data-mode="dark"]` blocks, with the generator's header. */
  css: string
  /**
   * Tokens the bundle's own generator would REFUSE (missing `$type`, an alias
   * to nothing, a `$value` form the contract does not cover). Reported rather
   * than thrown: the door renders what it can and says what it could not read,
   * because refusing to draw a bundle is the author's gate, not a viewer's.
   */
  problems: string[]
}

/**
 * Emit a bundle's token document as CSS custom properties.
 *
 * Unlike the bundle's generator this never throws and never writes. A token the
 * generator would reject is skipped and named in `problems`, so one malformed
 * token costs its own variable rather than the whole preview.
 */
export function emitTokensCss(document: unknown): EmitTokensCssResult {
  const problems: string[] = []
  const tokens = collectTokens(document, [], [])
  if (tokens.length === 0) {
    return { css: '', problems: ['foundations/tokens.tokens.json contains no tokens'] }
  }
  const tokenPaths = new Set(tokens.map((token) => token.path))

  const emitValue = (tokenPath: string, value: unknown): string | null => {
    if (typeof value === 'string') {
      const alias = EMIT_ALIAS_PATTERN.exec(value)
      if (alias) {
        if (!tokenPaths.has(alias[1])) {
          problems.push(`${tokenPath}: alias ${value} resolves to no token`)
          return null
        }
        return `var(${cssVariableName(alias[1])})`
      }
      return value
    }
    if (typeof value === 'number') return String(value)
    if (Array.isArray(value)) {
      const parts: string[] = []
      for (const item of value) {
        if (typeof item !== 'string') {
          problems.push(`${tokenPath}: fontFamily entries must be strings`)
          return null
        }
        parts.push(/\s/.test(item) ? `"${item}"` : item)
      }
      return parts.join(', ')
    }
    problems.push(`${tokenPath}: unsupported $value form`)
    return null
  }

  const darkOverrides: Array<{ token: CollectedToken; darkValue: unknown }> = []
  for (const token of tokens) {
    if (typeof token.node.$type !== 'string' || token.node.$type.length === 0) {
      problems.push(`${token.path}: missing explicit $type`)
    }
    if (token.node.$value === undefined) problems.push(`${token.path}: missing $value`)
    const modes = modesOf(token)
    if (!modes) continue
    if (!('light' in modes) || !('dark' in modes)) {
      problems.push(`${token.path}: modes must declare exactly light and dark`)
      continue
    }
    if (JSON.stringify(modes.light) !== JSON.stringify(token.node.$value)) {
      problems.push(`${token.path}: modes.light must equal $value (light is the default mode)`)
    }
    if (JSON.stringify(modes.dark) !== JSON.stringify(modes.light)) {
      darkOverrides.push({ token, darkValue: modes.dark })
    }
  }

  // The generator's header, verbatim — the drift test compares whole files.
  let css = `/* GENERATED FILE — do not edit by hand.
 * Derived from foundations/tokens.tokens.json by scripts/build-tokens.mjs.
 * Emission contract: knowledge/multicode/design-system-bundle.md.
 * :root carries the light (default) mode; [data-mode="dark"] overrides the
 * tokens whose values differ in dark mode. */
:root {
`
  for (const token of tokens) {
    const value = emitValue(token.path, token.node.$value)
    if (value === null) continue
    css += `  ${cssVariableName(token.path)}: ${value};\n`
  }
  css += '}\n[data-mode="dark"] {\n'
  for (const { token, darkValue } of darkOverrides) {
    const value = emitValue(token.path, darkValue)
    if (value === null) continue
    css += `  ${cssVariableName(token.path)}: ${value};\n`
  }
  css += '}\n'
  return { css, problems }
}
