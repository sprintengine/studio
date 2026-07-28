import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import type { GitLineChange } from './gitDiff'
import { renderMarkdown, type MarkdownLinkResolver } from './markdown'

function render(markdown: string, lineChanges: GitLineChange[] = []): string {
  return renderToStaticMarkup(renderMarkdown(markdown, { lineChanges }))
}

/**
 * The skill reader's shape: a resolver that owns a corpus. It exists here so
 * hostile content is rendered through the *same* branch the reader uses —
 * a resolver makes `urlTransform` conditional, which is exactly the branch an
 * injected href would have to get through.
 */
function renderWithCorpus(markdown: string, files: string[]): string {
  const links: MarkdownLinkResolver = {
    resolve: (href) => {
      const raw = href.trim()
      if (!raw || raw.startsWith('#')) return null
      if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return null
      const bare = raw.split('#')[0].split('?')[0].replace(/^\.\//, '').replace(/^\/+/, '')
      const hit = files.find((path) => path === bare)
      return hit ? { kind: 'file', path: hit } : { kind: 'dead', reason: `${bare} is not one of this skill's files.` }
    },
    open: () => undefined,
  }
  return renderToStaticMarkup(renderMarkdown(markdown, { density: 'compact', links }))
}

function countMatches(value: string, pattern: RegExp): number {
  return Array.from(value.matchAll(pattern)).length
}

function testOrderedListsRenderAsSingleOrderedList(): void {
  const html = render([
    '1. First',
    '2. Second',
    '3. Third',
  ].join('\n'))

  assert.match(html, /<ol[^>]*>/)
  assert.equal(countMatches(html, /<li/g), 3)
  assert.match(html, />First</)
  assert.match(html, />Second</)
  assert.match(html, />Third</)
}

function testGfmTaskListsKeepCheckboxState(): void {
  const html = render([
    '- [x] Done',
    '- [ ] Todo',
  ].join('\n'))

  assert.equal(countMatches(html, /type="checkbox"/g), 2)
  assert.equal(countMatches(html, /checked=""/g), 1)
  assert.match(html, /class="[^"]*task-list-item/)
}

function testUnsafeAndRelativeLinksAreInert(): void {
  const html = render([
    '[External](https://example.com)',
    '[Relative](docs/plan.md)',
    '[Script](javascript:alert(1))',
  ].join('\n\n'))

  assert.match(html, /<a href="https:\/\/example\.com"[^>]*>External<\/a>/)
  assert.doesNotMatch(html, /href="docs\/plan\.md"/)
  assert.doesNotMatch(html, /href="javascript:/)
  assert.match(html, /<span[^>]*>Relative<\/span>/)
  assert.match(html, /<span[^>]*>Script<\/span>/)
}

function testImagesRenderAsPlaceholders(): void {
  const html = render('![Architecture diagram](https://example.com/diagram.png)')

  assert.doesNotMatch(html, /<img/)
  assert.match(html, /\[Image: Architecture diagram\]/)
}

function testPreviewChangeMarkersAttachToChangedBlocks(): void {
  const html = render([
    '# Title',
    '',
    'Body text',
  ].join('\n'), [
    { kind: 'added', startLine: 3, endLine: 3 },
  ])

  assert.match(html, /<p class="[^"]*markdown-change-block markdown-change-added[^"]*">Body text<\/p>/)
  assert.doesNotMatch(html, /<h1 class="[^"]*markdown-change-added/)
}

/**
 * A skill document is bytes from a repository nobody vetted, rendered in the
 * app's own window. These are the payloads that seam has to survive.
 */
function testHostileSkillContentNeitherExecutesNorNavigates(): void {
  const payloads = [
    '<script>window.__pwned = 1</script>',
    '<img src=x onerror="window.__pwned = 1">',
    '<iframe src="https://evil.example"></iframe>',
    '<a href="javascript:alert(1)">click</a>',
    '<svg onload="window.__pwned = 1"></svg>',
    '<style>body{display:none}</style>',
    '<div onmouseover="window.__pwned = 1">hover</div>',
    '[js](javascript:alert(1))',
    '[JS](JaVaScRiPt:alert(1))',
    // A tab inside the scheme is stripped by the URL parser, so the guard has
    // to reject the parsed protocol, not the literal text.
    '[js-tab](java\tscript:alert(1))',
    '[data](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
    '[vb](vbscript:msgbox(1))',
    '[file](file:///etc/passwd)',
    '[proto-relative](//evil.example/x)',
    '![img](javascript:alert(1))',
    '![img](data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9ImFsZXJ0KDEpIi8+)',
  ]

  for (const source of payloads) {
    for (const html of [render(source), renderWithCorpus(source, ['SKILL.md', 'LOGIC.md'])]) {
      assert.doesNotMatch(html, /<script/i, `no script element from: ${source}`)
      assert.doesNotMatch(html, /<iframe/i, `no iframe from: ${source}`)
      assert.doesNotMatch(html, /<svg/i, `no svg from: ${source}`)
      assert.doesNotMatch(html, /<style/i, `no style element from: ${source}`)
      assert.doesNotMatch(html, /<img/i, `no img element from: ${source}`)
      // Anchored to a real tag: the same bytes appearing escaped inside text
      // (`&lt;img ... onerror=&quot;`) is the guard working, not a failure.
      assert.doesNotMatch(html, /<[a-z][^>]*\son[a-z]+=/i, `no event-handler attribute from: ${source}`)
      assert.doesNotMatch(html, /href="\s*javascript:/i, `no javascript: href from: ${source}`)
      assert.doesNotMatch(html, /href="\s*data:/i, `no data: href from: ${source}`)
      assert.doesNotMatch(html, /href="\s*vbscript:/i, `no vbscript: href from: ${source}`)
      assert.doesNotMatch(html, /href="\s*file:/i, `no file: href from: ${source}`)
      assert.doesNotMatch(html, /href="\/\//, `no protocol-relative href from: ${source}`)
    }
  }

  // Raw HTML is escaped into visible text rather than silently dropped, so a
  // reader can see what the skill tried to do.
  assert.match(render('<script>window.__pwned = 1</script>'), /&lt;script&gt;/)
}

/**
 * The reader's new link path: an href only becomes a control when the skill's
 * own manifest carries that file. Everything else is inert, and a traversal
 * out of the corpus is inert too.
 */
function testCorpusLinksOnlyOpenFilesTheSkillActuallyCarries(): void {
  const files = ['SKILL.md', 'LOGIC.md']

  // A file the skill carries becomes a button, never an anchor with an href.
  const hit = renderWithCorpus('[Logic](LOGIC.md)', files)
  assert.match(hit, /<button[^>]*type="button"[^>]*>Logic<\/button>/)
  assert.doesNotMatch(hit, /href=/)

  // Traversal out of the corpus, absolute paths and unknown files are dead
  // text — they never render as a link and never carry an href.
  for (const href of [
    '../../../../etc/passwd',
    '/etc/shadow',
    '../../.claude/settings.json',
    'MISSING.md',
    '..%2f..%2fetc%2fpasswd',
  ]) {
    const html = renderWithCorpus(`[x](${href})`, files)
    assert.doesNotMatch(html, /href=/, `no href for ${href}`)
    assert.doesNotMatch(html, /<button/, `no control for ${href}`)
    assert.match(html, /<span[^>]*>x/, `${href} renders as inert text`)
  }

  // An external https link still works, and still leaves no opener handle.
  const external = renderWithCorpus('[Docs](https://example.com/docs)', files)
  assert.match(external, /<a href="https:\/\/example\.com\/docs"[^>]*rel="noreferrer"/)
  assert.match(external, /target="_blank"/)
}

testOrderedListsRenderAsSingleOrderedList()
testGfmTaskListsKeepCheckboxState()
testUnsafeAndRelativeLinksAreInert()
testImagesRenderAsPlaceholders()
testPreviewChangeMarkersAttachToChangedBlocks()
testHostileSkillContentNeitherExecutesNorNavigates()
testCorpusLinksOnlyOpenFilesTheSkillActuallyCarries()
console.log('markdown: ok')
