import assert from 'node:assert/strict'

import { adfToMarkdown, jiraBodyToMarkdown, wikiMarkupToMarkdown } from './jira-markup'

// The body-conversion contract (MC-1635): wiki markup and ADF convert best-effort
// to markdown, and the raw original is ALWAYS preserved — there is no lossy-only
// path. Each case pins a representative construct; the round-trip cases prove the
// raw payload survives so an unconvertible body is still usable.

function testWikiBlockAndInline(): void {
  assert.equal(wikiMarkupToMarkdown('h2. Summary'), '## Summary')
  assert.equal(wikiMarkupToMarkdown('The *quick* brown _fox_'), 'The **quick** brown *fox*')
  assert.equal(wikiMarkupToMarkdown('Use {{code}} here'), 'Use `code` here')
  assert.equal(wikiMarkupToMarkdown('This is -wrong- now'), 'This is ~~wrong~~ now')
  assert.equal(wikiMarkupToMarkdown('----'), '---')
  assert.equal(wikiMarkupToMarkdown('bq. Note this'), '> Note this')
  assert.equal(wikiMarkupToMarkdown('{color:red}urgent{color}'), 'urgent')
}

function testWikiLinks(): void {
  assert.equal(wikiMarkupToMarkdown('[Docs|https://x.example/d]'), '[Docs](https://x.example/d)')
  assert.equal(wikiMarkupToMarkdown('[https://x.example]'), '<https://x.example>')
  assert.equal(wikiMarkupToMarkdown('ping [~dana] please'), 'ping @dana please')
}

function testWikiLists(): void {
  assert.equal(wikiMarkupToMarkdown('# one\n# two'), '1. one\n1. two')
  assert.equal(wikiMarkupToMarkdown('* a\n** b'), '- a\n  - b')
}

function testWikiCodeBlocksAreProtected(): void {
  // Emphasis markers INSIDE a code block must not be transformed.
  assert.equal(wikiMarkupToMarkdown('{code:java}\nint a_b = *x*;\n{code}'), '```java\nint a_b = *x*;\n```')
  assert.equal(wikiMarkupToMarkdown('{noformat}\nplain _text_\n{noformat}'), '```\nplain _text_\n```')
}

function testWikiTable(): void {
  assert.equal(
    wikiMarkupToMarkdown('||Name||Role||\n|Ann|Dev|'),
    '| Name | Role |\n| --- | --- |\n| Ann | Dev |'
  )
}

function testSnakeCaseNotItalicised(): void {
  // A lone snake_case identifier has no closing boundary pair, so it is left be.
  assert.equal(wikiMarkupToMarkdown('call some_helper_fn now'), 'call some_helper_fn now')
}

function testAdfMarksAndBlocks(): void {
  const doc = {
    type: 'doc',
    version: 1,
    content: [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Title' }] },
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Hello ' },
          { type: 'text', text: 'bold', marks: [{ type: 'strong' }] },
          { type: 'text', text: ' and ' },
          { type: 'text', text: 'link', marks: [{ type: 'link', attrs: { href: 'https://x.example' } }] },
        ],
      },
      {
        type: 'bulletList',
        content: [
          { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }] },
          { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'b' }] }] },
        ],
      },
      { type: 'codeBlock', attrs: { language: 'html' }, content: [{ type: 'text', text: '<b>x</b>' }] },
    ],
  }
  assert.equal(
    adfToMarkdown(doc),
    '## Title\n\nHello **bold** and [link](https://x.example)\n\n- a\n- b\n\n```html\n<b>x</b>\n```'
  )
}

function testBodyDispatchAndRawPreservation(): void {
  assert.deepEqual(jiraBodyToMarkdown(null), { markdown: '' })
  assert.deepEqual(jiraBodyToMarkdown(''), { markdown: '' })

  const wiki = 'h1. Hi\n\n*bold*'
  const fromWiki = jiraBodyToMarkdown(wiki)
  assert.equal(fromWiki.raw, wiki, 'wiki raw preserved verbatim')
  assert.equal(fromWiki.markdown, '# Hi\n\n**bold**')

  const adf = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }] }
  const fromAdf = jiraBodyToMarkdown(adf)
  assert.equal(fromAdf.raw, JSON.stringify(adf), 'adf raw preserved as JSON')
  assert.equal(fromAdf.markdown, 'x')

  // Unconvertible body: an unknown node type still yields usable text + raw.
  const weird = { type: 'doc', content: [{ type: 'expand', content: [{ type: 'text', text: 'kept' }] }] }
  const fromWeird = jiraBodyToMarkdown(weird)
  assert.equal(fromWeird.markdown, 'kept')
  assert.equal(fromWeird.raw, JSON.stringify(weird))
}

function main(): void {
  testWikiBlockAndInline()
  testWikiLinks()
  testWikiLists()
  testWikiCodeBlocksAreProtected()
  testWikiTable()
  testSnakeCaseNotItalicised()
  testAdfMarksAndBlocks()
  testBodyDispatchAndRawPreservation()
  console.log('tracker-jira-markup tests passed')
}

main()
