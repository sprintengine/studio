import { JSDOM } from 'jsdom'
import { expect, test } from 'vitest'
import { appendQuoteToDraft, quoteAsMarkdown, readQuotableSelection, selectionAfterScroll } from './quoteSelection'

test('a selection becomes one blockquote, paragraph breaks kept once', () => {
  expect(quoteAsMarkdown('First line\r\nSecond line')).toBe('> First line\n> Second line')
  expect(quoteAsMarkdown('\n\nOne\n\n\n\nTwo  \n\n')).toBe('> One\n>\n> Two')
  expect(quoteAsMarkdown('   \n ')).toBe('')
})

test('the quote joins the draft as its own block with the caret on a fresh line', () => {
  expect(appendQuoteToDraft('', 'Use the cache')).toBe('> Use the cache\n\n')
  expect(appendQuoteToDraft('Why this?  \n', 'Use the cache')).toBe('Why this?\n\n> Use the cache\n\n')
  expect(appendQuoteToDraft('Keep me', '  ')).toBe('Keep me')
})

test('only a selection inside a reply’s prose is quotable', () => {
  const dom = new JSDOM(
    '<div id="root"><div data-quote-source=""><p id="prose">The loader reads the file once.</p></div>' +
      '<p id="tool">Ran npm test</p></div><p id="outside">Elsewhere</p>',
  )
  const { document } = dom.window
  const root = document.getElementById('root')!
  // jsdom lays nothing out; the toolbar's anchor point only needs a rect.
  const rect = { left: 10, right: 120, top: 40, bottom: 56, width: 110, height: 16, x: 10, y: 40 }
  dom.window.Range.prototype.getClientRects = function () {
    return Object.assign([rect], { item: () => rect }) as unknown as DOMRectList
  }
  dom.window.Range.prototype.getBoundingClientRect = () => rect as DOMRect
  const select = (id: string, start: number, end: number) => {
    const text = document.getElementById(id)!.firstChild!
    const selection = dom.window.getSelection()!
    const range = document.createRange()
    range.setStart(text, start)
    range.setEnd(text, end)
    selection.removeAllRanges()
    selection.addRange(range)
    return selection
  }
  expect(readQuotableSelection(root, select('prose', 4, 10))).toEqual({
    text: 'loader',
    point: { x: 120, y: 62 },
  })
  expect(readQuotableSelection(root, select('tool', 0, 3))).toBeNull()
  expect(readQuotableSelection(root, select('outside', 0, 4))).toBeNull()
  expect(readQuotableSelection(root, select('prose', 3, 4))).toBeNull()
  expect(readQuotableSelection(root, select('prose', 2, 2))).toBeNull()
  dom.window.close()
})

test('a scroll the reader did not make carries the toolbar with the selection', () => {
  const at = (y: number, text = 'loader') => ({ text, point: { x: 120, y } })
  const shown = at(62)
  // A streamed token that did not move the selection keeps the same toolbar.
  expect(selectionAfterScroll(shown, at(62.2), 800)).toBe(shown)
  // The list following the reply moved the selection: the toolbar moves too.
  expect(selectionAfterScroll(shown, at(40), 800)).toEqual(at(40))
  // Scrolled out of the window, cleared, or replaced: it goes.
  expect(selectionAfterScroll(shown, at(2), 800)).toBeNull()
  expect(selectionAfterScroll(shown, at(900), 800)).toBeNull()
  expect(selectionAfterScroll(shown, null, 800)).toBeNull()
  expect(selectionAfterScroll(shown, at(62, 'reads'), 800)).toBeNull()
  expect(selectionAfterScroll(null, at(62), 800)).toBeNull()
})
