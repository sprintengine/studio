#!/usr/bin/env node
// Primitive-duplication guard for the shared UI redesign.
//
// Five rules, each of which fires with a clear message that names the
// offending file and the canonical replacement. The renderer tree is the
// scope; node_modules, build output, and __preview__ surfaces are excluded.
//
//   (a) no-duplicate-statusdot — only one `export function StatusDot` may
//       exist in the renderer. The canonical primitive lives at
//       `src/renderer/src/components/ui/StatusDot.tsx`. AppIcons.StatusDot
//       was deleted in T9; re-introducing a sibling export is a regression.
//
//   (b) no-native-select — bare `<select>` elements are forbidden outside an
//       explicit allow-list. Use `ui/Select` instead, which is keyboard-
//       complete and tone-correct. Allow-list entries are kept inline here;
//       each entry MUST carry a comment pointing to the Phase D consumer
//       task that will migrate it.
//
//   (c) no-radial-gradient — `radial-gradient(...)` is reserved for the
//       memory graph canvas. Anywhere else, hierarchy comes from typography,
//       spacing, and hairlines, not radial decoration.
//
//   (d) no-statusdot-from-app-icons — importing `StatusDot` from any module
//       whose path includes `AppIcons` re-creates the deleted alias. Import
//       from `ui/StatusDot` instead. Matches T12's design-token rule of the
//       same name; duplicated here so this guard is self-contained.
//
//   (e) no-hand-rolled-task-card — `<li>` or `<article>` elements that wear
//       the canonical TaskCard signature (the `data-task-card` data
//       attribute, or the `border-l-2 + rounded-[5px]` class combo on a card
//       tag) outside `src/renderer/src/components/ui/TaskCard.tsx`. Use the
//       `ui/TaskCard` primitive instead; the variants `row` and `card`
//       already cover both layouts the four panels need.
//
// Usage:
//   node scripts/lint-primitive-duplication.mjs            # fails on any violation
//   node scripts/lint-primitive-duplication.mjs --report   # never fails; report only
//   node scripts/lint-primitive-duplication.mjs --quiet    # summary lines only

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { resolve, join, sep } from 'node:path'

const SCAN_ROOT = 'src/renderer/src'
const ALLOWED_EXT = new Set(['.tsx', '.ts'])
// Review-only surface, plus build output that may leak into a worktree.
const EXCLUDED_DIRS = new Set(['__preview__', 'node_modules', 'dist', 'out'])

// Canonical primitive paths. Detection rules below honour them.
const TASKCARD_PATH = 'src/renderer/src/components/ui/TaskCard.tsx'
const STATUSDOT_PATH = 'src/renderer/src/components/ui/StatusDot.tsx'
// Memory graph atmosphere exception: pinned to exactly this canvas file per
// knowledge/brand/aesthetic-north-star.md memory-graph exception.
const MEMORY_CANVAS_PATH = 'src/renderer/src/components/memory/MemoryGraphCanvas.tsx'

// Native <select> allow-list. Each entry MUST carry a comment pointing to
// the Phase D consumer task that will migrate this surface to `ui/Select`.
// Adding an entry without a migration owner is a code review reject.
const NATIVE_SELECT_ALLOW = [
  {
    // Phase D — Settings migration: large surface with many native selects;
    // architect plan §D.Settings owns the migration to ui/Select.
    path: 'src/renderer/src/components/settings/SettingsPanel.tsx',
  },
  {
    // Phase D — NewWorkspace migration: provider / role / template pickers
    // live here; migration owner is the NewWorkspace Phase D task.
    path: 'src/renderer/src/components/workspace/NewWorkspacePanel.tsx',
  },
  {
    // Phase D — NewWorkspace roster: agent role + model pickers inside the
    // roster table; migrated alongside NewWorkspacePanel.
    path: 'src/renderer/src/components/workspace/newWorkspace/SprintEngineRosterTable.tsx',
  },
  {
    // Phase D — Worktree migration: branch and base-branch pickers; owned by
    // the Worktree manager Phase D task.
    path: 'src/renderer/src/components/worktree/WorktreeManager.tsx',
  },
  {
    // Phase D — Git diff base picker: native select on diff-base controls
    // inside GitPanel; migrated with the Git Phase D task.
    path: 'src/renderer/src/components/panels/GitPanel.tsx',
  },
  {
    // Phase D — Switchboard panel: workspace + provider selects in the run
    // composer; migrated alongside SwitchboardBoardPanel's Phase D pass.
    path: 'src/renderer/src/components/panels/SwitchboardBoardPanel.tsx',
  },
  {
    // Phase D — Watchtower panel: tail-window picker; migrated alongside
    // WatchtowerPanel's Phase D pass.
    path: 'src/renderer/src/components/panels/WatchtowerPanel.tsx',
  },
  {
    // Phase D — Sprint Engine board: roster / role pickers in the board
    // header; migrated alongside SprintEngineBoardPanel's Phase D pass.
    path: 'src/renderer/src/components/panels/SprintEngineBoardPanel.tsx',
  },
  {
    // Phase D — Multiloop board: loop / agent pickers in the composer;
    // migrated alongside MultiloopBoardPanel's Phase D pass.
    path: 'src/renderer/src/components/panels/MultiloopBoardPanel.tsx',
  },
]

const nativeSelectAllow = new Set(NATIVE_SELECT_ALLOW.map((entry) => entry.path))

const args = new Set(process.argv.slice(2))
const REPORT_ONLY = args.has('--report')
const QUIET = args.has('--quiet')

// --- Patterns ---

// (a) `export function StatusDot` — counted across files. More than one means
// a duplicate primitive exists somewhere.
const STATUSDOT_EXPORT = /^\s*export\s+function\s+StatusDot\b/m

// (b) native <select> element — opening tag with a word boundary so we do
// not match `<selection`, `<selected`, etc. We deliberately accept both
// `<select>` and `<select ...>`.
const NATIVE_SELECT = /<select\b/g

// (c) any `radial-gradient(...)` call.
const RADIAL_GRADIENT = /radial-gradient\s*\(/g

// (d) StatusDot imported from any module whose path includes AppIcons.
// Mirrors the T12 design-token rule of the same name.
const STATUSDOT_FROM_APP_ICONS =
  /import\s*(?:type\s+)?(?:\{[^}]*\bStatusDot\b[^}]*\}|StatusDot)\s*from\s*['"][^'"]*AppIcons[^'"]*['"]/g

// (e) hand-rolled task-card shapes. Two complementary detectors:
//   - data-task-card attribute outside TaskCard.tsx — the explicit marker.
//   - <li or <article opening tag whose className (single or template
//     string, possibly multi-line) contains both `border-l-2` and
//     `rounded-[5px]` — the canonical visual signature. Tags whose body
//     also contains `border-transparent` are excluded: a transparent left
//     border is by definition not a tone-indicating identifier strip, so
//     the shape is a layout-reservation skeleton, not a real task card.
const TASKCARD_DATA_ATTR = /\bdata-task-card\b/g
const TASKCARD_TAG_OPEN = /<(li|article)\b/g

function walk(absoluteRoot, repoRoot) {
  const out = []
  if (!existsSync(absoluteRoot)) return out
  const entries = readdirSync(absoluteRoot, { withFileTypes: true })
  for (const entry of entries) {
    const full = join(absoluteRoot, entry.name)
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue
      out.push(...walk(full, repoRoot))
    } else if (entry.isFile()) {
      const dot = entry.name.lastIndexOf('.')
      if (dot < 0) continue
      const ext = entry.name.slice(dot)
      if (!ALLOWED_EXT.has(ext)) continue
      // Test files describe primitives by name; they intentionally reference
      // marker attributes and class signatures as assertion needles. They do
      // not construct UI, so exempt them from primitive-duplication checks.
      if (entry.name.includes('.test.')) continue
      const relative = full.slice(repoRoot.length + 1).split(sep).join('/')
      out.push(relative)
    }
  }
  return out
}

const repoRoot = process.cwd()
const scanRootAbs = resolve(repoRoot, SCAN_ROOT)
const FILES = walk(scanRootAbs, repoRoot).sort()

if (FILES.length === 0) {
  process.stdout.write(
    `No renderer files found under ${SCAN_ROOT}. Run this from the repo root\n` +
      'or update SCAN_ROOT in scripts/lint-primitive-duplication.mjs if the\n' +
      'renderer source tree moved.\n',
  )
  process.exit(2)
}

const findings = []

function recordFinding({ rule, path, line, column, match, canonical }) {
  findings.push({ rule, path, line, column, match, canonical })
}

function locationOf(source, offset) {
  const upTo = source.slice(0, offset)
  const lineNumber = upTo.split('\n').length
  const lastNewline = upTo.lastIndexOf('\n')
  const column = offset - lastNewline
  return { line: lineNumber, column }
}

// Track files that export StatusDot for rule (a).
const statusdotExporters = []

for (const path of FILES) {
  const full = resolve(repoRoot, path)
  const source = readFileSync(full, 'utf8')

  // (a) Note any file that re-exports `function StatusDot`. Rule fires after
  // the loop once we know the total count.
  if (STATUSDOT_EXPORT.test(source)) {
    statusdotExporters.push(path)
  }

  // (b) Native <select> elements outside the allow-list.
  if (!nativeSelectAllow.has(path)) {
    NATIVE_SELECT.lastIndex = 0
    let match
    while ((match = NATIVE_SELECT.exec(source))) {
      const { line, column } = locationOf(source, match.index)
      recordFinding({
        rule: 'no-native-select',
        path,
        line,
        column,
        match: match[0],
        canonical: "use ui/Select from 'src/renderer/src/components/ui/Select.tsx'",
      })
    }
  }

  // (c) radial-gradient outside the memory graph canvas.
  if (path !== MEMORY_CANVAS_PATH) {
    RADIAL_GRADIENT.lastIndex = 0
    let match
    while ((match = RADIAL_GRADIENT.exec(source))) {
      const { line, column } = locationOf(source, match.index)
      recordFinding({
        rule: 'no-radial-gradient',
        path,
        line,
        column,
        match: match[0],
        canonical: 'use solid token-backed backgrounds; radial-gradient is memory-canvas-only',
      })
    }
  }

  // (d) StatusDot imported from AppIcons.
  STATUSDOT_FROM_APP_ICONS.lastIndex = 0
  let importMatch
  while ((importMatch = STATUSDOT_FROM_APP_ICONS.exec(source))) {
    const { line, column } = locationOf(source, importMatch.index)
    recordFinding({
      rule: 'no-statusdot-from-app-icons',
      path,
      line,
      column,
      match: importMatch[0].split('\n')[0],
      canonical: "import { StatusDot } from '.../components/ui/StatusDot'",
    })
  }

  // (e) Hand-rolled task-card shapes outside TaskCard.tsx.
  if (path !== TASKCARD_PATH) {
    TASKCARD_DATA_ATTR.lastIndex = 0
    let attrMatch
    while ((attrMatch = TASKCARD_DATA_ATTR.exec(source))) {
      const { line, column } = locationOf(source, attrMatch.index)
      recordFinding({
        rule: 'no-hand-rolled-task-card',
        path,
        line,
        column,
        match: attrMatch[0],
        canonical: 'use ui/TaskCard (variant="row" | "card")',
      })
    }
    // Class-signature backup: a card-shape tag whose className contains both
    // the canonical border rail and radius. We inspect a small window after
    // the opening tag so we catch multi-line className attributes.
    TASKCARD_TAG_OPEN.lastIndex = 0
    let tagMatch
    while ((tagMatch = TASKCARD_TAG_OPEN.exec(source))) {
      const start = tagMatch.index
      // Look ahead up to 400 characters or until the tag closes, whichever
      // comes first. Multi-line className strings rarely span more than that.
      const lookahead = source.slice(start, start + 400)
      const tagEnd = lookahead.indexOf('>')
      const tagBody = tagEnd > 0 ? lookahead.slice(0, tagEnd) : lookahead
      if (
        tagBody.includes('border-l-2') &&
        tagBody.includes('rounded-[5px]') &&
        !tagBody.includes('border-transparent')
      ) {
        const { line, column } = locationOf(source, start)
        recordFinding({
          rule: 'no-hand-rolled-task-card',
          path,
          line,
          column,
          match: `<${tagMatch[1]} ... border-l-2 rounded-[5px]>`,
          canonical: 'use ui/TaskCard (variant="row" | "card")',
        })
      }
    }
  }
}

// (a) Rule check after walking the tree.
if (statusdotExporters.length > 1) {
  for (const path of statusdotExporters) {
    if (path === STATUSDOT_PATH) continue
    recordFinding({
      rule: 'no-duplicate-statusdot',
      path,
      line: 1,
      column: 1,
      match: 'export function StatusDot',
      canonical: `delete duplicate; canonical primitive is ${STATUSDOT_PATH}`,
    })
  }
} else if (statusdotExporters.length === 1 && statusdotExporters[0] !== STATUSDOT_PATH) {
  // Exactly one export but in the wrong file — still a duplicate-shaped
  // problem because someone moved the primitive away from its canonical
  // location.
  recordFinding({
    rule: 'no-duplicate-statusdot',
    path: statusdotExporters[0],
    line: 1,
    column: 1,
    match: 'export function StatusDot',
    canonical: `move primitive back to ${STATUSDOT_PATH}`,
  })
}

// --- Reporting ---

const findingsByRule = new Map()
for (const finding of findings) {
  const key = finding.rule
  if (!findingsByRule.has(key)) findingsByRule.set(key, [])
  findingsByRule.get(key).push(finding)
}

if (!QUIET && findings.length > 0) {
  for (const [rule, items] of findingsByRule) {
    process.stdout.write(`\n[${rule}] ${items.length} finding(s)\n`)
    items.sort(
      (a, b) =>
        a.path.localeCompare(b.path) || a.line - b.line || a.column - b.column,
    )
    for (const item of items) {
      process.stdout.write(
        `  ${item.path}:${item.line}:${item.column}  ${item.match}\n` +
          `    canonical: ${item.canonical}\n`,
      )
    }
  }
}

process.stdout.write('\nPrimitive-duplication guard summary\n')
process.stdout.write(`  scope: ${SCAN_ROOT} (recursive, .tsx/.ts, ${FILES.length} files)\n`)
process.stdout.write(
  `  no-native-select allow-list: ${NATIVE_SELECT_ALLOW.length} consumer file(s) pending Phase D migration\n`,
)
const ruleOrder = [
  'no-duplicate-statusdot',
  'no-native-select',
  'no-radial-gradient',
  'no-statusdot-from-app-icons',
  'no-hand-rolled-task-card',
]
for (const rule of ruleOrder) {
  const count = findingsByRule.get(rule)?.length ?? 0
  process.stdout.write(`  ${rule}: ${count}\n`)
}
process.stdout.write(`Total violations: ${findings.length}\n`)

if (findings.length > 0) {
  process.stdout.write(
    '\nFix by importing the canonical primitive instead of re-implementing it:\n' +
      '  - ui/StatusDot for tone-coloured status indicators\n' +
      '  - ui/Select for tone-correct picker controls\n' +
      '  - ui/TaskCard (variant="row" | "card") for task list/board items\n' +
      'Confine radial-gradient to the memory graph canvas. Delete any\n' +
      'AppIcons.StatusDot re-export; it was removed in T9 and should never\n' +
      'come back.\n',
  )
}

const exitCode = !REPORT_ONLY && findings.length > 0 ? 1 : 0
process.exit(exitCode)
