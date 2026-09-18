// Pulling the pieces the Design door renders out of a bundle's authored files.
//
// Pure string work, kept out of the main-process reader so it can be tested
// without a filesystem — and out of the renderer so bundle-layout knowledge
// stays on one side of the IPC boundary.
//
// There is no HTML parser here on purpose: the main process has no DOM, and
// adding a dependency to read demo markup we only ever re-serialise would be a
// large cost for no gain. What we need is narrow and structural — the `<style>`
// blocks, and the top-level children of `<body>` — so a small tag scanner does
// it, and its edge cases are covered by tests rather than assumed.

import type { DesignSystemComponentDoc, DesignSystemStage } from './bundle-view'

/** Elements that never have a closing tag, so the scanner must not wait for one. */
const VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
])

/** Extract the contents of every `<style>` block, in document order. */
export function extractStyleBlocks(html: string): string[] {
  const blocks: string[] = []
  const pattern = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi
  let match: RegExpExecArray | null
  while ((match = pattern.exec(html)) !== null) blocks.push(match[1])
  return blocks
}

/**
 * The inner HTML of `<body>`, or the whole input when there is no `<body>`.
 *
 * A `component.html` is a full document by convention, but a bundle that ships a
 * fragment still renders — the format does not forbid it, so neither do we.
 */
export function extractBodyHtml(html: string): string {
  const open = /<body\b[^>]*>/i.exec(html)
  if (!open) return stripDocumentFurniture(html)
  const start = open.index + open[0].length
  const close = html.toLowerCase().lastIndexOf('</body>')
  return close > start ? html.slice(start, close) : html.slice(start)
}

/** Remove head/doctype furniture from a fragment that declared no `<body>`. */
function stripDocumentFurniture(html: string): string {
  return html
    .replace(/<!doctype[^>]*>/gi, '')
    .replace(/<\/?html\b[^>]*>/gi, '')
    .replace(/<head\b[\s\S]*?<\/head\s*>/gi, '')
}

/**
 * Split a body into its top-level element children, in document order.
 *
 * Each is a "stage" — by the bundle format's own convention a `component.html`
 * carries one `data-mode="light"` stage and one `data-mode="dark"` stage, which
 * is a load-bearing convention rather than a coincidence: `build-catalog.mjs`
 * fails its build if toggling dark is a no-op. Text between elements (whitespace,
 * stray prose) is not a stage and is dropped.
 *
 * A body with no element children yields a single stage holding the body itself,
 * so a component that is bare markup still previews.
 */
export function extractStages(bodyHtml: string): DesignSystemStage[] {
  const stages: DesignSystemStage[] = []
  let depth = 0
  let elementStart = -1
  const tagPattern = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>/g
  let match: RegExpExecArray | null
  while ((match = tagPattern.exec(bodyHtml)) !== null) {
    const [raw, slash, rawName, attributes] = match
    const name = rawName.toLowerCase()
    if (VOID_ELEMENTS.has(name) || attributes.trimEnd().endsWith('/')) {
      // Self-closing at depth 0 is a whole stage on its own (an `<img>` demo).
      if (depth === 0) {
        stages.push({ mode: modeAttribute(attributes), html: raw })
      }
      continue
    }
    if (!slash) {
      if (depth === 0) elementStart = match.index
      depth += 1
      continue
    }
    depth -= 1
    if (depth === 0 && elementStart >= 0) {
      const end = match.index + raw.length
      const html = bodyHtml.slice(elementStart, end)
      stages.push({ mode: modeAttribute(openingAttributes(html)), html })
      elementStart = -1
    }
    // Defensive: a stray close tag would drive depth negative and then treat the
    // next open tag as nested. Clamp rather than mis-slice the rest of the file.
    if (depth < 0) depth = 0
  }
  if (stages.length === 0) {
    const trimmed = bodyHtml.trim()
    return trimmed ? [{ mode: null, html: trimmed }] : []
  }
  return stages
}

function openingAttributes(elementHtml: string): string {
  const open = /^<[a-zA-Z][a-zA-Z0-9-]*\b([^>]*)>/.exec(elementHtml)
  return open ? open[1] : ''
}

function modeAttribute(attributes: string): string | null {
  const match = /\bdata-mode\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(attributes)
  if (!match) return null
  return (match[2] ?? match[3] ?? match[4] ?? '').trim() || null
}

/**
 * Pick the stage a tile shows: the one whose `data-mode` matches the app, else
 * the first.
 *
 * The tile shows ONE representative rendering — that is what keeps a hundred of
 * them scannable — and the detail view shows every stage. Matching the app's mode
 * means a specimen in a dark app is not a white rectangle.
 */
export function representativeStage(stages: readonly DesignSystemStage[], mode: string): DesignSystemStage | null {
  if (stages.length === 0) return null
  return stages.find((stage) => stage.mode === mode) ?? stages[0]
}

// ── component.md ─────────────────────────────────────────────────────────────

/** The five headings the bundle format fixes and test-enforces. */
const DOC_SECTIONS = ['Anatomy', 'Variants', 'States', 'Usage', 'Accessibility'] as const

/**
 * Split `component.md` into its five fixed sections, as authored.
 *
 * Returns null when the document declares none of them — a component with no
 * doc renders its previews and no prose, rather than five empty headings.
 * Content is returned verbatim: the door renders what the author wrote and never
 * summarises it.
 */
export function parseComponentDoc(markdown: string): DesignSystemComponentDoc | null {
  const found = new Map<string, string>()
  // Headings at any level, so a bundle using `##` or `###` both parse.
  const pattern = /^#{1,6}\s*([A-Za-z][A-Za-z ]*?)\s*$/gm
  const marks: Array<{ name: string; start: number; end: number }> = []
  let match: RegExpExecArray | null
  while ((match = pattern.exec(markdown)) !== null) {
    marks.push({ name: match[1].trim(), start: match.index, end: match.index + match[0].length })
  }
  for (let index = 0; index < marks.length; index += 1) {
    const mark = marks[index]
    const canonical = DOC_SECTIONS.find((section) => section.toLowerCase() === mark.name.toLowerCase())
    if (!canonical) continue
    const next = marks[index + 1]?.start ?? markdown.length
    found.set(canonical, markdown.slice(mark.end, next).trim())
  }
  if (found.size === 0) return null
  return {
    anatomy: found.get('Anatomy') ?? '',
    variants: found.get('Variants') ?? '',
    states: found.get('States') ?? '',
    usage: found.get('Usage') ?? '',
    accessibility: found.get('Accessibility') ?? '',
  }
}

/**
 * Count the list items in a `component.md` section.
 *
 * This is the only honest source for "3 variants": the bundle format declares no
 * variant markup contract, so counting rendered DOM nodes would be counting demo
 * rows, not variants. A section with no list returns null and the tile shows no
 * count rather than a number it made up.
 */
export function countDocListItems(section: string | undefined): number | null {
  if (!section) return null
  const items = section.split('\n').filter((line) => /^\s{0,3}([-*+]|\d+[.)])\s+\S/.test(line))
  return items.length > 0 ? items.length : null
}

/** Sentence case: `principles.md` rejects uppercase letter-spaced labels. */
export function sentenceCaseLabel(key: string): string {
  const spaced = key.replace(/[-_]/g, ' ').trim()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}
