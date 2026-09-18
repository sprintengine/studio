import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SkillFileRef } from '../../../shared/skills'
import {
  describeDeadSkillLink,
  resolveSkillLink,
} from '../components/workspace/globalSurface/extensions/skills/skillsSurfaceModel'
import type { GitLineChange } from './gitDiff'
import { renderMarkdown, type MarkdownLinkResolver } from './markdown'

function render(markdown: string, lineChanges: GitLineChange[] = []): string {
  return renderToStaticMarkup(renderMarkdown(markdown, { lineChanges }))
}

/**
 * The skill reader's own wiring, not a stand-in for it: the resolver below is
 * the production one from the skills surface. A hand-rolled copy would let this
 * suite keep passing while the real resolver drifted, which is the one way a
 * guard test can lie.
 *
 * It matters that hostile content is rendered through *this* path as well as the
 * plain one, because a resolver makes `urlTransform` conditional — that branch
 * is exactly what an injected href would have to get through.
 */
function renderWithCorpus(markdown: string, paths: string[]): string {
  const files: SkillFileRef[] = paths.map((path) => ({
    path,
    size: 1,
    blobSha: '',
    isEntry: path === 'SKILL.md',
  }))
  const links: MarkdownLinkResolver = {
    resolve: (href) => {
      const target = resolveSkillLink(files, 'SKILL.md', href)
      if (!target) return null
      return target.kind === 'file'
        ? { kind: 'file', path: target.path }
        : { kind: 'dead', reason: describeDeadSkillLink(target.target) }
    },
    open: () => undefined,
  }
  return renderToStaticMarkup(renderMarkdown(markdown, { density: 'compact', links }))
}

function countMatches(value: string, pattern: RegExp): number {
  return Array.from(value.matchAll(pattern)).length
}

function testOrderedListsRenderAsSingleOrderedList(): void {
  const html = render(['1. First', '2. Second', '3. Third'].join('\n'))

  assert.match(html, /<ol[^>]*>/)
  assert.equal(countMatches(html, /<li/g), 3)
  assert.match(html, />First</)
  assert.match(html, />Second</)
  assert.match(html, />Third</)
}

function testGfmTaskListsKeepCheckboxState(): void {
  const html = render(['- [x] Done', '- [ ] Todo'].join('\n'))

  assert.equal(countMatches(html, /type="checkbox"/g), 2)
  assert.equal(countMatches(html, /checked=""/g), 1)
  assert.match(html, /class="[^"]*task-list-item/)
}

function testUnsafeAndRelativeLinksAreInert(): void {
  const html = render(
    ['[External](https://example.com)', '[Relative](docs/plan.md)', '[Script](javascript:alert(1))'].join('\n\n'),
  )

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
  const html = render(['# Title', '', 'Body text'].join('\n'), [{ kind: 'added', startLine: 3, endLine: 3 }])

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
 * The renderer styles an author's content, so it must never restyle their words.
 * A heading arrives in whatever case its author wrote and leaves in the same one:
 * no `uppercase`, no `text-transform`, at either density.
 */
function testHeadingsKeepTheAuthorsOwnCase(): void {
  const source = ['# Running the release', '', '###### Session notes'].join('\n')

  for (const html of [render(source), renderWithCorpus(source, ['SKILL.md'])]) {
    assert.doesNotMatch(html, /class="[^"]*\buppercase\b/, 'no uppercase class on any heading')
    assert.doesNotMatch(html, /text-transform/i, 'no text-transform on any heading')
    assert.match(html, />Running the release</)
    assert.match(html, /<h6[^>]*>Session notes<\/h6>/)
  }
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

  // Traversal is *normalised back into* the corpus rather than followed out of
  // it: `../../../scripts/run.sh` collapses to `scripts/run.sh`, which the skill
  // does carry, so it opens. Recorded because it looks like an escape and is
  // not — the resolver can only ever name a file the manifest already lists,
  // which is the property that makes the reader safe.
  const collapsed = renderWithCorpus('[run](../../../scripts/run.sh)', [...files, 'scripts/run.sh'])
  assert.match(collapsed, /<button[^>]*>run<\/button>/)
  assert.doesNotMatch(collapsed, /href=/)

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
testHeadingsKeepTheAuthorsOwnCase()
testCorpusLinksOnlyOpenFilesTheSkillActuallyCarries()
console.log('markdown: ok')
