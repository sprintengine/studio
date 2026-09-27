export type MarkdownSegments = { frozen: string[]; tail: string }

const BLOCK_HTML = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'body',
  'details',
  'div',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'main',
  'nav',
  'pre',
  'script',
  'section',
  'style',
  'table',
  'ul',
  'ol',
])

// Raw HTML left open swallows what follows, so nothing after it may freeze.
// Only prose counts: `<div>` in inline code or a code block is text.
function hasUnclosedHtml(prose: string): boolean {
  const comments = prose.match(/<!--/gu)?.length ?? 0
  if (comments > (prose.match(/-->/gu)?.length ?? 0)) return true
  const stack: string[] = []
  for (const match of prose.matchAll(/<\/?([a-z][a-z0-9-]*)\b[^>]*>/giu)) {
    const tag = match[1].toLowerCase()
    if (!BLOCK_HTML.has(tag) || match[0].endsWith('/>')) continue
    if (match[0].startsWith('</')) {
      if (stack.at(-1) === tag) stack.pop()
    } else {
      stack.push(tag)
    }
  }
  return stack.length > 0
}

const withoutCodeSpans = (line: string) => line.replace(/(`+)(.*?[^`])\1(?!`)/gu, '')

/** Split only after an independent, closed top-level fence and its blank line. */
export function splitMarkdownSegments(source: string): MarkdownSegments {
  if (/\r|\uFEFF/u.test(source) || /^ {0,3}\[(?:\^[^\]]+|[^\]]+)\]:/mu.test(source)) {
    return { frozen: [], tail: source }
  }

  const frozen: string[] = []
  const prose: string[] = []
  let segmentStart = 0
  let position = 0
  // A fence may be indented up to three spaces and still open a code block, so
  // it is tracked either way; only an unindented one (never a list item's)
  // ends a segment.
  let fence: { char: string; width: number; indented: boolean } | null = null
  let awaitingBlank = false

  while (position < source.length) {
    const newline = source.indexOf('\n', position)
    if (newline < 0) break
    const line = source.slice(position, newline)
    const next = newline + 1

    if (awaitingBlank) {
      if (/^[ \t]*$/u.test(line)) {
        if (hasUnclosedHtml(prose.join('\n'))) return { frozen: [], tail: source }
        frozen.push(source.slice(segmentStart, next))
        segmentStart = next
      }
      awaitingBlank = false
    }

    if (fence) {
      const closer = /^ {0,3}(`+|~+)[ \t]*$/u.exec(line)
      if (closer && closer[1][0] === fence.char && closer[1].length >= fence.width) {
        awaitingBlank = !fence.indented
        fence = null
      }
    } else {
      const opener = /^( {0,3})(`{3,}|~{3,})(.*)$/u.exec(line)
      if (opener && (opener[2][0] === '~' || !opener[3].includes('`'))) {
        fence = { char: opener[2][0], width: opener[2].length, indented: opener[1].length > 0 }
      } else prose.push(withoutCodeSpans(line))
    }
    position = next
  }

  return { frozen, tail: source.slice(segmentStart) }
}
