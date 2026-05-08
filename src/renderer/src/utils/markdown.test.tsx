import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import type { GitLineChange } from './gitDiff'
import { renderMarkdown } from './markdown'

function render(markdown: string, lineChanges: GitLineChange[] = []): string {
  return renderToStaticMarkup(renderMarkdown(markdown, { lineChanges }))
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

testOrderedListsRenderAsSingleOrderedList()
testGfmTaskListsKeepCheckboxState()
testUnsafeAndRelativeLinksAreInert()
testImagesRenderAsPlaceholders()
testPreviewChangeMarkersAttachToChangedBlocks()
