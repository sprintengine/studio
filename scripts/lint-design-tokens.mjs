#!/usr/bin/env node
// Design-token forbidden-pattern guard for the shared UI redesign.
//
// Scope (intentional): every .tsx and .ts file under
// `src/renderer/src/components/` is scanned. The `__preview__` directory is
// review-only and excluded. The script enforces the rules below across the
// whole component tree so chrome stops accumulating raw colors and gradients
// as new panels and primitives land.
//
// Forbidden patterns inside the scanned files:
//   1. Inline hex color literals (`#abcdef`, `#abc`) in className strings and
//      style attributes. The token layer in src/renderer/src/assets/index.css
//      is the only place those should live.
//   2. Decorative uppercase-tracking chrome like `uppercase tracking-[0.08em]`
//      or `uppercase tracking-wider` used for normal labels.
//   3. CSS `radial-gradient(...)` usage anywhere in the scanned files. The
//      Shared redesign deletes radial decoration on hero, timeline, and
//      graph surfaces; use solid token-backed backgrounds instead.
//   4. Tailwind `bg-gradient-to-*` utilities. Hierarchy comes from typography,
//      spacing, and hairlines, not gradient chrome.
//   5. Hand-rolled inline status dots (`h-2 w-2 rounded-full`) that bypass
//      the canonical `src/renderer/src/components/ui/StatusDot.tsx` primitive.
//   6. `shadow-[0_*]` glow shadows with non-zero blur on operational chrome.
//   7. `no-statusdot-from-app-icons` — importing `StatusDot` from an
//      `AppIcons` module. The canonical primitive is `ui/StatusDot`; the
//      AppIcons re-export was deleted in T9 and must never come back.
//
// Two exception mechanisms exist; both must explain the carve-out:
//   * Per-line: a `// design-tokens-allow: <reason>` marker on the same line
//     or one of the two preceding lines.
//   * Per-file: an entry in `PATH_EXEMPTIONS` below that lists which rules
//     are exempt for the path. Each entry MUST carry an inline comment that
//     names the exception category (terminal ANSI / memory graph atmosphere
//     / brand SVG) and the file's role. Per the T12 implementation note, if
//     this list grows beyond `ALLOW_LIST_CEILING` entries, the script emits
//     a meta-finding rather than expanding silently — the redesign drains
//     hex from chrome, it does not catalogue it.
//
// Usage:
//   node scripts/lint-design-tokens.mjs            # fails (exit 1) if any violation
//   node scripts/lint-design-tokens.mjs --report   # never fails; report only
//
// The script prints `file:line:col  rule  matched text` for each finding plus
// a per-file summary so the Sprint Engine work logs can reference precise
// counts without re-running the script.

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { resolve, join, sep } from 'node:path'

const SCAN_ROOT = 'src/renderer/src/components'
const ALLOWED_EXT = new Set(['.tsx', '.ts'])
// Directories never linted; review-only surfaces.
const EXCLUDED_DIRS = new Set(['__preview__'])

// Per-file rule exemptions. Each entry MUST cite the exception category
// (a) terminal ANSI output, (b) memory graph atmosphere, or (c) brand SVG
// asset — and explain why the rule cannot apply. See plan §B of
// future-plans/2026-05-13-app-wide-linear-grade-audit.md.
const PATH_EXEMPTIONS = [
  {
    // (a) ANSI output path: xterm host. Hex literals are the xterm-256
    // palette and terminal cursor/selection colors, not Shared chrome.
    path: 'src/renderer/src/components/panels/PlainTerminalPanel.tsx',
    rules: ['no-inline-hex'],
  },
  {
    // (a) ANSI output path: xterm host. Hex literals are the xterm-256
    // palette and terminal cursor/selection colors, not Shared chrome.
    path: 'src/renderer/src/components/panels/TerminalView.tsx',
    rules: ['no-inline-hex'],
  },
  {
    // (b) Memory graph atmosphere: graph node-type palette plus direct canvas
    // paint colors, and the single canvas-scoped radial background var. Pinned
    // to knowledge/brand/aesthetic-north-star.md memory-graph exception.
    path: 'src/renderer/src/components/memory/MemoryGraphCanvas.tsx',
    rules: ['no-inline-hex', 'no-radial-gradient'],
  },
  {
    // (b) Memory graph atmosphere: GRAPH_PALETTE constant — paint colors for
    // node types, not chrome tokens.
    path: 'src/renderer/src/components/memory/memoryGraphTypes.ts',
    rules: ['no-inline-hex'],
  },
  {
    // (c) Brand SVG asset: identity colors live on the SVG path attributes.
    // See knowledge/brand/BRAND.md for the canonical wordmark/mark spec.
    path: 'src/renderer/src/components/brand/MulticodeMark.tsx',
    rules: ['no-inline-hex'],
  },
  {
    // (c) Brand SVG asset: identity colors live on the SVG path attributes.
    // See knowledge/brand/BRAND.md for the canonical wordmark/mark spec.
    path: 'src/renderer/src/components/brand/MulticodeWordmark.tsx',
    rules: ['no-inline-hex'],
  },
  {
    // (c) Brand SVG asset: identity colors live on the SVG path attributes.
    // See knowledge/brand/BRAND.md for the canonical wordmark/mark spec.
    path: 'src/renderer/src/components/brand/MulticodeSpinner.tsx',
    rules: ['no-inline-hex'],
  },
]

// Implementation-note guardrail: when the file-level allow-list exceeds this
// ceiling we emit a meta-finding so the architect sees the catalogue growth
// instead of silently shipping more exceptions. T12 calls this out by name.
const ALLOW_LIST_CEILING = 10

const ALLOW_MARKER = 'design-tokens-allow:'

// Match `#abc` or `#abcdef` only when used as a color literal. We require the
// `#` to be preceded by a non-word character so we do not match anchor IDs in
// URLs or markdown headings. Pure SVG `fill="#xxxxxx"` attributes are also
// flagged on purpose — icons in the component tree should use `currentColor`.
const HEX_LITERAL = /(?<![\w#])#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g

// Match `uppercase` followed (within ~30 chars on the same line) by a
// tracking utility — either `tracking-[…]` or `tracking-wider`/`tracking-widest`.
const UPPERCASE_TRACKING = /uppercase[^\n"`]{0,30}?tracking-(?:\[[^\]]+\]|wider|widest|wide)/g

// Match any `radial-gradient(...)` invocation — Tailwind arbitrary value,
// inline `style` string, or CSS-in-JS literal. The redesign removes radial
// decoration entirely.
const RADIAL_GRADIENT = /radial-gradient\s*\(/g

// Match `bg-gradient-to-` Tailwind utilities (`bg-gradient-to-r`,
// `bg-gradient-to-br`, etc.). The redesign uses solid backgrounds only.
const BG_GRADIENT_TO = /\bbg-gradient-to-[a-z]{1,3}\b/g

// Hand-rolled status-dot regression: any `h-2 w-2 rounded-full` or smaller
// inline dot pattern is a signal someone re-implemented StatusDot. The
// canonical primitive is `src/renderer/src/components/ui/StatusDot.tsx`.
const INLINE_STATUS_DOT = /\bh-(?:1\.5|2)\s+w-(?:1\.5|2)\s+(?:shrink-0\s+)?rounded-full\b/g

// `shadow-[0_*]` with a non-zero blur radius applied to a primary CTA is the
// "glow CTA" anti-pattern the redesign banned. Popover elevation reusing the
// OverflowMenu shadow is allowed via `design-tokens-allow:` markers.
// We match any non-zero-blur shadow string here; per-element classification
// (button vs popover) is delegated to manual review via the allow marker.
const GLOW_SHADOW = /shadow-\[0_[0-9]+(?:px)?_[0-9]+(?:px)?_/g

// no-statusdot-from-app-icons: catches every shape of `StatusDot` import that
// resolves back to the deleted `AppIcons` re-export, both named and aliased.
// The canonical primitive lives at `src/renderer/src/components/ui/StatusDot`.
const STATUSDOT_FROM_APP_ICONS =
  /import\s*(?:type\s+)?(?:\{[^}]*\bStatusDot\b[^}]*\}|StatusDot)\s*from\s*['"][^'"]*AppIcons[^'"]*['"]/g

const RULES = {
  hex: { regex: HEX_LITERAL, name: 'no-inline-hex' },
  tracking: { regex: UPPERCASE_TRACKING, name: 'no-uppercase-tracking' },
  radial: { regex: RADIAL_GRADIENT, name: 'no-radial-gradient' },
  gradient: { regex: BG_GRADIENT_TO, name: 'no-bg-gradient-to' },
  inlineDot: { regex: INLINE_STATUS_DOT, name: 'no-inline-status-dot' },
  glowShadow: { regex: GLOW_SHADOW, name: 'no-glow-shadow' },
}

const exemptionByPath = new Map()
for (const entry of PATH_EXEMPTIONS) {
  exemptionByPath.set(entry.path, new Set(entry.rules))
}

const args = new Set(process.argv.slice(2))
const REPORT_ONLY = args.has('--report')
const QUIET = args.has('--quiet')

function walkComponents(absoluteRoot, repoRoot) {
  const out = []
  if (!existsSync(absoluteRoot)) return out
  const entries = readdirSync(absoluteRoot, { withFileTypes: true })
  for (const entry of entries) {
    const full = join(absoluteRoot, entry.name)
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue
      out.push(...walkComponents(full, repoRoot))
    } else if (entry.isFile()) {
      const dot = entry.name.lastIndexOf('.')
      if (dot < 0) continue
      const ext = entry.name.slice(dot)
      if (!ALLOWED_EXT.has(ext)) continue
      const relative = full.slice(repoRoot.length + 1).split(sep).join('/')
      out.push(relative)
    }
  }
  return out
}

const repoRoot = process.cwd()
const scanRootAbs = resolve(repoRoot, SCAN_ROOT)
const TARGET_FILES = walkComponents(scanRootAbs, repoRoot).sort()

let totalViolations = 0
const perFile = []

for (const relativePath of TARGET_FILES) {
  const fullPath = resolve(repoRoot, relativePath)
  const source = readFileSync(fullPath, 'utf8')
  const lines = source.split('\n')
  const fileExemptRules = exemptionByPath.get(relativePath) ?? new Set()
  const counts = {
    hex: 0,
    tracking: 0,
    radial: 0,
    gradient: 0,
    inlineDot: 0,
    glowShadow: 0,
    statusdotFromAppIcons: 0,
  }
  const findings = []

  // File-scoped check for StatusDot-from-AppIcons. It is intentionally NOT
  // honourable via PATH_EXEMPTIONS — there is no legitimate reason to import
  // the deleted alias.
  STATUSDOT_FROM_APP_ICONS.lastIndex = 0
  let importMatch
  while ((importMatch = STATUSDOT_FROM_APP_ICONS.exec(source))) {
    counts.statusdotFromAppIcons += 1
    const upTo = source.slice(0, importMatch.index)
    const lineNumber = upTo.split('\n').length
    const lastNewline = upTo.lastIndexOf('\n')
    const column = importMatch.index - lastNewline
    findings.push({
      rule: 'no-statusdot-from-app-icons',
      line: lineNumber,
      column,
      text: importMatch[0].split('\n')[0],
    })
  }

  lines.forEach((line, index) => {
    if (line.includes(ALLOW_MARKER)) return
    // Accept a marker within the immediately preceding 2 lines — JSX className
    // strings cannot host `//` comments inline, so the conventional placement
    // is a JS comment one or two lines above the violating attribute (often
    // directly above the opening tag of a multi-line element). Two lines is
    // tight enough to keep markers visually adjacent to the violation.
    if (index > 0 && lines[index - 1].includes(ALLOW_MARKER)) return
    if (index > 1 && lines[index - 2].includes(ALLOW_MARKER)) return
    const lineNumber = index + 1

    for (const [key, rule] of Object.entries(RULES)) {
      if (fileExemptRules.has(rule.name)) continue
      rule.regex.lastIndex = 0
      let match
      while ((match = rule.regex.exec(line))) {
        counts[key] += 1
        findings.push({
          rule: rule.name,
          line: lineNumber,
          column: match.index + 1,
          text: match[0],
        })
      }
    }
  })

  const fileTotal =
    counts.hex +
    counts.tracking +
    counts.radial +
    counts.gradient +
    counts.inlineDot +
    counts.glowShadow +
    counts.statusdotFromAppIcons
  perFile.push({ path: relativePath, counts, total: fileTotal })
  totalViolations += fileTotal

  if (!QUIET && findings.length > 0) {
    findings.sort((a, b) => a.line - b.line || a.column - b.column)
    process.stdout.write(`\n${relativePath}\n`)
    for (const finding of findings) {
      process.stdout.write(
        `  ${finding.line}:${finding.column}  ${finding.rule}  ${finding.text}\n`,
      )
    }
  }
}

// Per T12 implementation note: when the file-level allow-list outgrows the
// documented ceiling, surface it as a meta-finding so the architect notices.
let metaViolations = 0
if (PATH_EXEMPTIONS.length > ALLOW_LIST_CEILING) {
  metaViolations = 1
  process.stdout.write(
    `\n[meta] PATH_EXEMPTIONS has ${PATH_EXEMPTIONS.length} entries; ` +
      `documented ceiling is ${ALLOW_LIST_CEILING}. ` +
      'Drain chrome rather than allow-list it.\n',
  )
}

process.stdout.write('\nDesign-token guard summary\n')
process.stdout.write(`  scope: ${SCAN_ROOT} (recursive, .tsx/.ts, ${TARGET_FILES.length} files)\n`)
process.stdout.write(
  `  allow-list: ${PATH_EXEMPTIONS.length}/${ALLOW_LIST_CEILING} file-level exemptions\n`,
)
const dirty = perFile.filter((entry) => entry.total > 0)
if (!QUIET) {
  for (const entry of dirty) {
    const { hex, tracking, radial, gradient, inlineDot, glowShadow, statusdotFromAppIcons } =
      entry.counts
    process.stdout.write(
      `  ${entry.path}: hex=${hex} uppercase-tracking=${tracking} radial-gradient=${radial} bg-gradient-to=${gradient} inline-status-dot=${inlineDot} glow-shadow=${glowShadow} statusdot-from-app-icons=${statusdotFromAppIcons}\n`,
    )
  }
}
process.stdout.write(`Total violations: ${totalViolations}\n`)

if (totalViolations > 0) {
  process.stdout.write(
    '\nFix by reading colors from CSS variables in src/renderer/src/assets/index.css,\n' +
      'dropping uppercase tracking chrome in favor of sentence-case labels,\n' +
      'replacing radial-gradient / bg-gradient-to-* decoration with solid\n' +
      'token-backed backgrounds, and reusing the ui/StatusDot primitive\n' +
      'instead of the deleted AppIcons re-export. Document intentional\n' +
      'exceptions with `// design-tokens-allow: <reason>` on the same line\n' +
      'or in PATH_EXEMPTIONS with a category-naming comment.\n',
  )
}

// CI safety: if the component tree is missing entirely (wrong cwd or the
// folder was renamed) the guard would otherwise silently pass with zero
// violations. Fail explicitly so misconfiguration is visible.
if (TARGET_FILES.length === 0) {
  process.stdout.write(
    `\nNo component files found under ${SCAN_ROOT}. Run this from the repo\n` +
      'root or update SCAN_ROOT in scripts/lint-design-tokens.mjs if the\n' +
      'component tree moved.\n',
  )
  process.exit(2)
}

const exitCode = !REPORT_ONLY && totalViolations + metaViolations > 0 ? 1 : 0
process.exit(exitCode)
