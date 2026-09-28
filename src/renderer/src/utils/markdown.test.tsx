import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SkillFileRef } from '../../../shared/skills'
import {
  describeDeadSkillLink,
  resolveSkillLink,
} from '../components/workspace/globalSurface/extensions/skills/skillsSurfaceModel'
import type { GitLineChange } from './gitDiff'
import { renderMarkdown, type MarkdownLinkResolver } from './markdown'
import { expect, test } from 'vitest'

test('markdown', async () => {
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
    assert.match(html, />Image: Architecture diagram</)
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
})

function renderPlain(markdown: string): string {
  return renderToStaticMarkup(renderMarkdown(markdown))
}

test('a GitHub alert is drawn as its kind, with the marker taken out of the text', () => {
  for (const [marker, kind, label] of [
    ['NOTE', 'note', 'Note'],
    ['TIP', 'tip', 'Tip'],
    ['IMPORTANT', 'important', 'Important'],
    ['WARNING', 'warning', 'Warning'],
    ['caution', 'caution', 'Caution'],
  ]) {
    const html = renderPlain(`> [!${marker}]\n> Back up the **database** first.`)
    expect(html).toContain(`data-alert="${kind}"`)
    expect(html).toContain('role="note"')
    expect(html).toContain(`</svg>${label}</p>`)
    expect(html).toContain('Back up the <strong')
    expect(html).not.toContain('[!')
    expect(html).not.toContain('<blockquote')
  }
})

test('a blockquote that only mentions an alert marker stays a blockquote', () => {
  for (const markdown of ['> [!NOTE] inline title', '> Some text\n> [!NOTE]', '> [!NOTICE]\n> text']) {
    const html = renderPlain(markdown)
    expect(html, markdown).toContain('<blockquote')
    expect(html, markdown).not.toContain('data-alert')
  }
  // An alert inside a list item is still an alert.
  expect(renderPlain('- item\n\n  > [!TIP]\n  > Use the cache.')).toContain('data-alert="tip"')
})

test('a table offers a copy glyph and a menu of other formats, outside what a selection copies', () => {
  const html = renderPlain('| a | b |\n| - | - |\n| 1 | 2 |')
  expect(html).toContain('aria-label="Copy table"')
  expect(html).toContain('aria-label="Copy table as"')
  expect(html).toMatch(/<div data-copy-exclude=""[^>]*>.*aria-label="Copy table"/u)
})

test('a GFM column alignment reaches the cells', () => {
  for (const density of [undefined, 'compact', 'chat'] as const) {
    const html = renderToStaticMarkup(
      renderMarkdown('| Name | Size | Kind |\n| :--- | ---: | :---: |\n| a | 12 | file |', { density }),
    )
    expect(html, density).toMatch(/<th[^>]*style="text-align:right"[^>]*>Size<\/th>/u)
    expect(html, density).toMatch(/<td[^>]*style="text-align:right"[^>]*>12<\/td>/u)
    expect(html, density).toMatch(/<td[^>]*style="text-align:center"[^>]*>file<\/td>/u)
    expect(html, density).toMatch(/<td[^>]*style="text-align:left"[^>]*>a<\/td>/u)
  }
})

test('an image is stated by its alt text unless the surface can show it', () => {
  // Nothing is fetched: a web image is a link to open it, anything else is its name.
  const web = renderPlain('![Diagram](https://example.com/d.png)')
  expect(web).not.toContain('<img')
  expect(web).toMatch(/<a href="https:\/\/example\.com\/d\.png"[^>]*>Image: Diagram<\/a>/u)
  const local = renderPlain('![](./d.png)')
  expect(local).toContain('>Image<')
  expect(local).not.toContain('href=')
  const shown = renderToStaticMarkup(
    renderMarkdown('![Diagram](./d.png) and [![Badge](https://example.com/b.svg)](https://example.com)', {
      renderImage: (src, alt, inLink) => <img data-in-link={String(inLink)} src={src} alt={alt} />,
    }),
  )
  // The source reaches the renderer as written — a path is not a URL the page may load.
  expect(shown).toContain('<img data-in-link="false" src="./d.png" alt="Diagram"/>')
  expect(shown).toContain('<img data-in-link="true" src="https://example.com/b.svg" alt="Badge"/>')
})

function renderChat(markdown: string, options: Parameters<typeof renderMarkdown>[1] = {}): string {
  return renderToStaticMarkup(renderMarkdown(markdown, { density: 'chat', ...options }))
}

function classOf(html: string, tag: string): string {
  return new RegExp(`<${tag}[^>]*class="([^"]*)"`, 'u').exec(html)?.[1] ?? ''
}

// The chat scales are about how a reply looks, so these read the classes; each
// pins a decision, not a pixel.
test('a chat reply keeps its headings on the type ramp, a step or two above the body', () => {
  const html = renderChat('# Title\n\n## Section\n\n### Part\n\nBody')
  for (const tag of ['h1', 'h2', 'h3']) {
    expect(classOf(html, tag), tag).not.toMatch(/\btext-(?:3xl|2xl|xl|lg|base)\b/u)
    expect(classOf(html, tag), tag).toContain('font-semibold')
  }
  expect(classOf(html, 'h1')).toContain('text-title')
  expect(classOf(html, 'h3')).toContain('text-heading')
  expect(classOf(html, 'p')).toContain('text-heading')
  // The document scale is unchanged for the surfaces that are documents.
  expect(classOf(renderPlain('# Title'), 'h1')).toContain('text-3xl')
})

test('in a chat reply, headings, strong text and inline code take the strong ink over a quieter body', () => {
  const html = renderChat('## Plan\n\nRun **this** with `npm test`.')
  expect(classOf(html, 'p')).toContain('var(--markdown-ink)')
  for (const tag of ['h2', 'strong', 'code']) expect(classOf(html, tag), tag).toContain('var(--markdown-ink-strong)')
  expect(classOf(html, 'code')).not.toContain('--tone-warn')
})

test('a muted chat block says so on its root, and a quote steps its own ink down', () => {
  expect(renderChat('Thinking', { tone: 'muted' })).toMatch(
    /^<div class="markdown-rendered" data-density="chat" data-tone="muted">/u,
  )
  expect(renderChat('Reply')).not.toContain('data-tone')
  expect(renderChat('Reply', { density: 'chat-compact' })).toContain('data-density="chat-compact"')
  expect(classOf(renderChat('> quoted'), 'blockquote')).toContain('[--markdown-ink:var(--text-muted)]')
})

test('a short identifier in a chat reply moves to the next line whole; a long path may wrap', () => {
  expect(classOf(renderChat('Set `leading-6`.'), 'code')).toContain('whitespace-nowrap')
  const path = 'src/renderer/src/components/panels/agentChat/conversationLinks.tsx'
  expect(classOf(renderChat(`See \`${path}\`.`), 'code')).not.toContain('whitespace-nowrap')
})

test('an ordered list that runs past nine widens its gutter to hold the number', () => {
  const short = renderChat('1. a\n2. b')
  const long = renderChat(Array.from({ length: 12 }, (_, index) => `${index + 1}. item`).join('\n'))
  expect(short).not.toMatch(/<ol[^>]*style=/u)
  expect(long).toMatch(/<ol[^>]*style="padding-inline-start:calc\(3ch \+ 0\.4em\)"/u)
})

test('a GitHub alert in a chat reply draws its title and leaves the marker out', () => {
  const html = renderChat('> [!WARNING]\n> Back up the **database** first.')
  expect(html).toContain('data-alert="warning"')
  expect(html).toContain('>Warning</p>')
  expect(html).not.toContain('[!WARNING]')
})

test('a fence names its file from the info string, keyed or bare, and the code block receives it', () => {
  const seen: Array<string | undefined> = []
  const Code = ({ filename }: { code: string; filename?: string }) => {
    seen.push(filename)
    return null
  }
  const source = [
    '```ts src/app.ts',
    'export {}',
    '```',
    '',
    '```ts title="src/title.ts"',
    'export {}',
    '```',
    '',
    '```bash',
    'ls',
    '```',
  ].join('\n')
  renderToStaticMarkup(<>{renderMarkdown(source, { codeBlock: Code })}</>)
  assert.deepEqual(seen, ['src/app.ts', 'src/title.ts', undefined])
})
