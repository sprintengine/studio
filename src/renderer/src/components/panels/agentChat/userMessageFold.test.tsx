import { JSDOM } from 'jsdom'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test } from 'vitest'
import { selectionClipboard } from '../../../utils/selectionToMarkdown'
import type { TranscriptEntry } from './conversationProjection'
import { UserTimelineRow } from './timelineRows'
import {
  USER_MESSAGE_FOLD_LINES,
  USER_MESSAGE_FOLD_MIN_HIDDEN_LINES,
  lineHeightOf,
  userMessageFoldHeight,
} from './userMessageFold'

type UserEntry = Extract<TranscriptEntry, { kind: 'user' }>

// The bubble's paragraphs sit at 14px × 1.6. jsdom lays nothing out, so the
// tests say how tall the message renders and what its style computes to, and
// fire the resize observer by hand.
const LINE = 22.4
let renderedLines = 1
let computedLineHeight = `${LINE}px`
const observers: (() => void)[] = []
let cleanup: (() => void) | null = null

afterEach(() => {
  cleanup?.()
  cleanup = null
})

async function mount(text: string, id: string) {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost', pretendToBeVisual: true })
  const globals = globalThis as Record<string, unknown>
  const keys = ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'getComputedStyle', 'ResizeObserver']
  const previous = Object.fromEntries(keys.map((key) => [key, globals[key]]))
  const getComputedStyle = () => ({ lineHeight: computedLineHeight, fontSize: '14px' }) as CSSStyleDeclaration
  class FakeResizeObserver {
    constructor(private readonly callback: () => void) {}
    observe() {
      observers.push(this.callback)
    }
    disconnect() {
      observers.splice(observers.indexOf(this.callback), 1)
    }
  }
  Object.assign(dom.window, { getComputedStyle, api: { platform: 'darwin' } })
  Object.assign(globals, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    getComputedStyle,
    ResizeObserver: FakeResizeObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  dom.window.HTMLElement.prototype.getBoundingClientRect = () =>
    ({ top: 0, left: 0, width: 400, height: renderedLines * LINE }) as DOMRect
  const host = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(host)
  let root: Root | null = null
  const entry: UserEntry = { kind: 'user', id, seq: 1, text }
  const render = async () => {
    root?.unmount()
    root = createRoot(host)
    await act(async () => root!.render(<UserTimelineRow entry={entry} />))
  }
  await render()
  cleanup = () => {
    act(() => root?.unmount())
    observers.length = 0
    Object.assign(globals, previous)
    dom.window.close()
  }
  const region = () => host.querySelector<HTMLElement>('[data-user-message-collapsed]')!
  const toggle = () => host.querySelector<HTMLButtonElement>('button[aria-expanded]')
  return {
    dom,
    host,
    region,
    toggle,
    remount: render,
    resize: async (lines: number) => {
      renderedLines = lines
      await act(async () => observers.forEach((notify) => notify()))
    },
  }
}

const lines = (count: number) => Array.from({ length: count }, (_, index) => `pasted line ${index + 1}`).join('\n')

test('the fold is eleven lines at the bubble’s line height, and only when it hides three or more', () => {
  expect(USER_MESSAGE_FOLD_LINES).toBe(11)
  expect(USER_MESSAGE_FOLD_MIN_HIDDEN_LINES).toBe(3)
  expect(userMessageFoldHeight(LINE * 20, LINE)).toBeCloseTo(LINE * 11)
  expect(userMessageFoldHeight(LINE * 14, LINE)).toBeCloseTo(LINE * 11)
  // Two lines past the fold would hide less than the control costs.
  expect(userMessageFoldHeight(LINE * 13, LINE)).toBeNull()
  expect(userMessageFoldHeight(LINE * 20, 0)).toBeNull()
  expect(userMessageFoldHeight(0, LINE)).toBeNull()
})

test('the line height is read from computed style, and `normal` falls back to the font size', () => {
  const { window } = new JSDOM('<p>hi</p>')
  const element = window.document.querySelector('p')!
  const globals = globalThis as Record<string, unknown>
  const previous = globals.getComputedStyle
  try {
    globals.getComputedStyle = () => ({ lineHeight: '25.6px', fontSize: '16px' })
    expect(lineHeightOf(element)).toBe(25.6)
    globals.getComputedStyle = () => ({ lineHeight: 'normal', fontSize: '15px' })
    expect(lineHeightOf(element)).toBeCloseTo(18)
  } finally {
    globals.getComputedStyle = previous
  }
})

test('a message taller than eleven of its lines rests folded under a fade, with a way to read all of it', async () => {
  renderedLines = 20
  const view = await mount(lines(20), 'fold-long')
  expect(view.region().dataset.userMessageCollapsed).toBe('true')
  expect(view.region().style.maxHeight).toBe(`${LINE * 11}px`)
  expect(view.region().className).toContain('mask-image')
  const toggle = view.toggle()!
  expect(toggle.textContent).toBe('Show full message')
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  expect(toggle.getAttribute('aria-controls')).toBe(view.region().id)
  expect(toggle.hasAttribute('data-copy-exclude')).toBe(true)
})

test('a message that only just overruns the fold shows whole, with no control', async () => {
  renderedLines = 13
  const view = await mount(lines(13), 'fold-near')
  expect(view.region().dataset.userMessageCollapsed).toBe('false')
  expect(view.region().style.maxHeight).toBe('')
  expect(view.toggle()).toBeNull()
})

test('the fold follows the rendered height: a message that rewraps taller folds, one that widens unfolds', async () => {
  renderedLines = 4
  const view = await mount('one long paragraph that wraps as the pane narrows', 'fold-rewrap')
  expect(view.toggle()).toBeNull()
  await view.resize(18)
  expect(view.region().dataset.userMessageCollapsed).toBe('true')
  await view.resize(5)
  expect(view.region().dataset.userMessageCollapsed).toBe('false')
  expect(view.toggle()).toBeNull()
})

test('Show full message opens the fold and Show less closes it, and the choice outlives the row', async () => {
  renderedLines = 20
  const view = await mount(lines(20), 'fold-toggle')
  await act(async () => view.toggle()!.click())
  expect(view.region().dataset.userMessageCollapsed).toBe('false')
  expect(view.region().style.maxHeight).toBe('')
  expect(view.toggle()!.textContent).toBe('Show less')
  expect(view.toggle()!.getAttribute('aria-expanded')).toBe('true')
  expect(view.toggle()!.querySelector('svg')!.getAttribute('class')).toContain('rotate-90')
  // A row the list recycled and mounted again keeps the message open.
  await view.remount()
  expect(view.toggle()!.getAttribute('aria-expanded')).toBe('true')
  await act(async () => view.toggle()!.click())
  expect(view.region().dataset.userMessageCollapsed).toBe('true')
  expect(view.toggle()!.textContent).toBe('Show full message')
})

test('a folded message still copies whole, without its control', async () => {
  renderedLines = 20
  const view = await mount(lines(20), 'fold-copy')
  expect(view.region().dataset.userMessageCollapsed).toBe('true')
  const selection = view.dom.window.getSelection()!
  const range = view.dom.window.document.createRange()
  range.selectNodeContents(view.host)
  selection.removeAllRanges()
  selection.addRange(range)
  const copied = selectionClipboard(selection, view.host)?.text ?? ''
  expect(copied).toContain('pasted line 1\n')
  expect(copied).toContain('pasted line 20')
  expect(copied).not.toContain('Show full message')
})
