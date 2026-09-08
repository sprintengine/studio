#!/usr/bin/env node
// Primitive-duplication guard for the shared UI redesign.
//
// Six rules, each of which fires with a clear message that names the
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
//       attribute, or the `border-l-2 + rounded-sm` class combo on a card
//       tag) outside `src/renderer/src/components/ui/TaskCard.tsx`. Use the
//       `ui/TaskCard` primitive instead; the variants `row` and `card`
//       already cover both layouts the four panels need.
//
//   (f) no-bespoke-popover-shell — `popover-enter` anchored shell classes
//       outside the canonical Popover/Tooltip primitives are forbidden. Use
//       `ui/Popover` for interactive anchored menus, listboxes, and dialog
//       popovers. Existing graph overlay debt is baselined so new shells fail.
//
//   (g) no-bespoke-absolute-popover-role — `<div role="listbox|menu|dialog"
//       className="…absolute…">` opening tags outside the canonical Popover /
//       OverflowMenu / Select primitives. Catches the broader bespoke shell
//       pattern that bypasses the popover-enter-only detector — a hand-rolled
//       anchored ARIA-role surface is functionally a popover regardless of
//       whether the consumer pulled in the popover-enter animation. Per-line
//       `primitive-duplication-allow:` markers honour documented exemptions
//       (e.g. nested chip-listbox inside a Popover-managed parent that
//       handles outside-click upstream).
//
//   (h) no-raw-primitive — a raw `<button>`, `<input>` or `<textarea>` in
//       product code. Each of those tags has a design-system component
//       (`design-system/components/button`, `/input`, `/field`) and a kit
//       primitive that implements it (`ui/Buttons`, `ui/Input`, `ui/Textarea`,
//       `ui/Checkbox`, `ui/Switch`). Writing the bare element instead is how a
//       focus ring, a control height, a disabled tone and a radius get decided
//       one more time, privately, in a file nobody will look at again.
//
//       This is the rule that answers "what stops a NEW raw UI element?".
//       Every other rule in this file names a shape someone already
//       hand-rolled; this one names the shapes the system ships and refuses a
//       new hand-rolled instance of any of them.
//
//       It is a RATCHET, not a sweep: `scripts/design-system-conformance/`
//       `raw-primitives.json` carries the measured per-area count of the raw
//       elements that predate the rule, in the same per-directory shape (and
//       for the same reason) as the `designSystemAxes` ratchet. An area over
//       its number fails; an AREA THAT IS NOT IN THE FILE AT ALL fails on its
//       first raw element, so no new surface gets in. An area UNDER its number
//       fails too, naming the number to write instead — a baseline left high
//       after a drain is a parking space for the next regression, which is the
//       one thing a ratchet must not become.
//
//       There is deliberately NO per-line marker for this rule. A marker would
//       be exactly the escape hatch the gate exists to close: the route for a
//       new UI element is the design system — a spec under
//       `design-system/components/<name>/` plus the primitive under
//       `src/renderer/src/components/ui/` — or a change to one that is already
//       there. `--update-baseline` rewrites the file, but only ever downward:
//       it refuses to run when any area grew.
//
// Usage:
//   node scripts/lint-primitive-duplication.mjs            # fails on any violation
//   node scripts/lint-primitive-duplication.mjs --report   # never fails; report only
//   node scripts/lint-primitive-duplication.mjs --quiet    # summary lines only
//   node scripts/lint-primitive-duplication.mjs --update-baseline
//                                       # rewrite the raw-primitive ratchet
//                                       # DOWNWARD; refuses if anything grew

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { resolve, join, sep } from 'node:path'

const SCAN_ROOT = 'src/renderer/src'
const ALLOWED_EXT = new Set(['.tsx', '.ts'])
// Review-only surface, plus build output that may leak into a worktree.
const EXCLUDED_DIRS = new Set(['__preview__', 'node_modules', 'dist', 'out'])

// Canonical primitive paths. Detection rules below honour them.
const TASKCARD_PATH = 'src/renderer/src/components/ui/TaskCard.tsx'
// BoardLane is the canonical consumer of the TaskCard `data-task-card`
// attribute — it queries the rendered DOM at drag-over time to compute the
// drop index. The lint exempts BoardLane for the same reason it exempts
// TaskCard itself: this is a primitive-to-primitive contract, not a
// hand-rolled card.
const BOARDLANE_PATH = 'src/renderer/src/components/ui/BoardLane.tsx'
const STATUSDOT_PATH = 'src/renderer/src/components/ui/StatusDot.tsx'
const POPOVER_PATH = 'src/renderer/src/components/ui/Popover.tsx'
const TOOLTIP_PATH = 'src/renderer/src/components/ui/Tooltip.tsx'
// The Drawer primitive itself renders `<div role="dialog" className="…absolute…">`
// for its panel — that's exactly the shape rule (g) flags, so the canonical
// primitive needs to be exempt.
const DRAWER_PATH = 'src/renderer/src/components/ui/Drawer.tsx'
// Memory graph atmosphere exception: pinned to exactly this canvas file — the
// graph is an atmospheric surface, not chrome.
const MEMORY_CANVAS_PATH = 'src/renderer/src/components/memory/MemoryGraphCanvas.tsx'

// Native <select> allow-list — EMPTY, and it stays empty.
//
// It used to hold `settings/SettingsPanel.tsx`, pending a Settings migration to
// `ui/Select`. That migration landed: the file carries no `<select>` today. The
// entry outliving the debt it described is the failure mode this whole file is
// about — a per-FILE allow-list admits not just the control it was written for
// but every control added to that file afterwards, silently, forever. So the
// entry is gone rather than left at zero.
//
// If a native `<select>` is ever genuinely unavoidable, the answer is a change
// to `ui/Select`, not a name added back here.
const NATIVE_SELECT_ALLOW = []

const nativeSelectAllow = new Set(NATIVE_SELECT_ALLOW.map((entry) => entry.path))

// Existing non-primitive popover-enter uses that predate the final gate. This
// map must shrink as owning surfaces migrate to ui/Popover. T24 drained the
// last two entries (graph legend + minimap) by reclassifying them as inline
// disclosures (flow-positioned, no outside-click, no Escape) so the baseline
// is now empty: any new popover-enter outside Popover/Tooltip fails the guard.
const BESPOKE_POPOVER_BASELINE = new Map([])

// Documented exemption marker for rule (g). Honour per-line markers exactly
// like the design-token lint does: same-line or up to two preceding lines.
const PRIMITIVE_DUP_ALLOW_MARKER = 'primitive-duplication-allow:'

// (h) The kit is where a primitive is BUILT, so the raw tag is the point of it
// there. Everywhere else in the renderer the raw tag is a second button.
const KIT_DIR = 'src/renderer/src/components/ui/'
const RAW_PRIMITIVE_BASELINE_PATH = 'scripts/design-system-conformance/raw-primitives.json'

// Tag → the spec that already describes it, and the export that already
// implements it. Both halves are named in the finding on purpose: "use
// ui/Buttons" alone tells someone what to type, not what the system is.
const RAW_PRIMITIVES = [
  {
    tag: 'button',
    pattern: /<button\b/g,
    spec: 'design-system/components/button/',
    canonical: 'ui/Buttons — PrimaryButton | GhostButton | OutlineButton | IconButton | CloseIconButton',
  },
  {
    tag: 'input',
    pattern: /<input\b/g,
    spec: 'design-system/components/input/ (also checkbox/, switch/)',
    canonical: 'ui/Input, ui/Checkbox or ui/Switch',
  },
  {
    tag: 'textarea',
    pattern: /<textarea\b/g,
    spec: 'design-system/components/field/',
    canonical: 'ui/Textarea',
  },
]

const args = new Set(process.argv.slice(2))
const REPORT_ONLY = args.has('--report')
const QUIET = args.has('--quiet')
const UPDATE_BASELINE = args.has('--update-baseline')

// Comments are blanked before the raw-primitive scan. Without this, prose
// describing the rule counts as a violation of it — this file's own header
// would score three — so documenting a shape would make the shape look present
// and deleting the documentation would "fix" it. Same reason as the
// `designSystemAxes` ratchet, but LENGTH-PRESERVING: that one only counts,
// while this one reports a line and column, and collapsing a comment to one
// space shifts every offset after it.
function maskComments(source) {
  const blank = (text) => text.replace(/[^\n]/g, ' ')
  return source
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:])(\/\/[^\n]*)/g, (whole, before, comment) => before + blank(comment))
}

// The directory a count is attributed to: `components/<area>`, else the top
// segment. Per-area rather than per-file so that moving a file inside a surface
// is not a ratchet event; the axes ratchet attributes the same way.
function areaOf(path) {
  const parts = path.slice('src/renderer/src/'.length).split('/')
  if (parts[0] !== 'components') return parts[0]
  return parts.length > 1 ? `components/${parts[1]}` : 'components'
}

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
//     `rounded-sm` — the canonical visual signature. Tags whose body
//     also contains `border-transparent` are excluded: a transparent left
//     border is by definition not a tone-indicating identifier strip, so
//     the shape is a layout-reservation skeleton, not a real task card.
const TASKCARD_DATA_ATTR = /\bdata-task-card\b/g
const TASKCARD_TAG_OPEN = /<(li|article)\b/g
const POPOVER_ENTER = /\bpopover-enter\b/g

// (g) Bespoke absolute-shell + ARIA popover role pattern. The `[^>]*?`
// crosses newlines via the `s` flag so multi-line div openings are handled.
// We capture the role string for the finding text.
const ABS_POPOVER_ROLE_TAG =
  /<div\b[^>]*?\brole=["'](listbox|menu|dialog)["'][^>]*?>/gs
const ABS_IN_CLASSNAME = /className=["`][^"`]*\babsolute\b[^"`]*["`]/

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

// (h) Every raw primitive occurrence in the tree, in walk order, so the ratchet
// can compare per-area totals AND still point at the specific tags that put an
// area over its number.
const rawPrimitiveHits = []

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

  // (e) Hand-rolled task-card shapes outside TaskCard.tsx and BoardLane.tsx
  // (BoardLane queries the canonical data-attribute by design — see header).
  if (path !== TASKCARD_PATH && path !== BOARDLANE_PATH) {
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
        tagBody.includes('rounded-sm') &&
        !tagBody.includes('border-transparent')
      ) {
        const { line, column } = locationOf(source, start)
        recordFinding({
          rule: 'no-hand-rolled-task-card',
          path,
          line,
          column,
          match: `<${tagMatch[1]} ... border-l-2 rounded-sm>`,
          canonical: 'use ui/TaskCard (variant="row" | "card")',
        })
      }
    }
  }

  // (f) Bespoke popover shells outside the canonical primitives.
  if (path !== POPOVER_PATH && path !== TOOLTIP_PATH) {
    let popoverShellCount = 0
    const popoverShellFindings = []
    POPOVER_ENTER.lastIndex = 0
    let popoverMatch
    while ((popoverMatch = POPOVER_ENTER.exec(source))) {
      popoverShellCount += 1
      const { line, column } = locationOf(source, popoverMatch.index)
      popoverShellFindings.push({
        rule: 'no-bespoke-popover-shell',
        path,
        line,
        column,
        match: popoverMatch[0],
        canonical: "use ui/Popover from 'src/renderer/src/components/ui/Popover.tsx'",
      })
    }
    const allowed = BESPOKE_POPOVER_BASELINE.get(path) ?? 0
    if (popoverShellCount > allowed) {
      popoverShellFindings.slice(allowed).forEach(recordFinding)
    }
  }

  // (g) Bespoke absolute-shell + ARIA popover role pattern outside the
  // canonical primitives. Catches the broader pattern that bypasses the
  // popover-enter detector — a hand-rolled `<div role="listbox|menu|dialog"
  // className="…absolute…">` is functionally a popover regardless of which
  // animation class it pulls in. Per-line primitive-duplication-allow markers
  // exempt documented cases (e.g. nested chip-listbox inside a Popover-managed
  // parent where the outer Popover owns outside-click and focus restoration).
  if (path !== POPOVER_PATH && path !== TOOLTIP_PATH && path !== DRAWER_PATH) {
    const sourceLines = source.split('\n')
    ABS_POPOVER_ROLE_TAG.lastIndex = 0
    let roleMatch
    while ((roleMatch = ABS_POPOVER_ROLE_TAG.exec(source))) {
      const tagText = roleMatch[0]
      if (!ABS_IN_CLASSNAME.test(tagText)) continue
      const { line, column } = locationOf(source, roleMatch.index)
      const lineText = sourceLines[line - 1] ?? ''
      const prev1 = line >= 2 ? sourceLines[line - 2] ?? '' : ''
      const prev2 = line >= 3 ? sourceLines[line - 3] ?? '' : ''
      const prev3 = line >= 4 ? sourceLines[line - 4] ?? '' : ''
      if (
        lineText.includes(PRIMITIVE_DUP_ALLOW_MARKER) ||
        prev1.includes(PRIMITIVE_DUP_ALLOW_MARKER) ||
        prev2.includes(PRIMITIVE_DUP_ALLOW_MARKER) ||
        prev3.includes(PRIMITIVE_DUP_ALLOW_MARKER)
      ) {
        continue
      }
      recordFinding({
        rule: 'no-bespoke-absolute-popover-role',
        path,
        line,
        column,
        match: `<div role="${roleMatch[1]}" ... absolute …>`,
        canonical:
          "use ui/Popover, ui/OverflowMenu, or ui/Select — or add `primitive-duplication-allow: <reason>` for a documented nested exemption",
      })
    }
  }

  // (h) Raw design-system primitives in product code. Collected here, judged
  // per area once the whole tree is counted.
  if (!path.startsWith(KIT_DIR)) {
    const code = maskComments(source)
    for (const primitive of RAW_PRIMITIVES) {
      primitive.pattern.lastIndex = 0
      let rawMatch
      while ((rawMatch = primitive.pattern.exec(code))) {
        const { line, column } = locationOf(source, rawMatch.index)
        rawPrimitiveHits.push({
          area: areaOf(path),
          path,
          line,
          column,
          tag: primitive.tag,
          spec: primitive.spec,
          canonical: primitive.canonical,
        })
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * (h) The raw-primitive ratchet
 * ------------------------------------------------------------------ */

const rawByArea = new Map()
for (const hit of rawPrimitiveHits) {
  if (!rawByArea.has(hit.area)) rawByArea.set(hit.area, [])
  rawByArea.get(hit.area).push(hit)
}
// Collection is per tag within a file, so sort back into reading order: the
// findings past the allowance are otherwise "all the buttons, then all the
// inputs", which reads as arbitrary.
for (const hits of rawByArea.values()) {
  hits.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.column - b.column)
}

function readRawBaseline() {
  const abs = resolve(repoRoot, RAW_PRIMITIVE_BASELINE_PATH)
  if (!existsSync(abs)) {
    process.stderr.write(
      `Missing ${RAW_PRIMITIVE_BASELINE_PATH}.\n` +
        'The no-raw-primitive ratchet has no numbers to hold, so every raw\n' +
        '<button>/<input>/<textarea> in the renderer would pass unnoticed. That is\n' +
        'the state this rule exists to end, so the guard refuses to run rather than\n' +
        'reporting a green it cannot stand behind. Restore the file from git, or\n' +
        'seed it with `--update-baseline` from a tree you have read.\n',
    )
    process.exit(2)
  }
  let parsed
  try {
    parsed = JSON.parse(readFileSync(abs, 'utf8'))
  } catch {
    process.stderr.write(`${RAW_PRIMITIVE_BASELINE_PATH} is not valid JSON.\n`)
    process.exit(2)
  }
  const counts = parsed?.counts
  if (counts === null || typeof counts !== 'object' || Array.isArray(counts)) {
    process.stderr.write(`${RAW_PRIMITIVE_BASELINE_PATH} must declare an object under "counts".\n`)
    process.exit(2)
  }
  return counts
}

function writeRawBaseline(counts, previous) {
  const areas = [...new Set([...Object.keys(counts), ...Object.keys(previous)])].sort()
  const grew = areas.filter((area) => (counts[area] ?? 0) > (previous[area] ?? 0))
  if (grew.length > 0) {
    process.stderr.write(
      '--update-baseline drains the ratchet; it does not raise it. These areas grew:\n' +
        grew.map((area) => `  ${area}: ${previous[area] ?? 0} -> ${counts[area] ?? 0}\n`).join('') +
        '\nA new raw <button>/<input>/<textarea> is not a number to record. Add the\n' +
        'element to the design system (a spec under design-system/components/<name>/\n' +
        'plus the primitive under src/renderer/src/components/ui/) or change one that\n' +
        'is already there, and use it.\n',
    )
    process.exit(2)
  }
  const ordered = {}
  for (const area of areas) {
    if ((counts[area] ?? 0) === 0) continue
    ordered[area] = counts[area]
  }
  const body = {
    $comment:
      'Raw <button>/<input>/<textarea> that predate the no-raw-primitive rule, per renderer ' +
      'area. ONLY EVER EDIT DOWNWARD — an area over its number fails the lint, an area under ' +
      'it fails too (write the smaller number), and an area absent here fails on its first ' +
      'raw element. The exit condition is an empty object. See the rule (h) header in ' +
      'scripts/lint-primitive-duplication.mjs.',
    counts: ordered,
  }
  writeFileSync(resolve(repoRoot, RAW_PRIMITIVE_BASELINE_PATH), `${JSON.stringify(body, null, 2)}\n`)
  process.stdout.write(`Wrote ${RAW_PRIMITIVE_BASELINE_PATH} (${Object.keys(ordered).length} area(s)).\n`)
}

const rawBaseline = readRawBaseline()
const actualByArea = {}
for (const [area, hits] of rawByArea) actualByArea[area] = hits.length

if (UPDATE_BASELINE) {
  writeRawBaseline(actualByArea, rawBaseline)
  process.exit(0)
}

for (const area of [...new Set([...Object.keys(rawBaseline), ...Object.keys(actualByArea)])].sort()) {
  const allowed = rawBaseline[area] ?? 0
  const hits = rawByArea.get(area) ?? []
  if (hits.length > allowed) {
    // The ratchet counts an AREA, so it can say how many are owed but not which
    // one is new — walk order is not edit order. It reports the tags past the
    // allowance and says so, rather than pointing confidently at the wrong line.
    for (const hit of hits.slice(allowed)) {
      recordFinding({
        rule: 'no-raw-primitive',
        path: hit.path,
        line: hit.line,
        column: hit.column,
        match: `<${hit.tag}>`,
        canonical:
          `${hit.canonical} — spec: ${hit.spec}. ` +
          `\`${area}\` is allowed ${allowed} raw element(s) and has ${hits.length}. ` +
          'The count is per area, so this line is one of the area\'s raw elements ' +
          'rather than necessarily the one just added — the area owes ' +
          `${hits.length - allowed}. A new UI element goes into the design system ` +
          'first; the baseline never goes up.',
      })
    }
  } else if (hits.length < allowed) {
    recordFinding({
      rule: 'no-raw-primitive',
      path: RAW_PRIMITIVE_BASELINE_PATH,
      line: 1,
      column: 1,
      match: `${area}: ${allowed} allowed, ${hits.length} found`,
      canonical:
        `write ${hits.length} for \`${area}\`` +
        (hits.length === 0 ? ' (or delete the entry)' : '') +
        ' — a baseline left above the real count is a parking space for the next regression',
    })
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
  `  no-native-select allow-list: ${NATIVE_SELECT_ALLOW.length} consumer file(s) (the list is retired; it stays empty)\n`,
)
process.stdout.write(
  `  no-raw-primitive ratchet: ${rawPrimitiveHits.length} raw element(s) across ` +
    `${rawByArea.size} area(s), allowance ${Object.values(rawBaseline).reduce((sum, n) => sum + n, 0)} ` +
    `(${RAW_PRIMITIVE_BASELINE_PATH}, drains only)\n`,
)
process.stdout.write(
  `  no-bespoke-popover-shell baseline: ${[...BESPOKE_POPOVER_BASELINE.values()].reduce((sum, count) => sum + count, 0)} legacy shell(s)\n`,
)
const ruleOrder = [
  'no-duplicate-statusdot',
  'no-native-select',
  'no-radial-gradient',
  'no-statusdot-from-app-icons',
  'no-hand-rolled-task-card',
  'no-bespoke-popover-shell',
  'no-bespoke-absolute-popover-role',
  'no-raw-primitive',
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
      '  - ui/Popover for anchored menus, listboxes, and dialog popovers\n' +
      '  - ui/Buttons, ui/Input, ui/Textarea, ui/Checkbox, ui/Switch instead of a\n' +
      '    raw <button>, <input> or <textarea>\n' +
      'Confine radial-gradient to the memory graph canvas. Delete any\n' +
      'AppIcons.StatusDot re-export; it was removed in T9 and should never\n' +
      'come back.\n' +
      '\n' +
      'For no-raw-primitive there is no marker and no allow-list entry to add. A\n' +
      'UI element that the kit does not already have is a change to the design\n' +
      'system: a component spec under design-system/components/<name>/ (anatomy,\n' +
      'variants, states, usage, accessibility) plus the primitive under\n' +
      'src/renderer/src/components/ui/ — or a variant added to one that exists.\n',
  )
}

const exitCode = !REPORT_ONLY && findings.length > 0 ? 1 : 0
process.exit(exitCode)
