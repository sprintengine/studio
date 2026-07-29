#!/usr/bin/env node
// Design-system conformance guard.
//
// The product is held to `design-system/foundations/principles.md`. This guard
// carries the mechanical clauses of that document — the ones a machine can
// decide — plus two rules about the token layer itself. It is a sibling of
// `scripts/lint-design-tokens.mjs` and the rest of the `npm run lint` family;
// it never duplicates a rule one of them already owns (native `title=` on a
// control is theirs, not ours).
//
// ## Rules
//
// Twelve rules scan the renderer source tree:
//
//   focus-ring-removed     `focus:outline-none` with no focus-visible ring on
//                          the same element ("Accessibility": visible focus,
//                          never removed). A `focus:ring-*` does not count —
//                          "Selection and focus" puts the ring on
//                          `:focus-visible` and never on `:focus`.
//   spacing-off-grid       arbitrary odd-pixel padding / margin / gap ("Space
//                          and size": every value comes from `sem.space.*`,
//                          a 2px grid — an odd number cannot be on it).
//   emoji-as-icon          emoji in source outside comments ("Reject on
//                          sight": decorative emoji as iconography).
//   selection-accent-bar   a `border-l-*` paired with `--accent-primary`
//                          ("Restraint": selection is neutral, no left bar).
//   backdrop-filter        `backdrop-blur` / `backdrop-filter` ("Motion":
//                          never on a scrim; it is also a ~10fps regression).
//   shadow-in-flow         a Tailwind `shadow-{sm,md,lg,xl,2xl}` utility
//                          ("Hairlines carry the structure": elevation is a
//                          three-step overlay ramp taken from the shadow
//                          tokens, so the utility is always the wrong reach).
//   arbitrary-z-index      `z-[n]` outside the layering scale ("Tokens or
//                          nothing": layering comes from `sem.z.*`).
//   accent-marks-active    an accent fill conditioned on active/selected
//                          ("The accent budget": solid accent is the primary
//                          action and nothing else).
//   uppercase-tracked      `uppercase` paired with a `tracking-*` utility
//                          ("Type": no uppercase letter-spaced labels as
//                          hierarchy).
//   hover-without-focus    `group-hover:opacity-100` with no focus counterpart
//                          ("Progressive disclosure": hover-only is a bug).
//   marketing-radii        `rounded-2xl` and up on operational chrome ("Space
//                          and size").
//   micro-type-floor       a text size below the 10px micro floor
//                          ("Restraint": density never comes from shrinking
//                          type).
//
// Two rules read the token layer instead of the component tree:
//
//   app-token-restates-bundle  an app variable in `index.css`'s base dark or
//                              light block that carries a literal where
//                              `design-system/foundations/tokens.css` has a
//                              counterpart. The bundle is the authority
//                              (`design-system/USAGE.md`); the app must alias
//                              it, not mirror it by hand.
//   theme-ramp-contrast        per theme: the ink ramp strong → default →
//                              muted → subtle → disabled must not invert, and
//                              `--text-disabled` must clear 3:1 against every
//                              surface it is painted on — `--bg-surface`,
//                              `--bg-surface-raised` and `--bg-app`
//                              ("Accessibility": the ink ramp orders
//                              identically in both modes). Raised chrome is
//                              where disabled ink most often lands (the CLI
//                              listbox, the command palette, the confirm
//                              dialog), so measuring the app canvas alone
//                              certifies a floor the product does not meet.
//
// ## Tolerance
//
// None, with one scoped and self-terminating exception:
// `scripts/design-system-conformance/disabled-contrast.json` lists
// `"<theme>:<surface>"` pairings already known to miss the 3:1 disabled floor,
// so the measurement can land ahead of the nineteen-theme retone that clears
// it. It is not a general baseline: it tolerates only this one check, an entry
// whose pairing now clears the floor is itself an error, and a missing or empty
// file means zero tolerance. The file exists to be emptied and deleted.
//
// Every other rule sweeps clean and carries no tolerance at all: one violation
// fails `npm run lint`. The per-rule baseline files that let the twelve fix
// tasks land one at a time were deleted once the last of them emptied — a
// tolerance file that is only ever empty is a place for a regression to be
// parked, not a safety net.
//
// A genuine exception is documented on the line, not in a list.
//
// ## Exemptions
//
// A `design-system-allow: <reason>` marker suppresses a violation on its own
// line or on one of the two following lines — mirroring the `design-tokens-allow`
// convention, and the same reach it has in `lint-design-tokens.mjs`. The marker
// is per-line: there is no block or per-file form. A marker with no reason text
// is itself an error.
//
// ## Usage
//
//   node scripts/lint-design-system-conformance.mjs
//   node scripts/lint-design-system-conformance.mjs --report        # never fails
//   node scripts/lint-design-system-conformance.mjs --quiet

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { resolve, join, sep } from 'node:path'

const SOURCE_ROOT = 'src/renderer/src'
const APP_CSS_PATH = 'src/renderer/src/assets/index.css'
const BUNDLE_CSS_PATH = 'design-system/foundations/tokens.css'
const DISABLED_CONTRAST_BASELINE_PATH = 'scripts/design-system-conformance/disabled-contrast.json'

const SOURCE_EXT = new Set(['.tsx', '.ts'])
// Review-only surfaces. `design-system/` is never scanned at all: the bundle
// legitimately declares the values the app must not restate.
const EXCLUDED_DIRS = new Set(['__preview__'])

const ALLOW_MARKER = 'design-system-allow:'

const repoRoot = process.cwd()

/* ------------------------------------------------------------------ *
 * Lexing helpers
 * ------------------------------------------------------------------ */

const KIND_CODE = 0
const KIND_COMMENT = 1
const KIND_STRING = 2

// Classify every offset as code, comment, or string body. Template
// interpolations (`${…}`) are code, so a class context built from a template
// literal still sees the identifiers spliced into it. Regex literals are not
// tracked; a `//` inside one would be misread as a comment, which has not
// occurred in this tree and would only ever silence a finding, never invent one.
function classifySource(source) {
  const kinds = new Uint8Array(source.length)
  // Stack of template-literal depths so `${ `nested` }` unwinds correctly.
  const templateStack = []
  let i = 0
  while (i < source.length) {
    const ch = source[i]
    const next = source[i + 1]
    if (ch === '/' && next === '/') {
      const end = source.indexOf('\n', i)
      const stop = end === -1 ? source.length : end
      kinds.fill(KIND_COMMENT, i, stop)
      i = stop
      continue
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2)
      const stop = end === -1 ? source.length : end + 2
      kinds.fill(KIND_COMMENT, i, stop)
      i = stop
      continue
    }
    if (ch === "'" || ch === '"') {
      const start = i
      i += 1
      while (i < source.length) {
        if (source[i] === '\\') {
          i += 2
          continue
        }
        if (source[i] === ch || source[i] === '\n') break
        i += 1
      }
      const stop = Math.min(source.length, i + 1)
      kinds.fill(KIND_STRING, start + 1, Math.max(start + 1, stop - 1))
      i = stop
      continue
    }
    if (ch === '`') {
      i = scanTemplate(source, i, kinds, templateStack)
      continue
    }
    i += 1
  }
  return kinds
}

// Walk a template literal from its opening backtick, marking the literal
// segments as string and leaving `${…}` interpolations as code.
function scanTemplate(source, openIndex, kinds, templateStack) {
  let i = openIndex + 1
  let segmentStart = i
  while (i < source.length) {
    const ch = source[i]
    if (ch === '\\') {
      i += 2
      continue
    }
    if (ch === '`') {
      kinds.fill(KIND_STRING, segmentStart, i)
      return i + 1
    }
    if (ch === '$' && source[i + 1] === '{') {
      kinds.fill(KIND_STRING, segmentStart, i)
      templateStack.push(1)
      i += 2
      let depth = 1
      while (i < source.length && depth > 0) {
        const inner = source[i]
        if (inner === '{') depth += 1
        else if (inner === '}') depth -= 1
        else if (inner === '`') {
          i = scanTemplate(source, i, kinds, templateStack)
          continue
        } else if (inner === "'" || inner === '"') {
          const quote = inner
          const start = i
          i += 1
          while (i < source.length) {
            if (source[i] === '\\') {
              i += 2
              continue
            }
            if (source[i] === quote || source[i] === '\n') break
            i += 1
          }
          kinds.fill(KIND_STRING, start + 1, Math.min(source.length, i))
          i = Math.min(source.length, i + 1)
          continue
        }
        i += 1
      }
      templateStack.pop()
      segmentStart = i
      continue
    }
    i += 1
  }
  kinds.fill(KIND_STRING, segmentStart, source.length)
  return source.length
}

function lineStarts(source) {
  const starts = [0]
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === '\n') starts.push(i + 1)
  }
  return starts
}

function lineOf(starts, index) {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid] <= index) lo = mid
    else hi = mid - 1
  }
  return lo + 1
}

/* ------------------------------------------------------------------ *
 * Class-context resolution
 * ------------------------------------------------------------------ */

// End offset of a JSX opening tag started at `open`, or -1. Quotes and brace
// depth are respected so `className={cn('a > b')}` does not close the tag.
function openingTagEnd(source, open, kinds) {
  let depth = 0
  for (let i = open + 1; i < source.length && i - open < 6000; i += 1) {
    if (kinds[i] === KIND_STRING || kinds[i] === KIND_COMMENT) continue
    const ch = source[i]
    if (ch === '{') depth += 1
    else if (ch === '}') depth -= 1
    else if (ch === '<' && depth === 0) return -1
    else if (ch === '>' && depth === 0) return i
  }
  return -1
}

// Innermost JSX opening tag containing `index`, as text.
function enclosingOpeningTag(source, index, kinds) {
  const floor = Math.max(0, index - 4000)
  for (let i = Math.min(index, source.length - 1); i >= floor; i -= 1) {
    if (source[i] !== '<') continue
    if (kinds[i] === KIND_STRING || kinds[i] === KIND_COMMENT) continue
    const nextChar = source[i + 1]
    if (!nextChar || !/[A-Za-z_]/.test(nextChar)) continue
    const end = openingTagEnd(source, i, kinds)
    if (end > index) return source.slice(i, end + 1)
  }
  return null
}

const OPENERS = { '(': ')', '[': ']', '{': '}' }
const CLOSERS = { ')': '(', ']': '[', '}': '{' }

// Innermost balanced (…)/[…]/{…} group containing `index` whose span fits
// `maxSpan`, as text. This is what catches class lists built as arrays or
// `cn(…)` calls rather than written inline on the element.
function enclosingGroup(source, index, kinds, maxSpan) {
  const floor = Math.max(0, index - maxSpan)
  const pending = []
  for (let i = index; i >= floor; i -= 1) {
    if (kinds[i] === KIND_STRING || kinds[i] === KIND_COMMENT) continue
    const ch = source[i]
    if (CLOSERS[ch] && i !== index) {
      pending.push(CLOSERS[ch])
      continue
    }
    if (!OPENERS[ch]) continue
    if (pending.length > 0 && pending[pending.length - 1] === ch) {
      pending.pop()
      continue
    }
    if (pending.length > 0) continue
    const end = matchingClose(source, i, kinds, maxSpan)
    if (end > index) return source.slice(i, end + 1)
    return null
  }
  return null
}

function matchingClose(source, open, kinds, maxSpan) {
  const want = OPENERS[source[open]]
  let depth = 0
  for (let i = open; i < source.length && i - open <= maxSpan; i += 1) {
    if (kinds[i] === KIND_STRING || kinds[i] === KIND_COMMENT) continue
    const ch = source[i]
    if (OPENERS[ch]) depth += 1
    else if (CLOSERS[ch]) {
      depth -= 1
      if (depth === 0) return ch === want ? i : -1
    }
  }
  return -1
}

// Text of the string or template segment containing `index`.
function enclosingLiteral(source, index, kinds) {
  if (kinds[index] !== KIND_STRING) return null
  let start = index
  while (start > 0 && kinds[start - 1] === KIND_STRING) start -= 1
  let end = index
  while (end < source.length - 1 && kinds[end + 1] === KIND_STRING) end += 1
  return source.slice(start, end + 1)
}

// The text a "same element" rule reasons over: the enclosing JSX opening tag,
// the enclosing bracket group, and the enclosing string literal, concatenated.
// A rule asking "is a ring declared alongside this?" wants all three, because
// class lists are written in all three shapes across this tree.
function classContext(file, index, maxSpan) {
  const parts = []
  const tag = enclosingOpeningTag(file.source, index, file.kinds)
  if (tag && tag.length <= maxSpan * 2) parts.push(tag)
  const group = enclosingGroup(file.source, index, file.kinds, maxSpan)
  if (group) parts.push(group)
  const literal = enclosingLiteral(file.source, index, file.kinds)
  if (literal) parts.push(literal)
  parts.push(file.lines[lineOf(file.starts, index) - 1] ?? '')
  return parts.join('\n')
}

/* ------------------------------------------------------------------ *
 * Source rules
 * ------------------------------------------------------------------ */

const FOCUS_OUTLINE_NONE = /(?<![\w-])focus:outline-none(?![\w-])/g
// Only a `:focus-visible` ring satisfies the clause. A `focus:ring-*` draws on
// mouse click, which the same paragraph rules out ("Never on `:focus` — a
// mouse click must not draw a ring"), so it does not discharge the outline.
const FOCUS_RING_PRESENT = /focus-visible:(?:ring|shadow|outline|border)|FOCUS_RING_CLASS/

const SPACING_ARBITRARY =
  /(?<![\w-])-?(?:px|py|pt|pr|pb|pl|p|mx|my|mt|mr|mb|ml|m|gap-x|gap-y|gap|space-x|space-y)-\[(-?\d+(?:\.\d+)?)px\]/g

// Emoji proper, plus the two symbol blocks the tree actually reaches for when
// it draws an icon with a character — Miscellaneous Symbols (⚠, ⏺) and
// Dingbats (✓, ✗, ✳). Arrows, box drawing, and geometric shapes are NOT here:
// they are typographic marks the system permits, not iconography.
const EMOJI = /[\p{Extended_Pictographic}☀-⛿✀-➿]/gu
const EMOJI_ALLOWED = new Set(['©', '®', '™'])

// A left bar in the accent is the violation itself; the bare `border-…` form
// is one only when a left-border width sits in the same class context, which
// is how `InboxRow` splits the two halves across a class array.
const ACCENT_LEFT_BORDER = /(?<![\w-])border-l-\[(?:color:)?var\(--accent-primary\)\]/g
const ACCENT_BORDER = /(?<![\w-])border-\[(?:color:)?var\(--accent-primary\)\]/g
const LEFT_BORDER_WIDTH = /(?<![\w-])border-l(?:-(?:0|2|4|8|\[\d+(?:\.\d+)?(?:px|rem)?\]))?(?![\w-])/

const BACKDROP_FILTER = /(?<![\w-])backdrop-(?:blur|filter)(?:-[\w.[\]/-]+)?/g

const TAILWIND_SHADOW = /(?<![\w-])shadow-(?:sm|md|lg|xl|2xl)(?![\w-])/g

const ARBITRARY_Z = /(?<![\w-])z-\[([^\]]+)\]/g

const ACCENT_FILL = /(?<![\w-])bg-\[(?:color:)?var\(--accent-primary(?:-soft(?:-strong)?)?\)\]/g
// An identifier, not a fragment of a token name: `--bg-active` and
// `aria-selected` must not read as "this marks the active thing".
const ACTIVE_CONDITION = /(?<![\w$-])(?:is|Is)?(?:active|Active|selected|Selected|current|Current)(?![\w-])/
const HAIRLINE_SHAPE = /(?<![\w-])(?:h-px|w-px|h-0\.5|w-0\.5)(?![\w-])/

const UPPERCASE = /(?<![\w-])uppercase(?![\w-])/g
const TRACKING = /(?<![\w-])tracking-/

const GROUP_HOVER_REVEAL = /(?<![\w-])group-hover:opacity-100(?![\w-])/g
const FOCUS_REVEAL = /(?:group-)?focus(?:-within|-visible)?:opacity-100/

// `rounded-2xl` is 16px; the arbitrary form is caught at the same threshold.
// `rounded-full` is deliberately absent: a pill or a dot is its own idiom, not
// a marketing radius.
const MARKETING_RADIUS = /(?<![\w-])rounded-(?:2xl|3xl|4xl|\[(\d+(?:\.\d+)?)px\])(?![\w-])/g
const MARKETING_RADIUS_FLOOR_PX = 16

// The micro floor. `sem.font.size.micro` is the smallest step the system
// declares; anything under it is type shrunk to fit a container.
const TEXT_SIZE = /(?<![\w-])text-\[(\d+(?:\.\d+)?)px\]/g
const MICRO_FLOOR_PX = 10

function scanSourceFile(file, push) {
  const { source, kinds } = file
  const inCode = (index) => kinds[index] !== KIND_COMMENT

  forEachMatch(FOCUS_OUTLINE_NONE, source, (match) => {
    if (!inCode(match.index)) return
    if (FOCUS_RING_PRESENT.test(classContext(file, match.index, 1500))) return
    push('focus-ring-removed', file, match.index, 'focus:outline-none')
  })

  forEachMatch(SPACING_ARBITRARY, source, (match) => {
    if (!inCode(match.index)) return
    const value = Number(match[1])
    if (Number.isInteger(value) && value % 2 === 0) return
    push('spacing-off-grid', file, match.index, match[0])
  })

  forEachMatch(EMOJI, source, (match) => {
    if (!inCode(match.index)) return
    if (EMOJI_ALLOWED.has(match[0])) return
    push('emoji-as-icon', file, match.index, match[0])
  })

  forEachMatch(ACCENT_LEFT_BORDER, source, (match) => {
    if (!inCode(match.index)) return
    push('selection-accent-bar', file, match.index, match[0])
  })

  forEachMatch(ACCENT_BORDER, source, (match) => {
    if (!inCode(match.index)) return
    if (!LEFT_BORDER_WIDTH.test(classContext(file, match.index, 900))) return
    push('selection-accent-bar', file, match.index, match[0])
  })

  forEachMatch(BACKDROP_FILTER, source, (match) => {
    if (!inCode(match.index)) return
    push('backdrop-filter', file, match.index, match[0])
  })

  forEachMatch(TAILWIND_SHADOW, source, (match) => {
    if (!inCode(match.index)) return
    push('shadow-in-flow', file, match.index, match[0])
  })

  forEachMatch(ARBITRARY_Z, source, (match) => {
    if (!inCode(match.index)) return
    if (/^var\(--(?:sem-)?z-/.test(match[1].trim())) return
    push('arbitrary-z-index', file, match.index, match[0])
  })

  forEachMatch(ACCENT_FILL, source, (match) => {
    if (!inCode(match.index)) return
    const context = classContext(file, match.index, 700)
    if (!ACTIVE_CONDITION.test(context)) return
    // A hairline underline or rule may carry the accent — the budget permits
    // accent as ink or a hairline, only not as a fill.
    if (HAIRLINE_SHAPE.test(context)) return
    // A left bar belongs to selection-accent-bar; the two rules stay disjoint so
    // one violation is reported once, under the rule whose fix hint applies.
    if (ACCENT_LEFT_BORDER.test(context) || ACCENT_BORDER.test(context)) {
      ACCENT_LEFT_BORDER.lastIndex = 0
      ACCENT_BORDER.lastIndex = 0
      return
    }
    push('accent-marks-active', file, match.index, match[0])
  })

  forEachMatch(UPPERCASE, source, (match) => {
    if (!inCode(match.index)) return
    const context = classContext(file, match.index, 400)
    if (!TRACKING.test(context)) return
    if (/<kbd/i.test(context)) return
    push('uppercase-tracked', file, match.index, 'uppercase + tracking-*')
  })

  forEachMatch(GROUP_HOVER_REVEAL, source, (match) => {
    if (!inCode(match.index)) return
    if (FOCUS_REVEAL.test(classContext(file, match.index, 1500))) return
    push('hover-without-focus', file, match.index, match[0])
  })

  forEachMatch(MARKETING_RADIUS, source, (match) => {
    if (!inCode(match.index)) return
    if (match[1] !== undefined && Number(match[1]) < MARKETING_RADIUS_FLOOR_PX) return
    push('marketing-radii', file, match.index, match[0])
  })

  forEachMatch(TEXT_SIZE, source, (match) => {
    if (!inCode(match.index)) return
    if (Number(match[1]) >= MICRO_FLOOR_PX) return
    push('micro-type-floor', file, match.index, match[0])
  })
}

function forEachMatch(regex, source, visit) {
  regex.lastIndex = 0
  let match
  while ((match = regex.exec(source))) {
    visit(match)
    if (match[0].length === 0) regex.lastIndex += 1
  }
}

/* ------------------------------------------------------------------ *
 * CSS parsing
 * ------------------------------------------------------------------ */

function maskCssComments(source) {
  const kinds = new Uint8Array(source.length)
  let i = 0
  while (i < source.length - 1) {
    if (source[i] === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2)
      const stop = end === -1 ? source.length : end + 2
      kinds.fill(KIND_COMMENT, i, stop)
      i = stop
      continue
    }
    i += 1
  }
  return kinds
}

// Every top-level `selector { … }` rule, in document order. Comments are
// stripped from the selector so a block preceded by a doc comment still reads
// correctly — every token block in both stylesheets is.
function readTopLevelBlocks(source, kinds) {
  const blocks = []
  let selectorStart = 0
  let i = 0
  while (i < source.length) {
    if (kinds[i] === KIND_COMMENT) {
      // A comment never belongs to the selector that follows it.
      while (i < source.length && kinds[i] === KIND_COMMENT) i += 1
      selectorStart = i
      continue
    }
    const ch = source[i]
    if (ch === ';') {
      selectorStart = i + 1
      i += 1
      continue
    }
    if (ch !== '{') {
      i += 1
      continue
    }
    const selector = source.slice(selectorStart, i).trim()
    let depth = 1
    let end = i + 1
    while (end < source.length && depth > 0) {
      if (kinds[end] !== KIND_COMMENT) {
        if (source[end] === '{') depth += 1
        else if (source[end] === '}') depth -= 1
      }
      end += 1
    }
    blocks.push({ selector, bodyStart: i + 1, bodyEnd: end - 1 })
    i = end
    selectorStart = end
  }
  return blocks
}

// The subset whose selector list is made only of `:root` and
// `:root[data-theme="…"]` parts. Blocks with a descendant selector (the git
// ref pills, the date-picker chrome) are not token blocks and are skipped.
function readRootBlocks(source, kinds) {
  const blocks = []
  for (const block of readTopLevelBlocks(source, kinds)) {
    const parts = block.selector.split(',').map((part) => part.trim())
    if (!parts.every((part) => /^:root(?:\[data-theme="[\w-]+"\])?$/.test(part))) continue
    blocks.push({
      ...block,
      parts,
      themes: parts
        .map((part) => part.match(/\[data-theme="([\w-]+)"\]/)?.[1] ?? null)
        .filter((theme) => theme !== null),
      appliesToAllThemes: parts.some((part) => part === ':root'),
    })
  }
  return blocks
}

// `bundleMode` records which mode of the bundle a `var(--sem-…)` alias in this
// block resolves against, so the ramp check keeps working after the app stops
// restating literals. Only the base dark block and the light block carry
// aliases (they are the two modes the bundle ships); the other themes hold
// their own literals and specificity keeps them winning.
function readDeclarations(source, kinds, block, bundleMode = null) {
  const declarations = new Map()
  const pattern = /(--[\w-]+)\s*:\s*([^;}]*)(;|})/g
  pattern.lastIndex = block.bodyStart
  let match
  while ((match = pattern.exec(source))) {
    if (match.index >= block.bodyEnd) break
    if (kinds[match.index] === KIND_COMMENT) continue
    declarations.set(match[1], { value: match[2].trim(), index: match.index, bundleMode })
  }
  return declarations
}

// Follow `var(…)` to a literal: into the bundle for a `--sem-*` alias, or
// through the theme's own map for an app-level indirection. `color-mix()` and
// anything else that needs a real CSS engine stays unresolved.
function resolveTokenValue(name, resolved, bundle, depth = 0) {
  if (depth > 4) return null
  const declaration = resolved.get(name)
  if (!declaration) return null
  const reference = declaration.value.match(/^var\((--[\w-]+)\)$/)
  if (!reference) return declaration.value
  if (reference[1].startsWith('--sem-')) {
    if (!declaration.bundleMode) return null
    return bundle[declaration.bundleMode].get(reference[1]) ?? null
  }
  return resolveTokenValue(reference[1], resolved, bundle, depth + 1)
}

/* ------------------------------------------------------------------ *
 * Colour maths
 * ------------------------------------------------------------------ */

function parseColor(value) {
  const text = value.trim()
  const hex = text.match(/^#([0-9a-fA-F]{3,8})$/)
  if (hex) {
    const digits = hex[1]
    if (digits.length === 3 || digits.length === 4) {
      return [0, 1, 2].map((i) => parseInt(digits[i] + digits[i], 16))
    }
    if (digits.length === 6 || digits.length === 8) {
      return [0, 2, 4].map((i) => parseInt(digits.slice(i, i + 2), 16))
    }
    return null
  }
  const rgb = text.match(/^rgba?\(([^)]+)\)$/i)
  if (rgb) {
    const parts = rgb[1].split(/[,/\s]+/).filter(Boolean)
    if (parts.length < 3) return null
    const channels = parts.slice(0, 3).map((part) => Number(part))
    if (channels.some((channel) => !Number.isFinite(channel))) return null
    // Only opaque colours are compared; an alpha value would need the surface
    // beneath it to mean anything, and the ink ramp is opaque in every theme.
    if (parts.length > 3 && Number(parts[3]) < 1) return null
    return channels
  }
  return null
}

function relativeLuminance([r, g, b]) {
  const channel = (raw) => {
    const value = raw / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

function contrastRatio(a, b) {
  const first = relativeLuminance(a)
  const second = relativeLuminance(b)
  const lighter = Math.max(first, second)
  const darker = Math.min(first, second)
  return (lighter + 0.05) / (darker + 0.05)
}

/* ------------------------------------------------------------------ *
 * Token-layer rules
 * ------------------------------------------------------------------ */

// App variable → its counterpart in the design-system bundle. Name-for-name,
// not name-identical: `--text-strong` is the bundle's `text-primary`. Only
// variables with a true counterpart appear here — `--tone-accent-soft`,
// `--focus-ring`, `--agent-surface` and the rest of the app-only layer are
// deliberately absent, and so is anything the bundle does not declare.
const APP_TO_BUNDLE = new Map(
  Object.entries({
    '--bg-app': '--sem-color-bg-app',
    '--bg-surface': '--sem-color-bg-surface',
    '--bg-surface-raised': '--sem-color-bg-surface-raised',
    '--bg-hover': '--sem-color-bg-hover',
    '--bg-active': '--sem-color-bg-active',
    '--bg-selected': '--sem-color-bg-selected',
    '--bg-selected-resting': '--sem-color-bg-selected-resting',
    '--text-strong': '--sem-color-text-primary',
    '--text-default': '--sem-color-text-default',
    '--text-muted': '--sem-color-text-muted',
    '--text-subtle': '--sem-color-text-subtle',
    '--text-disabled': '--sem-color-text-disabled',
    '--text-on-accent': '--sem-color-text-on-accent',
    '--border-subtle': '--sem-color-border-subtle',
    '--border-default': '--sem-color-border-default',
    '--border-strong': '--sem-color-border-strong',
    '--border-focus': '--sem-color-border-focus',
    '--accent-primary': '--sem-color-accent-primary',
    '--accent-primary-hover': '--sem-color-accent-hover',
    '--accent-primary-soft': '--sem-color-accent-soft',
    '--accent-primary-soft-strong': '--sem-color-accent-soft-strong',
    '--surface-overlay-backdrop': '--sem-color-overlay-scrim',
    '--tone-neutral': '--sem-color-status-neutral',
    '--tone-good': '--sem-color-status-good',
    '--tone-warn': '--sem-color-status-warn',
    '--tone-error': '--sem-color-status-danger',
    '--tone-merged': '--sem-color-status-merged',
    '--tone-neutral-soft': '--sem-color-status-neutral-soft',
    '--tone-good-soft': '--sem-color-status-good-soft',
    '--tone-warn-soft': '--sem-color-status-warn-soft',
    '--tone-error-soft': '--sem-color-status-danger-soft',
    '--shadow-drawer': '--sem-shadow-drawer',
    '--text-size-2xs': '--sem-font-size-micro',
    '--text-size-xs': '--sem-font-size-meta',
    '--text-size-sm': '--sem-font-size-body',
    '--text-size-md': '--sem-font-size-heading',
    '--text-size-lg': '--sem-font-size-title',
    '--text-line-tight': '--sem-font-line-tight',
    '--text-line-default': '--sem-font-line-default',
    '--text-line-relaxed': '--sem-font-line-relaxed',
    '--icon-xs': '--sem-icon-size-xs',
    '--icon-sm': '--sem-icon-size-sm',
    '--icon-md': '--sem-icon-size-md',
    '--icon-lg': '--sem-icon-size-lg',
    '--radius-xs': '--sem-radius-chip',
    '--radius-sm': '--sem-radius-control',
    '--radius-md': '--sem-radius-overlay',
    '--radius-lg': '--sem-radius-shell',
    '--motion-fast': '--sem-motion-duration-fast',
    '--motion-normal': '--sem-motion-duration-normal',
    '--motion-deliberate': '--sem-motion-duration-deliberate',
    '--motion-ease': '--sem-motion-ease-standard',
  }),
)

const RAMP = ['--text-strong', '--text-default', '--text-muted', '--text-subtle', '--text-disabled']
const DISABLED_CONTRAST_FLOOR = 3
// Every surface disabled ink is actually painted on. `--bg-surface-raised` is
// real chrome — `CliModelListbox` paints it and renders `--text-disabled`
// inside it, as do `CommandPalette`, `ConfirmDialog`, `KbdChord` and
// `SkillPickerPopover`. `--bg-selected` is deliberately absent: no surface in
// the tree pairs it with disabled ink today, and a floor no rendered surface
// needs is a rule that fails on nothing.
const DISABLED_CONTRAST_SURFACES = ['--bg-surface', '--bg-surface-raised', '--bg-app']

// The tolerated `"<theme>:<surface>"` pairings, mapped to the line each is
// written on so a stale entry reports somewhere a reader can open. A missing
// file is zero tolerance, which is what deleting it must mean.
function readDisabledContrastBaseline() {
  const abs = resolve(repoRoot, DISABLED_CONTRAST_BASELINE_PATH)
  if (!existsSync(abs)) return new Map()
  const raw = readFileSync(abs, 'utf8')
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    process.stderr.write(`${DISABLED_CONTRAST_BASELINE_PATH} is not valid JSON.\n`)
    process.exit(2)
  }
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== 'string')) {
    process.stderr.write(
      `${DISABLED_CONTRAST_BASELINE_PATH} must be a JSON array of "<theme>:<surface>" strings.\n`,
    )
    process.exit(2)
  }
  const lines = raw.split('\n')
  const tolerated = new Map()
  for (const entry of parsed) {
    const at = lines.findIndex((line) => line.includes(`"${entry}"`))
    tolerated.set(entry, at === -1 ? 1 : at + 1)
  }
  return tolerated
}

function resolveBundle(bundleSource) {
  const kinds = maskCssComments(bundleSource)
  const light = new Map()
  const dark = new Map()
  for (const block of readTopLevelBlocks(bundleSource, kinds)) {
    const target =
      block.selector === ':root' ? light : block.selector === '[data-mode="dark"]' ? dark : null
    if (!target) continue
    const body = bundleSource.slice(block.bodyStart, block.bodyEnd)
    const declaration = /(--[\w-]+)\s*:\s*([^;}]*)[;}]/g
    let entry
    while ((entry = declaration.exec(body))) {
      target.set(entry[1], entry[2].trim())
    }
  }
  const darkResolved = new Map(light)
  for (const [name, value] of dark) darkResolved.set(name, value)
  return {
    light: flattenRefs(light),
    dark: flattenRefs(darkResolved),
  }
}

// The bundle's `sem` tier points at the `ref` tier; the app compares against
// final values, so follow one `var(--ref-…)` hop.
function flattenRefs(map) {
  const flat = new Map()
  for (const [name, value] of map) {
    const reference = value.match(/^var\((--[\w-]+)\)$/)
    flat.set(name, reference && map.has(reference[1]) ? map.get(reference[1]) : value)
  }
  return flat
}

function normalizeValue(value) {
  return value.replace(/\s+/g, ' ').trim().toLowerCase()
}

/* ------------------------------------------------------------------ *
 * Rule registry
 * ------------------------------------------------------------------ */

const RULE_IDS = [
  'focus-ring-removed',
  'spacing-off-grid',
  'emoji-as-icon',
  'selection-accent-bar',
  'backdrop-filter',
  'shadow-in-flow',
  'arbitrary-z-index',
  'accent-marks-active',
  'uppercase-tracked',
  'hover-without-focus',
  'marketing-radii',
  'micro-type-floor',
  'app-token-restates-bundle',
  'theme-ramp-contrast',
]

const FIX_HINT = {
  'focus-ring-removed': 'add FOCUS_RING_CLASS from components/ui/tokens.ts to the same element',
  'spacing-off-grid': 'use the nearest sem.space step (2, 4, 6, 8, 10, 12, 16, 20, 24, 32)',
  'emoji-as-icon': 'use a glyph from components/AppIcons.tsx, or delete the decoration',
  'selection-accent-bar': 'selection is a neutral --bg-selected fill with no left bar',
  'backdrop-filter': 'separation comes from the scrim tone plus the shell shadow',
  'shadow-in-flow': 'overlays take --shadow-popover / --shadow-modal; in-flow chrome takes a hairline',
  'arbitrary-z-index': 'use the layering scale: sticky 10, drawer 40, popover 50, menu 60, modal 70, toast 80',
  'accent-marks-active': 'mark active with --bg-selected and an ink lift, not the accent',
  'uppercase-tracked': 'sentence case; hierarchy from weight and size',
  'marketing-radii': 'operational chrome uses --radius-sm / --radius-md',
  'hover-without-focus': 'pair the hover reveal with group-focus-within:opacity-100',
  'micro-type-floor': 'grow the container rather than shrinking the type below 10px',
  'app-token-restates-bundle': 'alias the bundle variable instead of restating its value',
  'theme-ramp-contrast': 'order the ink ramp identically in every theme and clear 3:1 on disabled',
}

/* ------------------------------------------------------------------ *
 * Scan
 * ------------------------------------------------------------------ */

function walkSource(absoluteRoot, root) {
  const out = []
  if (!existsSync(absoluteRoot)) return out
  for (const entry of readdirSync(absoluteRoot, { withFileTypes: true })) {
    const full = join(absoluteRoot, entry.name)
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue
      out.push(...walkSource(full, root))
      continue
    }
    if (!entry.isFile()) continue
    if (/\.test\.[cm]?[jt]sx?$/.test(entry.name)) continue
    if (entry.name.endsWith('.d.ts')) continue
    const dot = entry.name.lastIndexOf('.')
    if (dot < 0 || !SOURCE_EXT.has(entry.name.slice(dot))) continue
    out.push(full.slice(root.length + 1).split(sep).join('/'))
  }
  return out
}

const args = process.argv.slice(2)
const REPORT_ONLY = args.includes('--report')
const QUIET = args.includes('--quiet')

// The baseline mechanism is gone (see "## Tolerance"). Fail loudly rather than
// silently running at zero tolerance for someone reaching for the old flag.
if (args.includes('--write-baseline')) {
  process.stderr.write(
    'This guard no longer carries baselines: every rule sweeps clean and any violation fails.\n' +
      'Fix the violation, or document a genuine exception with a `design-system-allow: <reason>` marker.\n',
  )
  process.exit(2)
}

const violations = []
const markerErrors = []

function push(rule, file, index, text) {
  const line = lineOf(file.starts, index)
  const lineStart = file.starts[line - 1]
  violations.push({ rule, path: file.path, line, column: index - lineStart + 1, text })
}

function pushAt(rule, path, line, text) {
  violations.push({ rule, path, line, column: 1, text })
}

function collectMarkerLines(path, lines) {
  const marked = new Set()
  lines.forEach((line, index) => {
    const at = line.indexOf(ALLOW_MARKER)
    if (at === -1) return
    // Strip whatever closes the comment — `*/`, `*/}` in a JSX comment, `-->`
    // — then require the reason to carry actual words, not punctuation.
    const reason = line.slice(at + ALLOW_MARKER.length).replace(/[*/}>\-\s]+$/, '')
    if (!/[A-Za-z0-9]/.test(reason)) {
      markerErrors.push({ path, line: index + 1 })
      return
    }
    marked.add(index + 1)
    marked.add(index + 2)
    marked.add(index + 3)
  })
  return marked
}

const sourceFiles = walkSource(resolve(repoRoot, SOURCE_ROOT), repoRoot).sort()
const markerLinesByPath = new Map()

for (const path of sourceFiles) {
  const source = readFileSync(resolve(repoRoot, path), 'utf8')
  const lines = source.split('\n')
  const file = {
    path,
    source,
    lines,
    starts: lineStarts(source),
    kinds: classifySource(source),
  }
  markerLinesByPath.set(path, collectMarkerLines(path, lines))
  scanSourceFile(file, push)
}

// --- Token layer -----------------------------------------------------

const appCssAbs = resolve(repoRoot, APP_CSS_PATH)
const bundleCssAbs = resolve(repoRoot, BUNDLE_CSS_PATH)

if (!existsSync(appCssAbs) || !existsSync(bundleCssAbs)) {
  process.stderr.write(
    `Missing ${existsSync(appCssAbs) ? BUNDLE_CSS_PATH : APP_CSS_PATH}. Run from the repo root.\n`,
  )
  process.exit(2)
}

const appCss = readFileSync(appCssAbs, 'utf8')
const appCssKinds = maskCssComments(appCss)
const appCssStarts = lineStarts(appCss)
const appCssLines = appCss.split('\n')
markerLinesByPath.set(APP_CSS_PATH, collectMarkerLines(APP_CSS_PATH, appCssLines))

const bundle = resolveBundle(readFileSync(bundleCssAbs, 'utf8'))
const rootBlocks = readRootBlocks(appCss, appCssKinds)

const baseBlock = rootBlocks.find(
  (block) => block.appliesToAllThemes && block.themes.includes('dark'),
)
const lightBlock = rootBlocks.find(
  (block) => !block.appliesToAllThemes && block.themes.length === 1 && block.themes[0] === 'light',
)

if (!baseBlock || !lightBlock) {
  process.stderr.write(
    `Could not locate the base dark and light token blocks in ${APP_CSS_PATH}.\n`,
  )
  process.exit(2)
}

for (const [block, bundleValues, modeLabel] of [
  [baseBlock, bundle.dark, 'dark'],
  [lightBlock, bundle.light, 'light'],
]) {
  const declarations = readDeclarations(appCss, appCssKinds, block)
  for (const [name, declaration] of declarations) {
    const counterpart = APP_TO_BUNDLE.get(name)
    if (!counterpart) continue
    if (/^var\(--sem-[\w-]+\)$/.test(declaration.value)) continue
    const bundleValue = bundleValues.get(counterpart)
    if (bundleValue === undefined) continue
    const matches = normalizeValue(bundleValue) === normalizeValue(declaration.value)
    pushAt(
      'app-token-restates-bundle',
      APP_CSS_PATH,
      lineOf(appCssStarts, declaration.index),
      `${modeLabel} ${name} ${matches ? 'restates' : 'drifts from'} ${counterpart} ` +
        `(app ${declaration.value}${matches ? '' : `, bundle ${bundleValue}`})`,
    )
  }
}

// Ramp + contrast, per theme. A theme resolves against every preceding block
// that applies to it, exactly as the cascade does.
const themeIds = new Set()
for (const block of rootBlocks) for (const theme of block.themes) themeIds.add(theme)

const disabledContrastBaseline = readDisabledContrastBaseline()
const toleratedDisabledContrast = []

for (const theme of [...themeIds].sort()) {
  const resolved = new Map()
  for (const block of rootBlocks) {
    if (!block.appliesToAllThemes && !block.themes.includes(theme)) continue
    // The base block applies to every theme, but its `var(--sem-…)` aliases
    // only resolve for the mode that block IS. A light-family theme falling
    // through to a base alias would read the wrong mode's value, so its mode
    // is left unknown rather than guessed — see the unresolved branch below.
    const bundleMode =
      block === baseBlock && theme === 'dark'
        ? 'dark'
        : block === lightBlock && theme === 'light'
          ? 'light'
          : null
    for (const [name, declaration] of readDeclarations(appCss, appCssKinds, block, bundleMode)) {
      resolved.set(name, declaration)
    }
  }
  const surfaces = DISABLED_CONTRAST_SURFACES.map((name) => {
    const declaration = resolved.get(name)
    const value = declaration ? resolveTokenValue(name, resolved, bundle) : null
    return { name, declaration, value, color: value ? parseColor(value) : null }
  })
  // The ramp's polarity is judged against `--bg-surface`, the surface it is
  // authored against; the other two are measured, never used to decide a mode.
  const surfaceColor = surfaces.find((entry) => entry.name === '--bg-surface').color
  const ramp = RAMP.map((name) => {
    const declaration = resolved.get(name)
    const value = declaration ? resolveTokenValue(name, resolved, bundle) : null
    return {
      name,
      declaration,
      value,
      color: value ? parseColor(value) : null,
    }
  })
  // A value the guard cannot resolve to an opaque colour — a `color-mix()`, a
  // translucent ink, a bundle alias whose mode is ambiguous — is reported, not
  // skipped. Silently passing a theme the guard could not actually check is the
  // failure mode this rule exists to prevent; the carve-out marker is the way
  // out when a value is genuinely beyond it.
  const unresolved = [
    ...surfaces.filter((entry) => entry.color === null),
    ...ramp.filter((step) => step.color === null),
  ]
  if (unresolved.length > 0) {
    for (const step of unresolved) {
      pushAt(
        'theme-ramp-contrast',
        APP_CSS_PATH,
        step.declaration ? lineOf(appCssStarts, step.declaration.index) : 1,
        `theme "${theme}": ${step.name} (${step.declaration?.value ?? 'undeclared'}) does not ` +
          'resolve to an opaque colour, so the ramp cannot be checked',
      )
    }
    continue
  }

  const luminance = ramp.map((step) => relativeLuminance(step.color))
  const darkMode = luminance[0] > relativeLuminance(surfaceColor)
  for (let i = 1; i < ramp.length; i += 1) {
    const ordered = darkMode ? luminance[i] < luminance[i - 1] : luminance[i] > luminance[i - 1]
    if (ordered) continue
    const declaration = ramp[i].declaration
    pushAt(
      'theme-ramp-contrast',
      APP_CSS_PATH,
      lineOf(appCssStarts, declaration.index),
      `theme "${theme}": ${ramp[i].name} (${ramp[i].value}) inverts against ` +
        `${ramp[i - 1].name} (${ramp[i - 1].value})`,
    )
  }

  const disabled = ramp[ramp.length - 1]
  for (const surface of surfaces) {
    const ratio = contrastRatio(disabled.color, surface.color)
    if (ratio >= DISABLED_CONTRAST_FLOOR) continue
    const pairing = `${theme}:${surface.name}`
    if (disabledContrastBaseline.has(pairing)) {
      toleratedDisabledContrast.push({ pairing, ratio })
      disabledContrastBaseline.delete(pairing)
      continue
    }
    pushAt(
      'theme-ramp-contrast',
      APP_CSS_PATH,
      lineOf(appCssStarts, disabled.declaration.index),
      `theme "${theme}": --text-disabled (${disabled.value}) is ` +
        `${ratio.toFixed(2)}:1 on ${surface.name} (${surface.value}), under the ${DISABLED_CONTRAST_FLOOR}:1 floor`,
    )
  }
}

// Whatever the baseline still holds names a pairing that no longer fails — or
// never did. Either way the entry is now the only thing standing between this
// check and zero tolerance, so it fails until it is deleted.
for (const [pairing, line] of disabledContrastBaseline) {
  pushAt(
    'theme-ramp-contrast',
    DISABLED_CONTRAST_BASELINE_PATH,
    line,
    `"${pairing}" clears the ${DISABLED_CONTRAST_FLOOR}:1 disabled floor (or names no measured ` +
      'pairing); delete the entry',
  )
}

/* ------------------------------------------------------------------ *
 * Exemptions and report
 * ------------------------------------------------------------------ */

const suppressed = violations.filter((violation) =>
  markerLinesByPath.get(violation.path)?.has(violation.line),
)
const suppressedSet = new Set(suppressed)
// Everything an allow-marker did not carve out is a failure. There is nothing
// between "the marker documents why" and "fix it".
const live = violations.filter((violation) => !suppressedSet.has(violation))

const byRule = new Map(RULE_IDS.map((rule) => [rule, []]))
for (const violation of live) byRule.get(violation.rule).push(violation)
for (const list of byRule.values()) list.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)

if (!QUIET) {
  const grouped = new Map()
  for (const violation of live) {
    if (!grouped.has(violation.path)) grouped.set(violation.path, [])
    grouped.get(violation.path).push(violation)
  }
  for (const [path, list] of [...grouped.entries()].sort()) {
    process.stdout.write(`\n${path}\n`)
    for (const violation of list.sort((a, b) => a.line - b.line || a.column - b.column)) {
      process.stdout.write(
        `  ${violation.line}:${violation.column}  ${violation.rule}  ${violation.text}\n`,
      )
    }
  }
  for (const error of markerErrors) {
    process.stdout.write(
      `\n${error.path}\n  ${error.line}:1  allow-marker-without-reason  ` +
        `\`${ALLOW_MARKER} <reason>\` needs a reason\n`,
    )
  }
}

if (!QUIET) {
  process.stdout.write('\nDesign-system conformance summary\n')
  process.stdout.write(
    `  scope: ${SOURCE_ROOT} (${sourceFiles.length} files) + ${APP_CSS_PATH} vs ${BUNDLE_CSS_PATH}\n`,
  )
  process.stdout.write(
    toleratedDisabledContrast.length > 0
      ? '  tolerance: the disabled-contrast baseline below, and nothing else\n'
      : '  tolerance: none — any violation fails\n',
  )
  for (const rule of RULE_IDS) {
    process.stdout.write(`  ${rule}: ${byRule.get(rule).length} found\n`)
  }
  if (suppressed.length > 0) {
    process.stdout.write(`  suppressed by \`${ALLOW_MARKER}\` markers: ${suppressed.length}\n`)
  }
  // Named, with their measured ratios, on every run: a tolerated failure that
  // prints nothing is one nobody clears.
  if (toleratedDisabledContrast.length > 0) {
    process.stdout.write(
      `  tolerated by ${DISABLED_CONTRAST_BASELINE_PATH}: ${toleratedDisabledContrast.length}\n`,
    )
    for (const { pairing, ratio } of toleratedDisabledContrast) {
      const [theme, surface] = pairing.split(':')
      process.stdout.write(
        `    ${theme}: --text-disabled ${ratio.toFixed(2)}:1 on ${surface}\n`,
      )
    }
  }
}

const failures = live.length + markerErrors.length
process.stdout.write(`Violations: ${live.length}\n`)

if (failures > 0 && !QUIET) {
  process.stdout.write('\n')
  const rules = new Set(live.map((violation) => violation.rule))
  for (const rule of RULE_IDS) {
    if (rules.has(rule)) process.stdout.write(`  ${rule} — ${FIX_HINT[rule]}\n`)
  }
  process.stdout.write(
    `  Document a genuine exception with \`${ALLOW_MARKER} <reason>\` on the violating\n` +
      '  line or one of the two lines above it.\n',
  )
}

// CI safety: a wrong cwd or a moved tree would otherwise pass silently.
if (sourceFiles.length === 0) {
  process.stdout.write(`\nNo source files under ${SOURCE_ROOT}. Run this from the repo root.\n`)
  process.exit(2)
}

process.exit(!REPORT_ONLY && failures > 0 ? 1 : 0)
