import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { expect, test } from 'vitest'

// The static New chat box (public/boot-composer.js) and its takeover by the
// real composer (bootComposer.ts, ComposerField's `adoptInput`). The box runs
// here as the window runs it: the shipped file, evaluated in a document shaped
// like index.html, before any module.

const BOOT_SCRIPT = readFileSync(new URL('../../../../public/boot-composer.js', import.meta.url), 'utf8')
const STORAGE_KEY = 'sprintengine-boot-composer'

type Look = { build?: string; theme?: string; windowId?: string; withApi?: boolean; stylesheet?: boolean }

// A window's document up to the point the box's script runs: the build meta,
// the look boot-theme.js stamps, the stylesheet's tokens, `#root`, and the
// preload's `window.api`.
function windowDocument(stored: string | null, look: Look = {}): JSDOM {
  const {
    build = 'abc123:2026-10-06T00:00:00.000Z',
    theme = 'system',
    windowId = 'primary',
    withApi = true,
    stylesheet = true,
  } = look
  const dom = new JSDOM(
    '<!doctype html><html data-theme="dark" data-mode="dark" data-chat-width="comfortable"><head>' +
      `<meta name="sprintengine-build" content="${build}">` +
      (stylesheet ? '<style>:root{--bg-app:canvas}</style>' : '') +
      '</head><body><div id="root"></div></body></html>',
    { url: `http://localhost/index.html?windowId=${windowId}`, pretendToBeVisual: true, runScripts: 'outside-only' },
  )
  if (stored !== null) dom.window.localStorage.setItem(STORAGE_KEY, stored)
  dom.window.localStorage.setItem(
    'sprintengine-app-settings',
    JSON.stringify({ state: { appSettings: { appearance: { theme } } }, version: 1 }),
  )
  if (withApi) (dom.window as unknown as { api: object }).api = {}
  dom.window.eval(BOOT_SCRIPT)
  return dom
}

const GLOBAL_KEYS = [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'MutationObserver',
  'requestAnimationFrame',
  'getComputedStyle',
  'IS_REACT_ACT_ENVIRONMENT',
] as const

async function inWindow<T>(dom: JSDOM, run: () => Promise<T>): Promise<T> {
  const previous = Object.getOwnPropertyDescriptors(globalThis) as Record<string, PropertyDescriptor | undefined>
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    MutationObserver: dom.window.MutationObserver,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  try {
    return await run()
  } finally {
    for (const key of GLOBAL_KEYS) {
      const descriptor = previous[key]
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete (globalThis as Record<string, unknown>)[key]
    }
  }
}

// What the New chat panel's region looks like to the capture: a door with the
// composer box inside, its editor holding words that must never be captured.
function drawDoor(dom: JSDOM): HTMLElement {
  const doc = dom.window.document
  const card = doc.createElement('div')
  card.style.overflow = 'hidden'
  card.style.borderRadius = '12px'
  card.innerHTML =
    '<div data-new-chat-door="" class="absolute inset-0">' +
    '<div data-new-chat-composer="true" class="rounded border">' +
    '<div data-composer-field="" class="composer-markdown min-h-[66px]">' +
    '<div class="cm-editor"><div class="cm-announced" aria-live="polite"></div><div class="cm-scroller">' +
    '<div class="cm-content" contenteditable="true" aria-label="What this agent should do" ' +
    'aria-placeholder="Describe the task…"><div class="cm-line">a private draft</div></div></div></div></div>' +
    '<button type="button" aria-label="Start agent" id="send-1">Start</button>' +
    '<button type="button" aria-label="Engine: Claude Code" aria-expanded="true">Claude Code</button>' +
    '<input type="file" class="hidden">' +
    '</div></div>'
  doc.getElementById('root')!.appendChild(card)
  const door = card.querySelector<HTMLElement>('[data-new-chat-door]')!
  Object.defineProperty(dom.window, 'innerWidth', { value: 1400, configurable: true })
  Object.defineProperty(dom.window, 'innerHeight', { value: 900, configurable: true })
  door.getBoundingClientRect = () => new dom.window.DOMRect(256, 36, 1140, 860)
  return door
}

async function captureFrom(look: Look = {}): Promise<string> {
  const dom = windowDocument(null, look)
  return inWindow(dom, async () => {
    const { captureBootComposerSnapshot } = await import('./bootComposer')
    expect(captureBootComposerSnapshot(drawDoor(dom), 42)).toBe(true)
    return dom.window.localStorage.getItem(STORAGE_KEY)!
  })
}

function boxOf(dom: JSDOM): { host: HTMLElement | null; input: HTMLTextAreaElement | null } {
  const host = dom.window.document.querySelector<HTMLElement>('[data-static-composer]')
  return { host, input: host?.querySelector<HTMLTextAreaElement>('textarea[data-static-composer-input]') ?? null }
}

// A keystroke as the field takes it: the key, then (unless the key was taken)
// the edit it makes at the caret.
function press(dom: JSDOM, input: HTMLTextAreaElement, key: string, init: KeyboardEventInit = {}): void {
  const event = new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  if (!input.dispatchEvent(event)) return
  const { selectionStart: start, selectionEnd: end, value } = input
  if (key === 'Backspace') {
    const from = start === end ? Math.max(0, start - 1) : start
    input.value = value.slice(0, from) + value.slice(end)
    input.setSelectionRange(from, from)
  } else if (key === 'ArrowLeft') {
    input.setSelectionRange(Math.max(0, start - 1), Math.max(0, start - 1))
    return
  } else {
    const text = key === 'Enter' ? '\n' : key
    input.value = value.slice(0, start) + text + value.slice(end)
    input.setSelectionRange(start + text.length, start + text.length)
  }
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
}

test('a capture holds the untouched panel and nothing typed into it', async () => {
  const stored = JSON.parse(await captureFrom())
  expect(stored).toMatchObject({
    version: 1,
    build: 'abc123:2026-10-06T00:00:00.000Z',
    windowId: 'primary',
    insets: { top: 36, left: 256, right: 4, bottom: 4 },
    radius: '12px',
    seed: 42,
  })
  expect(stored.html).not.toContain('a private draft')
  expect(stored.html).not.toContain('cm-editor')
  expect(stored.html).not.toContain('aria-live')
  expect(stored.html).not.toContain('id="send-1"')
  expect(stored.html).not.toContain('type="file"')
  expect(stored.html).not.toContain('aria-expanded="true"')
  expect(stored.html).toContain('data-static-composer-input')
})

test('the next launch draws the capture where the panel stood, focused and typeable', async () => {
  const dom = windowDocument(await captureFrom())
  const { host, input } = boxOf(dom)
  expect(host).not.toBeNull()
  expect(host!.previousElementSibling?.id).toBe('root')
  expect([host!.style.top, host!.style.left, host!.style.right, host!.style.bottom]).toEqual([
    '36px',
    '256px',
    '4px',
    '4px',
  ])
  expect(host!.style.borderRadius).toBe('12px')
  expect(input!.placeholder).toBe('Describe the task…')
  expect(input!.getAttribute('aria-label')).toBe('What this agent should do')
  expect(dom.window.document.activeElement).toBe(input)
  for (const control of host!.querySelectorAll('button')) expect(control.hasAttribute('inert')).toBe(true)
})

test('a capture from another build, look or window, or without the stylesheet, is not drawn', async () => {
  const stored = await captureFrom()
  expect(boxOf(windowDocument(stored, { build: 'def456:2026-10-07T00:00:00.000Z' })).host).toBeNull()
  expect(boxOf(windowDocument(stored, { theme: 'vellum' })).host).toBeNull()
  expect(boxOf(windowDocument(stored, { windowId: 'w-2' })).host).toBeNull()
  expect(boxOf(windowDocument(stored, { withApi: false })).host).toBeNull()
  expect(boxOf(windowDocument(stored, { stylesheet: false })).host).toBeNull()
  expect(boxOf(windowDocument('{not json')).host).toBeNull()
  expect(boxOf(windowDocument(stored)).host).not.toBeNull()
})

test('Enter in the box is held for the composer; Shift+Enter and a composing Enter are not', async () => {
  const dom = windowDocument(await captureFrom())
  const { input } = boxOf(dom)
  const bridge = (dom.window as unknown as { sprintengineBootComposer: { live: { enterPending: boolean } } })
    .sprintengineBootComposer
  for (const key of 'two lines') press(dom, input!, key)
  press(dom, input!, 'Enter', { shiftKey: true })
  press(dom, input!, 'Enter', { isComposing: true })
  expect(bridge.live.enterPending).toBe(false)
  expect(input!.value).toBe('two lines\n\n')
  press(dom, input!, 'Enter')
  expect(bridge.live.enterPending).toBe(true)
  expect(input!.value).toBe('two lines\n\n')
})

test('every keystroke typed into the box reaches the composer that takes it over, with the caret and focus', async () => {
  const dom = windowDocument(await captureFrom())
  const { host, input } = boxOf(dom)
  // Typing, a correction, a caret move back into the words, a newline and an
  // insertion at the caret: the edits a person makes in the first second.
  const keys = [...'fix the flakey', 'Backspace', 'Backspace', 'Backspace', ...'ky test', 'ArrowLeft', 'ArrowLeft']
  for (const key of keys) press(dom, input!, key)
  press(dom, input!, 'Enter', { shiftKey: true })
  for (const key of 'in ci') press(dom, input!, key)
  const typed = input!.value
  const caret = input!.selectionStart
  expect(typed).toBe('fix the flaky te\nin cist')

  await inWindow(dom, async () => {
    const { act, createElement, useState } = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { EditorView } = await import('@codemirror/view')
    const { ComposerField } = await import('../../panels/agentChat/ComposerField')
    const { claimBootComposer, bootComposerLive } = await import('./bootComposer')

    const changes: Array<{ value: string; caret: number }> = []
    // The host keeps the draft in its state, as the panel does: the adopted
    // words come back to the field as its `value` on the next render.
    function Host() {
      const [draft, setDraft] = useState('')
      return createElement(ComposerField, {
        value: draft,
        onChange: (value: string, at: number) => {
          changes.push({ value, caret: at })
          setDraft(value)
        },
        adoptInput: claimBootComposer,
      })
    }
    const mount = dom.window.document.createElement('div')
    dom.window.document.body.appendChild(mount)
    const root = createRoot(mount)
    await act(async () => root.render(createElement(Host)))
    const view = EditorView.findFromDOM(mount.querySelector<HTMLElement>('.cm-editor')!)!
    expect(view.state.doc.toString()).toBe(typed)
    expect(view.state.selection.main.head).toBe(caret)
    expect(changes).toEqual([{ value: typed, caret }])
    expect(view.hasFocus || dom.window.document.activeElement === view.contentDOM).toBe(true)
    expect(host!.isConnected).toBe(false)
    expect(bootComposerLive()).toBe(false)
    // Taken once: a second field mounting later finds nothing to adopt.
    expect(claimBootComposer()).toBeNull()
    await act(async () => root.unmount())
  })
})

test('a box the window turned out not to need goes, and hands back what was typed', async () => {
  const dom = windowDocument(await captureFrom())
  const { host, input } = boxOf(dom)
  for (const key of 'keep me') press(dom, input!, key)
  await inWindow(dom, async () => {
    const { releaseBootComposer, bootComposerLive } = await import('./bootComposer')
    expect(releaseBootComposer()).toBe('keep me')
    expect(host!.isConnected).toBe(false)
    expect(bootComposerLive()).toBe(false)
    expect(releaseBootComposer()).toBe('')
  })
})

test('a window with a chat forgets its capture, and only its own', async () => {
  const stored = await captureFrom()
  const own = windowDocument(stored)
  await inWindow(own, async () => {
    const { dropBootComposerSnapshot } = await import('./bootComposer')
    dropBootComposerSnapshot()
  })
  expect(own.window.localStorage.getItem(STORAGE_KEY)).toBeNull()
  const other = windowDocument(stored, { windowId: 'w-2' })
  await inWindow(other, async () => {
    const { dropBootComposerSnapshot } = await import('./bootComposer')
    dropBootComposerSnapshot()
  })
  expect(other.window.localStorage.getItem(STORAGE_KEY)).toBe(stored)
})
