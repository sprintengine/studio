#!/usr/bin/env node
// Design-token forbidden-pattern guard for the shared UI redesign.
//
// Scope (intentional): only the four target panel files that the redesign
// rebuilds. Other panels, the token file, the primitive set, and SVG icon
// modules are out of scope. As panels are rebuilt against the shared tokens
// and primitives, their violation counts must trend to zero.
//
// Forbidden patterns inside the targeted files:
//   1. Inline hex color literals (`#abcdef`, `#abc`) in className strings and
//      style attributes. The token layer in src/renderer/src/assets/index.css
//      is the only place those should live.
//   2. Decorative uppercase-tracking chrome like `uppercase tracking-[0.08em]`
//      or `uppercase tracking-wider` used for normal labels.
//   3. CSS `radial-gradient(...)` usage anywhere in the panel files. The
//      Shared redesign deletes radial decoration on hero, timeline, and
//      graph surfaces; use solid token-backed backgrounds instead.
//   4. Tailwind `bg-gradient-to-*` utilities. Hierarchy comes from typography,
//      spacing, and hairlines, not gradient chrome.
//
// Documented exceptions are tracked inline with `// design-tokens-allow:` on
// the same line. Use sparingly and explain why (e.g. icon SVG fill, popover
// elevation reusing the OverflowMenu primitive shadow).
//
// Usage:
//   node scripts/lint-design-tokens.mjs            # fails (exit 1) if any violation
//   node scripts/lint-design-tokens.mjs --report   # never fails; report only
//
// The script prints `file:line:col  rule  matched text` for each finding plus
// a per-file summary so the Sprint Engine work logs can reference precise
// counts without re-running the script.

import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const TARGET_FILES = [
  'src/renderer/src/components/panels/SwitchboardBoardPanel.tsx',
  'src/renderer/src/components/panels/WatchtowerPanel.tsx',
  'src/renderer/src/components/panels/SprintEngineBoardPanel.tsx',
  'src/renderer/src/components/panels/MultiloopBoardPanel.tsx',
]

const ALLOW_MARKER = 'design-tokens-allow:'

// Match `#abc` or `#abcdef` only when used as a color literal. We require the
// `#` to be preceded by a non-word character so we do not match anchor IDs in
// URLs or markdown headings. Pure SVG `fill="#xxxxxx"` attributes are also
// flagged on purpose — icons in the panel files should use `currentColor`.
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

const args = new Set(process.argv.slice(2))
const REPORT_ONLY = args.has('--report')
const QUIET = args.has('--quiet')

let totalViolations = 0
const perFile = []

for (const relativePath of TARGET_FILES) {
  const fullPath = resolve(process.cwd(), relativePath)
  if (!existsSync(fullPath)) {
    perFile.push({ path: relativePath, missing: true, hex: 0, tracking: 0, radial: 0, gradient: 0 })
    continue
  }
  const source = readFileSync(fullPath, 'utf8')
  const lines = source.split('\n')
  let hexCount = 0
  let trackingCount = 0
  let radialCount = 0
  let gradientCount = 0
  const findings = []

  lines.forEach((line, index) => {
    if (line.includes(ALLOW_MARKER)) return
    const lineNumber = index + 1
    let match
    HEX_LITERAL.lastIndex = 0
    while ((match = HEX_LITERAL.exec(line))) {
      hexCount += 1
      findings.push({
        rule: 'no-inline-hex',
        line: lineNumber,
        column: match.index + 1,
        text: match[0],
      })
    }
    UPPERCASE_TRACKING.lastIndex = 0
    while ((match = UPPERCASE_TRACKING.exec(line))) {
      trackingCount += 1
      findings.push({
        rule: 'no-uppercase-tracking',
        line: lineNumber,
        column: match.index + 1,
        text: match[0],
      })
    }
    RADIAL_GRADIENT.lastIndex = 0
    while ((match = RADIAL_GRADIENT.exec(line))) {
      radialCount += 1
      findings.push({
        rule: 'no-radial-gradient',
        line: lineNumber,
        column: match.index + 1,
        text: match[0],
      })
    }
    BG_GRADIENT_TO.lastIndex = 0
    while ((match = BG_GRADIENT_TO.exec(line))) {
      gradientCount += 1
      findings.push({
        rule: 'no-bg-gradient-to',
        line: lineNumber,
        column: match.index + 1,
        text: match[0],
      })
    }
  })

  perFile.push({
    path: relativePath,
    missing: false,
    hex: hexCount,
    tracking: trackingCount,
    radial: radialCount,
    gradient: gradientCount,
  })
  totalViolations += hexCount + trackingCount + radialCount + gradientCount

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

process.stdout.write('\nDesign-token guard summary\n')
let missingCount = 0
for (const entry of perFile) {
  if (entry.missing) {
    missingCount += 1
    process.stdout.write(`  ${entry.path}: MISSING (skipped)\n`)
    continue
  }
  process.stdout.write(
    `  ${entry.path}: hex=${entry.hex} uppercase-tracking=${entry.tracking} radial-gradient=${entry.radial} bg-gradient-to=${entry.gradient}\n`,
  )
}
process.stdout.write(`Total violations: ${totalViolations}\n`)

if (totalViolations > 0) {
  process.stdout.write(
    '\nFix by reading colors from CSS variables in src/renderer/src/assets/index.css,\n' +
      'dropping uppercase tracking chrome in favor of sentence-case labels, and\n' +
      'replacing radial-gradient / bg-gradient-to-* decoration with solid\n' +
      'token-backed backgrounds. Document intentional exceptions with\n' +
      '`// design-tokens-allow: <reason>` on the same line.\n',
  )
}

// CI safety: if every target file is missing (wrong cwd, files renamed, or the
// targeted panels were deleted) the guard would otherwise silently pass with
// zero violations. Fail explicitly so misconfiguration is visible.
if (missingCount === TARGET_FILES.length) {
  process.stdout.write(
    '\nAll target panel files are missing. Run this from the repository root\n' +
      'or update TARGET_FILES in scripts/lint-design-tokens.mjs if panels moved.\n',
  )
  process.exit(2)
}

const exitCode = !REPORT_ONLY && totalViolations > 0 ? 1 : 0
process.exit(exitCode)
