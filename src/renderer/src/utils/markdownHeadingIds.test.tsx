// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { renderMarkdown } from './markdown'
import { githubHeadingSlug } from './markdownHeadingIds'

let root: Root | null = null
let host: HTMLElement | null = null
let scrolled: Element[] = []

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  scrolled = []
  // jsdom lays nothing out, so a scroll is read off who was asked to come into view.
  Element.prototype.scrollIntoView = vi.fn(function (this: Element) {
    scrolled.push(this)
  })
})

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  root = null
  host = null
})

async function mount(node: React.ReactNode): Promise<HTMLElement> {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root?.render(node))
  return host
}

function click(element: Element): MouseEvent {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true })
  act(() => {
    element.dispatchEvent(event)
  })
  return event
}

function ids(markdown: string): string[] {
  return [...renderToStaticMarkup(renderMarkdown(markdown)).matchAll(/<h\d id="([^"]*)"/gu)].map((match) => match[1])
}

test('a heading slug is GitHub’s: lower case, punctuation dropped, spaces as dashes', () => {
  expect(githubHeadingSlug('Getting Started')).toBe('getting-started')
  expect(githubHeadingSlug('What’s new in v2.0?')).toBe('whats-new-in-v20')
  expect(githubHeadingSlug('snake_case & kebab-case')).toBe('snake_case--kebab-case')
  expect(githubHeadingSlug('Überblick 安装')).toBe('überblick-安装')
})

test('every heading gets its slug as an id, prefixed so it cannot take an app element’s id', () => {
  expect(ids('# Getting Started\n\n## Use `npm test`')).toEqual([
    'user-content-getting-started',
    'user-content-use-npm-test',
  ])
})

test('repeated headings are told apart the way GitHub does it', () => {
  expect(ids('## Setup\n\n## Setup\n\n## Setup 1\n\n## Setup')).toEqual([
    'user-content-setup',
    'user-content-setup-1',
    'user-content-setup-1-1',
    'user-content-setup-2',
  ])
})

test('a heading of punctuation alone gets no id', () => {
  expect(renderToStaticMarkup(renderMarkdown('## ???'))).toMatch(/<h2 class=/u)
})

test('a #heading link keeps its href and stays in the window', () => {
  const html = renderToStaticMarkup(renderMarkdown('[Setup](#setup)'))
  expect(html).toMatch(/<a href="#setup" class="[^"]*accent-primary/u)
  expect(html).not.toContain('target="_blank"')
})

test('clicking a #heading link scrolls its heading to the top, and leaves the location alone', async () => {
  const page = await mount(renderMarkdown('[Jump to setup](#setup)\n\n## Intro\n\n## Setup\n\nSteps'))
  const before = window.location.href
  const event = click(page.querySelector('a[href="#setup"]')!)
  expect(event.defaultPrevented).toBe(true)
  expect(scrolled).toEqual([page.querySelector('#user-content-setup')])
  expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: 'start', inline: 'nearest' })
  expect(window.location.href).toBe(before)
})

test('a link finds the heading in its own document when two documents share a heading', async () => {
  const doc = '## Setup\n\n[back to setup](#setup)'
  const page = await mount(
    <>
      {renderMarkdown(doc)}
      {renderMarkdown(doc)}
    </>,
  )
  const [, second] = page.querySelectorAll('.markdown-rendered')
  click(second.querySelector('a')!)
  expect(scrolled).toEqual([second.querySelector('h2')])
})

test('a fragment written in other case, or escaped, still finds its heading', async () => {
  const page = await mount(renderMarkdown('[a](#Setup) [b](#%C3%BCberblick)\n\n## Setup\n\n## Überblick'))
  const [upper, escaped] = page.querySelectorAll('a')
  click(upper)
  click(escaped)
  expect(scrolled.map((element) => element.id)).toEqual(['user-content-setup', 'user-content-überblick'])
})

test('a link to a heading that is not there does nothing, rather than navigating', async () => {
  const page = await mount(renderMarkdown('[gone](#nowhere)\n\n## Setup'))
  expect(click(page.querySelector('a')!).defaultPrevented).toBe(true)
  expect(scrolled).toEqual([])
})

test('a footnote reference scrolls to its note', async () => {
  const page = await mount(renderMarkdown('A claim.[^1]\n\n[^1]: The source.'))
  click(page.querySelector('a[href="#user-content-fn-1"]')!)
  expect(scrolled.map((element) => element.id)).toEqual(['user-content-fn-1'])
})

test('a chat reply follows a #heading link before its own link renderer sees it', async () => {
  const renderLink = vi.fn(() => <span>file link</span>)
  const page = await mount(renderMarkdown('## Setup\n\n[setup](#setup)', { density: 'chat', renderLink }))
  click(page.querySelector('a[href="#setup"]')!)
  expect(renderLink).not.toHaveBeenCalled()
  expect(scrolled).toEqual([page.querySelector('h2')])
})

test('a surface that turns in-page links off hands the fragment to its own renderer', () => {
  const renderLink = vi.fn((href: string) => <span data-href={href} />)
  const html = renderToStaticMarkup(renderMarkdown('[setup](#setup)', { renderLink, inPageLinks: false }))
  expect(html).toContain('data-href="#setup"')
  expect(html).not.toContain('<a ')
})
