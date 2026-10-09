import assert from 'node:assert/strict'

import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { test } from 'vitest'

import { SafeMarkdown, safeWebUrl, type SafeMarkdownLinks } from './SafeMarkdown'

// SafeMarkdown draws text a model wrote. Every case here is a way that text
// could try to become markup, script or a navigation, and each must come out
// inert: no element the source asked for, no attribute it smuggled in, and no
// href that is not an absolute http(s) address.

const render = (text: string, links?: SafeMarkdownLinks): string =>
  renderToStaticMarkup(<SafeMarkdown text={text} links={links} />)

// Every href the output carries.
const hrefs = (html: string): string[] => [...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1]!)

// The real tags in the output (escaped source text — `&lt;b&gt;` — is not one).
const tags = (html: string): string[] => [...html.matchAll(/<[a-z][^>]*>/gi)].map((match) => match[0])

test('it renders Markdown the way the chat does', () => {
  const html = render('# Plan\n\nShip **this**, then `that`.\n\n- one\n- two')
  assert.match(html, /class="markdown-rendered"/)
  assert.match(html, /data-density="chat"/)
  assert.match(html, /<strong[^>]*>this<\/strong>/)
  assert.match(html, /<code[^>]*>that<\/code>/)
  assert.match(html, /<li[^>]*>one<\/li>/)
})

test('a script tag never becomes a script', () => {
  const html = render('Before\n\n<script>exfiltrate(1)</script>\n\nAfter <script>exfiltrate(2)</script> inline')
  assert.doesNotMatch(html, /<script/i)
  assert.match(html, /Before/)
  assert.match(html, /After/)
})

test('raw HTML is shown as the text it is, never parsed into elements or attributes', () => {
  const html = render(
    '<img src="x" onerror="exfiltrate(1)">\n\n<div onclick="steal()">hi</div>\n\n<iframe src="https://example.com"></iframe>\n\nText <b onmouseover="x()">bold</b> <a href="javascript:exfiltrate(3)">x</a>',
  )
  for (const tag of tags(html)) {
    assert.doesNotMatch(tag, /^<(img|iframe|b|a|script|style|object|embed)\b/i, `raw element survived: ${tag}`)
    assert.doesNotMatch(tag, /\son\w+=/i, `an event attribute survived: ${tag}`)
    assert.doesNotMatch(tag, /\b(src|href)=/i, `a fetched or navigable attribute survived: ${tag}`)
  }
  // Escaped, so the reader sees what the agent wrote rather than losing it.
  assert.match(html, /&lt;img src=&quot;x&quot;/)
})

test('a javascript: link is its label and nothing else, in every link mode', () => {
  for (const links of ['open', 'copy', 'none'] as const) {
    const html = render(
      '[click](javascript:exfiltrate(1)) and <javascript:exfiltrate(2)> and [data](data:text/html,<b>x</b>) and [mail](mailto:dev@example.com) and [file](file:///etc/passwd)',
      links,
    )
    for (const tag of tags(html)) {
      assert.doesNotMatch(tag, /javascript:|data:|mailto:|file:/i, `${links}: an unsafe URL reached a tag: ${tag}`)
    }
    assert.deepEqual(hrefs(html), [], `${links}: an unsafe link kept an href`)
    assert.doesNotMatch(html, /<button/, `${links}: an unsafe link became a control`)
    assert.match(html, /click/)
  }
})

test('a relative or schemeless link is inert too', () => {
  const html = render('[up](../secrets) and [root](/settings) and [frag](#top)')
  assert.deepEqual(hrefs(html), [])
})

test('links="open" keeps an http(s) link as an anchor that opens outside the window', () => {
  const html = render('See [the docs](https://example.com/docs?a=1).')
  assert.deepEqual(hrefs(html), ['https://example.com/docs?a=1'])
  assert.match(html, /target="_blank"/)
  assert.match(html, /rel="noreferrer noopener"/)
})

test('links="copy" turns a web link into a copy control, with no href', () => {
  const html = render('See [the docs](https://example.com/docs).', 'copy')
  assert.deepEqual(hrefs(html), [])
  assert.match(html, /<button[^>]*aria-label="Copy link: https:\/\/example.com\/docs"/)
})

test('links="none" leaves a web link as its label', () => {
  const html = render('See [the docs](https://example.com/docs).', 'none')
  assert.deepEqual(hrefs(html), [])
  assert.doesNotMatch(html, /<button/)
  assert.match(html, /the docs/)
})

test('an image is never fetched, only named', () => {
  const html = render('![a chart](https://example.com/chart.png) ![](javascript:exfiltrate(1))')
  assert.doesNotMatch(html, /<img/i)
  assert.doesNotMatch(html, /example\.com\/chart\.png/)
  assert.doesNotMatch(html, /javascript:/i)
  assert.match(html, /Image: a chart/)
})

test('safeWebUrl keeps only absolute http(s) addresses', () => {
  assert.equal(safeWebUrl('https://example.com'), 'https://example.com/')
  assert.equal(safeWebUrl('http://example.com/a'), 'http://example.com/a')
  for (const href of [
    'javascript:exfiltrate(1)',
    ' JavaScript:exfiltrate(1)',
    'data:text/html,x',
    'mailto:dev@example.com',
    '/a',
    '',
  ]) {
    assert.equal(safeWebUrl(href), null, href)
  }
})
