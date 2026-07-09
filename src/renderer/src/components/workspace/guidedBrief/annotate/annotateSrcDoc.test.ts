import assert from 'node:assert/strict'
import {
  composeAnnotateSrcDoc,
  neutralizeAuthorScripts,
} from './annotateSrcDoc'
import { buildAnnotatePickerSource } from './pickerRuntime'
import {
  ANNOTATE_MESSAGE_CHANNEL,
  overlayRectToPageRect,
  pageRectToOverlayRect,
  parseAnnotateMessage,
  readTrustedAnnotateMessage,
  type OverlayTransform,
} from './bridge'
import type { AnnotationRect } from './types'
import {
  buildSnippetExcerpt,
  buildUniqueSelector,
  describeElementChip,
  type SelectorNode,
} from './selector'

// --- srcDoc composition: author scripts cannot execute; ours is the only one ---

// A <script> is executable iff it has no type, or a JS/module type. Neutralized
// scripts carry type="text/plain" and must never count as executable.
const EXECUTABLE_TYPES = new Set(['', 'module', 'text/javascript', 'application/javascript'])

function scriptTags(html: string): { attrs: string; executable: boolean }[] {
  const tags: { attrs: string; executable: boolean }[] = []
  for (const match of html.matchAll(/<script\b([^>]*)>/gi)) {
    const attrs = match[1]
    const typeMatch = attrs.match(/\btype\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i)
    const type = (typeMatch ? typeMatch[2] ?? typeMatch[3] ?? typeMatch[4] ?? '' : '').trim().toLowerCase()
    tags.push({ attrs, executable: EXECUTABLE_TYPES.has(type) })
  }
  return tags
}

const authored = `<!doctype html><html><head>
  <script>window.__pwned = true</script>
  <script type="text/javascript">console.log('author code ran')</script>
  <script type="module" src="./evil.js"></script>
</head><body><h1>Mockup</h1></body></html>`

// Neutralization alone: every author script becomes inert text/plain.
const neutralized = neutralizeAuthorScripts(authored)
for (const tag of scriptTags(neutralized)) {
  assert.equal(tag.executable, false, `author script must be neutralized: <script${tag.attrs}>`)
  assert.match(tag.attrs, /type="text\/plain"/, 'neutralized script is retyped to text/plain')
}
// The inline body survives only as inert text/plain content — never as a bare
// executable <script> the browser would run.
assert.doesNotMatch(neutralized, /<script>\s*window\.__pwned/, 'no bare executable inline script survives')

// Full compose: exactly one executable script and it is our picker.
const composed = composeAnnotateSrcDoc(authored)
const composedTags = scriptTags(composed)
const executable = composedTags.filter((t) => t.executable)
assert.equal(executable.length, 1, 'exactly one executable script after composition')
assert.match(executable[0].attrs, /data-annotate-picker="true"/, 'the only executable script is the injected picker')
assert.equal(
  composedTags.filter((t) => /data-annotate-neutralized="true"/.test(t.attrs)).length,
  3,
  'all three author scripts are marked neutralized',
)

// The picker is injected inside <body> so it runs after author markup parses.
assert.match(composed, /<script data-annotate-picker="true">[^]*<\/script><\/body>/, 'picker injected before </body>')
// The picker source is embedded verbatim — the composer must not mangle it (a
// `$&`-style string replacement would corrupt minified `$` identifiers).
assert.ok(composed.includes(buildAnnotatePickerSource()), 'picker source embedded byte-for-byte')

// Fallback when there is no <body>: still appended, still the only executable one.
const noBody = composeAnnotateSrcDoc('<div>fragment</div><script>steal()</script>')
const noBodyExec = scriptTags(noBody).filter((t) => t.executable)
assert.equal(noBodyExec.length, 1)
assert.match(noBodyExec[0].attrs, /data-annotate-picker/)

// The injected source is syntactically valid and self-contained (compiles).
const pickerSource = buildAnnotatePickerSource()
assert.doesNotThrow(() => new Function(pickerSource), 'picker source parses as valid JS')
assert.doesNotMatch(pickerSource, /<\/script>/i, 'picker source contains no </script> breakout sequence')
assert.match(pickerSource, new RegExp(ANNOTATE_MESSAGE_CHANNEL), 'picker source carries the channel constant')

// --- Selector builder: id fast-path, class/nth chains, sibling uniqueness ---

function node(tagName: string, opts: Partial<SelectorNode> = {}): SelectorNode {
  return {
    tagName,
    id: opts.id ?? null,
    classNames: opts.classNames ?? [],
    parent: opts.parent ?? null,
    nthOfType: opts.nthOfType ?? 1,
    typeSiblingCount: opts.typeSiblingCount ?? 1,
  }
}

// Id fast-path: an id stops the climb regardless of ancestry.
const withId = node('div', { id: 'main', parent: node('body') })
assert.equal(buildUniqueSelector(withId), '#main')

// Unsafe id falls back to the structural chain rather than a broken selector.
const oddId = node('div', { id: 'has spaces', parent: node('section', { id: 'root' }) })
assert.equal(buildUniqueSelector(oddId), '#root > div')

// Class chain, single-of-type: no nth-of-type appended.
const classed = node('h2', { classNames: ['p-h', 'strong'], parent: node('header', { parent: node('body') }) })
assert.equal(buildUniqueSelector(classed), 'body > header > h2.p-h.strong')

// Sibling-heavy: three same-tag siblings each get a distinct nth-of-type, so
// selectors are unique even though tag+classes collide.
const parent = node('ul', { parent: node('body') })
const li2 = node('li', { classNames: ['row'], parent, nthOfType: 2, typeSiblingCount: 3 })
const li3 = node('li', { classNames: ['row'], parent, nthOfType: 3, typeSiblingCount: 3 })
assert.equal(buildUniqueSelector(li2), 'body > ul > li.row:nth-of-type(2)')
assert.notEqual(buildUniqueSelector(li2), buildUniqueSelector(li3), 'sibling selectors are distinct')

// Unsafe class tokens are skipped but the chain stays unique via nth-of-type.
const weird = node('div', { classNames: ['ok', 'has space'], parent, nthOfType: 1, typeSiblingCount: 2 })
assert.equal(buildUniqueSelector(weird), 'body > ul > div.ok:nth-of-type(1)')

// Snippet excerpt: whitespace collapsed and capped with an ellipsis.
assert.equal(buildSnippetExcerpt('<p>\n  hello   world  </p>'), '<p> hello world </p>')
const long = `<div>${'x'.repeat(500)}</div>`
const excerpt = buildSnippetExcerpt(long, 40)
assert.equal(excerpt.length, 40, 'excerpt capped to max length including ellipsis')
assert.ok(excerpt.endsWith('…'), 'capped excerpt ends with an ellipsis')

// Hover chip: tag · first-safe-class — "text hint".
assert.equal(
  describeElementChip({ tagName: 'H2', classNames: ['p-h'] }, "  Today's jobs  "),
  'h2 · .p-h — "Today\'s jobs"',
)
assert.equal(describeElementChip({ tagName: 'DIV', classNames: [] }, ''), 'div')

// --- Bridge protocol: source/shape validation and coordinate round-trips ---

const frameWindow = { id: 'frame' }
const validSelect = {
  channel: ANNOTATE_MESSAGE_CHANNEL,
  type: 'select',
  selector: 'body > h1',
  tagName: 'h1',
  snippet: '<h1>Hi</h1>',
  rect: { x: 1, y: 2, width: 3, height: 4 },
  scrollOffset: { x: 5, y: 6 },
}

// Wrong source is rejected even with a well-formed, on-channel payload.
assert.equal(readTrustedAnnotateMessage({ source: { id: 'other' }, data: validSelect }, frameWindow), null)
// A null frame window (iframe not mounted) trusts nothing.
assert.equal(readTrustedAnnotateMessage({ source: frameWindow, data: validSelect }, null), null)
// Correct source + valid payload passes and returns the typed message.
const trusted = readTrustedAnnotateMessage({ source: frameWindow, data: validSelect }, frameWindow)
assert.equal(trusted?.type, 'select')

// Off-channel or malformed payloads are rejected by the parser.
assert.equal(parseAnnotateMessage({ ...validSelect, channel: 'other' }), null, 'off-channel rejected')
assert.equal(parseAnnotateMessage({ channel: ANNOTATE_MESSAGE_CHANNEL, type: 'nope' }), null, 'unknown type rejected')
assert.equal(
  parseAnnotateMessage({ ...validSelect, rect: { x: 1, y: 2, width: 3 } }),
  null,
  'malformed rect rejected',
)
assert.equal(
  parseAnnotateMessage({ ...validSelect, scrollOffset: { x: 'nope', y: 6 } }),
  null,
  'non-numeric scroll offset rejected',
)
assert.deepEqual(parseAnnotateMessage({ channel: ANNOTATE_MESSAGE_CHANNEL, type: 'ready' }), {
  channel: ANNOTATE_MESSAGE_CHANNEL,
  type: 'ready',
})

// Coordinate transform round-trips under every zoom and non-zero scroll/offset.
const pageRect: AnnotationRect = { x: 120.5, y: 84.25, width: 220, height: 48 }
for (const zoom of [1, 0.75, 0.5]) {
  const transform: OverlayTransform = { zoom, scroll: { x: 40, y: 200 }, offsetX: 16, offsetY: 24 }
  const overlay = pageRectToOverlayRect(pageRect, transform)
  const recovered = overlayRectToPageRect(overlay, transform)
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    assert.ok(
      Math.abs(recovered[key] - pageRect[key]) < 1e-9,
      `round-trip ${key} at zoom ${zoom}: ${recovered[key]} vs ${pageRect[key]}`,
    )
  }
}

console.log('annotateSrcDoc.test.ts: ok')
