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
