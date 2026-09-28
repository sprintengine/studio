import { JSDOM } from 'jsdom'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import { renderMarkdown } from '../../../utils/markdown'
import { useToastStore } from '../../../store/toastStore'
import { COMMAND_REGISTRY, getCommandDefinition } from '../../../commands/commandRegistry'
import { findKeybindingConflicts, hasBlockingKeybindingConflict } from '../../../commands/conflicts'
import { UserTimelineRow } from './timelineRows'
import {
  QUOTE_MAX_CHARS,
  QUOTE_SELECTION_COMMAND,
  insertQuoteIntoDraft,
  placeQuoteToolbar,
  quoteAsMarkdown,
  quoteForSelection,
  quoteSelectionInto,
  readQuotableSelection,
  selectionAfterScroll,
} from './quoteSelection'

// A transcript in a real DOM: the quote reads live ranges, so the tests select
// text the way a person's drag does. jsdom lays nothing out, so every range
// answers with one fixed rect.
const RECT = { left: 10, right: 120, top: 40, bottom: 56, width: 110, height: 16, x: 10, y: 40 }
function transcript(html: string) {
  const dom = new JSDOM(`<!doctype html><body><div id="log">${html}</div><p id="outside">Elsewhere</p></body>`)
  const { document } = dom.window
  dom.window.Range.prototype.getClientRects = function () {
    return Object.assign([RECT], { item: () => RECT }) as unknown as DOMRectList
  }
  dom.window.Range.prototype.getBoundingClientRect = () => RECT as DOMRect
  const log = document.getElementById('log')!
  const selection = dom.window.getSelection()!
  const select = (range: Range) => {
    selection.removeAllRanges()
    selection.addRange(range)
    return selection
  }
  const textAt = (needle: string): [Text, number] => {
    const walker = document.createTreeWalker(document.body, dom.window.NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const index = node.textContent?.indexOf(needle) ?? -1
      if (index >= 0) return [node as Text, index]
    }
    throw new Error(`no text “${needle}”`)
  }
  return {
    log,
    selection,
    selectAll: () => {
      const range = document.createRange()
      range.selectNodeContents(log)
      return select(range)
    },
    selectBetween: (from: string, to: string) => {
      const [startNode, startOffset] = textAt(from)
      const [endNode, endOffset] = textAt(to)
      const range = document.createRange()
      range.setStart(startNode, startOffset)
      range.setEnd(endNode, endOffset + to.length)
      return select(range)
    },
  }
}

const rendered = (markdown: string, userText = false) =>
  renderToStaticMarkup(createElement('div', null, renderMarkdown(markdown, { userText })))

test('prose becomes one blockquote with paragraph breaks kept once', () => {
  expect(quoteAsMarkdown('First line\r\nSecond line')).toBe('> First line\n> Second line')
  expect(quoteAsMarkdown('\n\nOne\n\n\n\nTwo  \n\n')).toBe('> One\n>\n> Two')
  expect(quoteAsMarkdown('   \n ')).toBe('')
})

test('a fenced block inside the quote keeps every line of its code and still renders as code', () => {
  const quoted = quoteAsMarkdown('Run this:\n\n```ts\nconst a = 1\n\n\n  return a  \n```\nThen check.')
  expect(quoted).toBe('> Run this:\n>\n> ```ts\n> const a = 1\n>\n>\n>   return a  \n> ```\n> Then check.')
  // The app's own renderer reads it back as a quote holding a ts code block.
  const html = rendered(`${quoted}\n\nWhy?`)
  const { document } = new JSDOM(html).window
  const code = document.querySelector('blockquote pre')
  expect(code?.textContent).toContain('const a = 1\n\n\n  return a')
  expect(document.querySelector('blockquote')?.textContent).toContain('Then check.')
  expect(document.querySelector('blockquote')?.textContent).not.toContain('Why?')
})

test('a fence the selection cut open is closed so the reply is not swallowed into it', () => {
  expect(quoteAsMarkdown('~~~~sh\nnpm test\n')).toBe('> ~~~~sh\n> npm test\n> ~~~~')
})

test('the selected markdown survives the quote: bold, inline code, lists, code fences and tables', () => {
  const view = transcript(
    rendered(
      'Use **bold** and `npm test`:\n\n- one\n- two\n\n```ts\nconst a = 1\n\nreturn a\n```\n\n| Name | Size |\n|---|---:|\n| a.ts | 4 |',
    ),
  )
  const quote = quoteForSelection(view.log, view.selectAll())
  expect(quote).toEqual({
    kind: 'quote',
    markdown: [
      '> Use **bold** and `npm test`:',
      '>',
      '> - one',
      '> - two',
      '>',
      '> ```ts',
      '> const a = 1',
      '>',
      '> return a',
      '> ```',
      '>',
      '> | Name | Size |',
      '> | --- | ---: |',
      '> | a.ts | 4 |',
    ].join('\n'),
  })
})

test('a message of your own is quotable, without its timestamp, copy action or screen-reader heading', () => {
  const view = transcript(
    `<div data-conversation-row-kind="user">${renderToStaticMarkup(
      <UserTimelineRow
        entry={{ kind: 'user', id: 'u1', seq: 1, createdAt: Date.parse('2026-09-28T10:15:00Z'), text: 'Ship **it**' }}
      />,
    )}</div>`,
  )
  expect(quoteForSelection(view.log, view.selectAll())).toEqual({ kind: 'quote', markdown: '> Ship **it**' })
})

test('a selection across several rows quotes all of them, skipping the rows that are chrome', () => {
  const view = transcript(
    `<div data-conversation-row-kind="user">${rendered('First question', true)}</div>` +
      `<div data-conversation-row-kind="compaction" data-copy-exclude="">Context compacted</div>` +
      `<div data-conversation-row-kind="assistant">${rendered('The answer.')}</div>`,
  )
  expect(quoteForSelection(view.log, view.selectBetween('First', 'answer.'))).toEqual({
    kind: 'quote',
    markdown: '> First question\n>\n> The answer.',
  })
})

test('only a selection inside the transcript, and not only its chrome, is quotable', () => {
  const view = transcript(
    `<p id="prose">The loader reads the file once.</p><div data-copy-exclude=""><span>12:04 · Copy</span></div>`,
  )
  expect(readQuotableSelection(view.log, view.selectBetween('loader', 'loader'))).toEqual({
    text: 'loader',
    anchor: { left: 10, right: 120, top: 40, bottom: 56 },
  })
  expect(readQuotableSelection(view.log, view.selectBetween('12:04', 'Copy'))).toBeNull()
  expect(readQuotableSelection(view.log, view.selectBetween('Elsewhere', 'Elsewhere'))).toBeNull()
  expect(readQuotableSelection(view.log, view.selectBetween('file once.', 'Elsewhere'))).toBeNull()
  expect(readQuotableSelection(view.log, null)).toBeNull()
})

test('an empty composer takes the quote and a blank line, with the caret under it', () => {
  expect(insertQuoteIntoDraft('', '> Use the cache', 0)).toEqual({ text: '> Use the cache\n\n', caret: 17 })
})

test('a caret at the end of the draft puts the quote below it as its own block', () => {
  const draft = 'Why this?  \n'
  expect(insertQuoteIntoDraft(draft, '> Use the cache', draft.length)).toEqual({
    text: 'Why this?\n\n> Use the cache\n\n',
    caret: 28,
  })
})

test('a caret mid-text splits the draft around the quote and waits on a fresh line after it', () => {
  const draft = 'Before this, after that'
  const inserted = insertQuoteIntoDraft(draft, '> Use the cache', 'Before this,'.length)
  expect(inserted.text).toBe('Before this,\n\n> Use the cache\n\n\n\nafter that')
  expect(inserted.text.slice(0, inserted.caret)).toBe('Before this,\n\n> Use the cache\n\n')
})

test('a caret at the start puts the quote first and the draft after it', () => {
  expect(insertQuoteIntoDraft('Why?', '> Use the cache', 0)).toEqual({
    text: '> Use the cache\n\n\n\nWhy?',
    caret: 17,
  })
})

test('a selection past the cap is refused with a toast, never quietly cut short', () => {
  useToastStore.setState({ toasts: [] })
  const view = transcript(`<p>${'word '.repeat(QUOTE_MAX_CHARS / 4)}</p>`)
  const quoted: string[] = []
  expect(quoteSelectionInto(view.log, view.selectAll(), (markdown) => quoted.push(markdown))).toBe(true)
  expect(quoted).toEqual([])
  const toast = useToastStore.getState().toasts.at(-1)
  expect(toast?.title).toBe('Selection too long to quote')
  expect(toast?.description).toContain('8,000')
  // The selection stays, so a shorter one can be made from it.
  expect(view.selection.isCollapsed).toBe(false)
})

test('a quote goes to the composer and the selection is let go', () => {
  const view = transcript('<p>Keep the cache warm.</p>')
  const quoted: string[] = []
  expect(quoteSelectionInto(view.log, view.selectBetween('Keep', 'warm.'), (markdown) => quoted.push(markdown))).toBe(
    true,
  )
  expect(quoted).toEqual(['> Keep the cache warm.'])
  expect(view.selection.rangeCount).toBe(0)
  expect(quoteSelectionInto(view.log, view.selectBetween('Elsewhere', 'Elsewhere'), () => undefined)).toBe(false)
})

test('the toolbar sits under the selection when there is room, over it when there is not', () => {
  const size = { width: 80, height: 26 }
  const viewport = { width: 900, height: 700 }
  expect(placeQuoteToolbar({ left: 100, right: 400, top: 200, bottom: 260 }, size, viewport)).toEqual({
    left: 320,
    top: 266,
    side: 'below',
  })
  // Near the bottom of the window: above the first line, starting where it starts.
  expect(placeQuoteToolbar({ left: 100, right: 400, top: 600, bottom: 690 }, size, viewport)).toEqual({
    left: 100,
    top: 568,
    side: 'above',
  })
  // Kept inside the window's margins sideways.
  expect(placeQuoteToolbar({ left: 2, right: 30, top: 200, bottom: 220 }, size, viewport).left).toBe(8)
})

test('a scroll the reader did not make carries the toolbar with the selection', () => {
  const at = (top: number, text = 'loader') => ({ text, anchor: { left: 10, right: 120, top, bottom: top + 16 } })
  const shown = at(40)
  // A streamed token that did not move the selection keeps the same toolbar.
  expect(selectionAfterScroll(shown, at(40.2), 800)).toBe(shown)
  // The list following the reply moved the selection: the toolbar moves too.
  expect(selectionAfterScroll(shown, at(20), 800)).toEqual(at(20))
  // Scrolled wholly out of the window, cleared, or replaced: it goes.
  expect(selectionAfterScroll(shown, at(-30), 800)).toBeNull()
  expect(selectionAfterScroll(shown, at(900), 800)).toBeNull()
  expect(selectionAfterScroll(shown, null, 800)).toBeNull()
  expect(selectionAfterScroll(shown, at(40, 'reads'), 800)).toBeNull()
  expect(selectionAfterScroll(null, at(40), 800)).toBeNull()
})

test('the quote shortcut is a registered chat command whose chord blocks nothing', () => {
  const command = getCommandDefinition(QUOTE_SELECTION_COMMAND)
  expect(command?.defaultKeybindings).toEqual(['primary+shift+.'])
  expect(command?.handlerPath).toEqual({ kind: 'panel-event', eventId: QUOTE_SELECTION_COMMAND })
  expect(hasBlockingKeybindingConflict(findKeybindingConflicts(command!, COMMAND_REGISTRY))).toBe(false)
})

test('the quote shortcut reaches the chat view whose transcript holds the selection', async () => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost' })
  const globals = globalThis as Record<string, unknown>
  const previous = { window: globals.window, CustomEvent: globals.CustomEvent }
  Object.assign(globals, { window: dom.window, CustomEvent: dom.window.CustomEvent })
  try {
    const { registerMountedChatView } = await import('../AgentChatView')
    const { dispatchPanelCommandEvent } = await import('../../../utils/panelCommands')
    const asked: string[] = []
    const view = (name: string, holdsSelection: boolean) =>
      registerMountedChatView({
        workspaceId: 'ws',
        isFocused: () => name === 'focused',
        toggleModelPicker: () => undefined,
        quoteSelection: () => {
          asked.push(name)
          return holdsSelection
        },
      })
    const offs = [view('focused', false), view('holder', true), view('later', true)]
    dispatchPanelCommandEvent(QUOTE_SELECTION_COMMAND)
    expect(asked).toEqual(['focused', 'holder'])
    for (const off of offs) off()
  } finally {
    Object.assign(globals, previous)
  }
})
