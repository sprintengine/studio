// Does this icon bring its own ground? (owner ruling 2026-09-01)
//
// Two kinds of artwork reach the icon slot. An APP icon — the marketplace's
// agent CLIs, automations, modules, model providers — is drawn on its own
// rounded plate and reads on any theme; wrapping it in the neutral chip put a
// white frame around a framed thing. A BRAND MARK — GitHub, Notion, the
// Simple Icons glyphs the MCP catalogue carries — is a single flat path in the
// brand's colour, and ~110 of them are near-black: bare on a dark theme they
// vanish. So the slot asks the artwork which it is, and only the flat mark gets
// the chip.
//
// The answer is read off the SVG itself: a `<rect>` or `<circle>` that covers
// (nearly) the whole viewBox in a real fill is a plate. A raster is treated as
// an app icon — nobody ships a transparent single-colour PNG glyph — and a
// remote URL, which cannot be inspected without a fetch, keeps the chip; the
// chip is the safe wrong answer, a vanished icon is not.
//
// Pure and memoised: the same data URI is asked about by every row, popover
// and shelf that shows the entry, and decoding base64 per render would be a
// price paid for nothing.

const PLATE_COVERAGE = 0.9

const answers = new Map<string, boolean>()

function decodeSvgDataUri(src: string): string | null {
  const comma = src.indexOf(',')
  if (comma === -1) return null
  const header = src.slice(0, comma)
  const payload = src.slice(comma + 1)
  try {
    // `atob` is a browser global and a Node global alike, so the same code
    // runs in the renderer and under the test runner.
    if (/;base64/i.test(header)) return atob(payload)
    return decodeURIComponent(payload)
  } catch {
    return null
  }
}

function attribute(tag: string, name: string): string | null {
  const match = tag.match(new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, 'i'))
  return match ? match[1].trim() : null
}

// A length attribute as a number in user units; `100%` resolves against the
// viewBox span it is measured on.
function length(value: string | null, span: number): number {
  if (!value) return 0
  if (value.endsWith('%')) return (parseFloat(value) / 100) * span
  const numeric = parseFloat(value)
  return Number.isFinite(numeric) ? numeric : 0
}

function paints(tag: string): boolean {
  const fill = attribute(tag, 'fill')
  if (fill === null) {
    // No fill attribute: SVG's default is black, which is a plate. A style
    // attribute could still say `fill:none`.
    const style = attribute(tag, 'style') ?? ''
    return !/fill\s*:\s*none/i.test(style)
  }
  return fill.toLowerCase() !== 'none' && fill.toLowerCase() !== 'transparent'
}

export function svgHasOwnPlate(svg: string): boolean {
  const root = svg.match(/<svg\b[^>]*>/i)?.[0]
  if (!root) return false
  const viewBox = attribute(root, 'viewBox')
  let width: number
  let height: number
  if (viewBox) {
    const parts = viewBox.split(/[\s,]+/).map(Number)
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return false
    width = parts[2]
    height = parts[3]
  } else {
    width = length(attribute(root, 'width'), 0)
    height = length(attribute(root, 'height'), 0)
  }
  if (width <= 0 || height <= 0) return false

  for (const rect of svg.matchAll(/<rect\b[^>]*>/gi)) {
    const tag = rect[0]
    if (!paints(tag)) continue
    if (
      length(attribute(tag, 'width'), width) >= width * PLATE_COVERAGE &&
      length(attribute(tag, 'height'), height) >= height * PLATE_COVERAGE
    ) {
      return true
    }
  }
  for (const circle of svg.matchAll(/<circle\b[^>]*>/gi)) {
    const tag = circle[0]
    if (!paints(tag)) continue
    if (length(attribute(tag, 'r'), width) * 2 >= Math.min(width, height) * PLATE_COVERAGE) return true
  }
  return false
}

/**
 * True when the icon at `src` can stand in the slot bare; false when it needs
 * the neutral chip behind it (a flat brand mark, or artwork we cannot inspect).
 */
export function iconHasOwnPlate(src: string | null | undefined): boolean {
  if (!src) return false
  const cached = answers.get(src)
  if (cached !== undefined) return cached

  let answer = false
  if (src.startsWith('data:image/svg')) {
    const svg = decodeSvgDataUri(src)
    answer = svg ? svgHasOwnPlate(svg) : false
  } else if (src.startsWith('data:image/')) {
    answer = true
  }
  answers.set(src, answer)
  return answer
}
