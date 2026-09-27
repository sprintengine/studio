import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { test, expect } from 'vitest'
import { ConversationLinkProvider, ConversationMarkdown, splitProseLinkToken } from './conversationLinks'

function render(text: string) {
  return renderToStaticMarkup(
    <ConversationLinkProvider workspaceId="workspace" workspaceRoot="/workspace/app" cwd="/workspace/app">
      <ConversationMarkdown text={text} />
    </ConversationLinkProvider>,
  )
}

test('links paths in prose, inline code, and markdown hrefs', () => {
  const html = render(
    'See src/main/app.ts:42 and `./package.json`, `C:\\src\\main.ts:5`, `/Users/dev/app.ts`, `../lib/a.ts` or [source](src/app.ts#L8).',
  )
  expect((html.match(/aria-label="Open /g) ?? []).length).toBe(6)
  expect(html).toContain('app.ts:42')
})

test('does not mistake prose, app routes or versions for files', () => {
  expect(render('`foo.bar()` `/settings` `1.2.3`')).not.toContain('aria-label="Open ')
})

test('fenced source stays plain selectable code and hostile schemes are inert', () => {
  const html = render('```unknown\nsrc/main.ts\n```\n\n[unsafe](javascript:alert) [website](https://example.com/path)')
  expect(html).not.toContain('aria-label="Open ')
  expect(html).not.toContain('href="javascript:')
  expect(html).toContain('href="https://example.com/path"')
})

test('file chips preserve surrounding prose punctuation and balanced URL parentheses', () => {
  expect(splitProseLinkToken('(src/app.ts:4),')).toEqual({ prefix: '(', body: 'src/app.ts:4', suffix: '),' })
  expect(splitProseLinkToken('https://example.com/page_(one).')).toEqual({
    prefix: '',
    body: 'https://example.com/page_(one)',
    suffix: '.',
  })
  const markup = render('See (src/app.ts:4), then continue.')
  expect(markup).toContain('aria-label="Open src/app.ts:4"')
  expect(markup).toContain('), then continue.')
})

test('markdown links keep their label', () => {
  const html = render('Read [the setup guide](https://example.com/setup) and [the entry point](src/app.ts:4).')
  expect(html).toContain('>the setup guide</a>')
  expect(html).not.toContain('>https://example.com/setup<')
  expect(html).toContain('the entry point')
  expect(html).toContain('aria-label="Open src/app.ts:4"')
  expect(render('[plain words](not a link)')).toContain('plain words')
})

test('a host and port in inline code is not a file reference', () => {
  expect(render('Serve on `localhost:3000`, `127.0.0.1:8080` or `example.com:443`.')).not.toContain('aria-label="Open ')
  expect(render('`server.ts:3000`')).toContain('aria-label="Open server.ts:3000"')
})

function nestedInteractiveElements(html: string): number {
  let depth = 0
  let nested = 0
  for (const [, closing] of html.matchAll(/<(\/?)(?:a|button)\b[^>]*>/g)) {
    if (closing) depth--
    else if (depth++ > 0) nested++
  }
  return nested
}

test('a link whose label is inline code or a path is one control, not a chip inside a link', () => {
  for (const text of [
    'See [`src/app.ts`](src/app.ts:4).',
    'See [`src/app.ts`](https://example.com/x).',
    'See [**bold** src/b.ts](src/b.ts).',
    'See [*see* `lib/a.ts:3`](https://example.com/y).',
  ]) {
    const html = render(text)
    expect(nestedInteractiveElements(html), html).toBe(0)
    expect((html.match(/<(?:a|button)\b/g) ?? []).length, html).toBe(1)
  }
  const html = render('See [`src/app.ts`](src/app.ts:4).')
  expect(html).toContain('aria-label="Open src/app.ts:4"')
  expect(html).toMatch(/<code[^>]*>src\/app\.ts<\/code>/)
})

test('a folder path in inline code is the code itself: no chip, no file glyph, not shortened', () => {
  const html = render('Working in `/Users/dev/project` on `main`.')
  expect(html).not.toContain('aria-label="Open ')
  expect(html).not.toContain('<svg')
  expect(html).toMatch(/<code[^>]*>\/Users\/dev\/project<\/code>/)
  // One inline-code treatment for a path and a branch name alike.
  const codeClass = (value: string) => new RegExp(`<code class="([^"]*)">${value}</code>`).exec(html)?.[1]
  expect(codeClass('\\/Users\\/dev\\/project')).toBe(codeClass('main'))
})

test('a file path is an inline link at the text’s own size, showing the whole path', () => {
  const html = render('Edit `src/renderer/src/app/main.ts:12` next.')
  expect(html).toContain('aria-label="Open src/renderer/src/app/main.ts:12"')
  expect(html).toContain('>src/renderer/src/app/main.ts:12</button>')
  expect(html).not.toContain('<svg')
})
