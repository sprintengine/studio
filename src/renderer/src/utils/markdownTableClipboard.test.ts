import type { Element } from 'hast'
import { expect, test } from 'vitest'
import { tableCsv, tableHtml, tableMarkdown, tableTsv } from './markdownTableClipboard'

// The tree remark hands the `table` component, built by hand: a header row
// carrying the column alignment, then body rows, one of them short a cell.
const el = (tagName: string, children: Element['children'], properties: Element['properties'] = {}): Element => ({
  type: 'element',
  tagName,
  properties,
  children,
})
const text = (value: string) => ({ type: 'text' as const, value })

const table = el('table', [
  el('thead', [
    el('tr', [
      el('th', [text('Name')], { align: 'left' }),
      el('th', [text('Kind')], { align: 'center' }),
      el('th', [text('Size')], { align: 'right' }),
      el('th', [text('Notes')]),
    ]),
  ]),
  el('tbody', [
    el('tr', [
      el('td', [el('code', [text('a|b.ts')])]),
      el('td', [el('strong', [text('file')])]),
      el('td', [el('a', [text('1 KB')], { href: 'https://example.com/a' })]),
      el('td', [text('says "hi", then\nleaves')]),
    ]),
    el('tr', [el('td', [text('c')]), el('td', [el('em', [text('dir')])])]),
  ]),
])

test('markdown keeps inline formatting, escapes pipes and rebuilds the alignment row', () => {
  expect(tableMarkdown(table)).toBe(
    [
      '| Name | Kind | Size | Notes |',
      '| :--- | :---: | ---: | --- |',
      '| `a\\|b.ts` | **file** | [1 KB](https://example.com/a) | says "hi", then leaves |',
      '| c | *dir* |  |  |',
    ].join('\n'),
  )
})

test('CSV quotes a field holding a quote, a comma or a line break, and pads short rows', () => {
  expect(tableCsv(table)).toBe(
    ['Name,Kind,Size,Notes', 'a|b.ts,file,1 KB,"says ""hi"", then leaves"', 'c,dir,,'].join('\n'),
  )
})

test('TSV splits on tabs only and keeps a cell with a tab in it as one cell', () => {
  const tabbed = el('table', [
    el('thead', [el('tr', [el('th', [text('Key')]), el('th', [text('Value')])])]),
    el('tbody', [el('tr', [el('td', [text('a\tb')]), el('td', [text('1, 2')])])]),
  ])
  expect(tableTsv(tabbed)).toBe(['Key\tValue', 'a b\t1, 2'].join('\n'))
})

test('a cell a spreadsheet would run as a formula goes out as text in CSV and TSV, and as written elsewhere', () => {
  const risky = el('table', [
    el('tr', [el('th', [text('Cell')]), el('th', [text('Delta')])]),
    el('tr', [el('td', [text('=HYPERLINK("https://example.com")')]), el('td', [text('-2')])]),
    el('tr', [el('td', [text('+cmd')]), el('td', [text('+42')])]),
    el('tr', [el('td', [text('@SUM(A1:A2)')]), el('td', [text('-1.5%')])]),
    el('tr', [el('td', [text('- a dash')]), el('td', [text('+6 -2')])]),
  ])
  expect(tableTsv(risky).split('\n')).toEqual([
    'Cell\tDelta',
    `'=HYPERLINK("https://example.com")\t-2`,
    "'+cmd\t+42",
    "'@SUM(A1:A2)\t-1.5%",
    "'- a dash\t'+6 -2",
  ])
  expect(tableCsv(risky).split('\n')[1]).toBe(`"'=HYPERLINK(""https://example.com"")",-2`)
  expect(tableMarkdown(risky)).toContain('| =HYPERLINK("https://example.com") | -2 |')
  expect(tableHtml(risky)).toContain('<td>=HYPERLINK(&quot;https://example.com&quot;)</td>')
})

test('HTML carries the structure, alignment and inline formatting, escaped, and drops unsafe links', () => {
  const html = tableHtml(
    el('table', [
      el('thead', [el('tr', [el('th', [text('A<b>')], { align: 'right' })])]),
      el('tbody', [
        el('tr', [
          el('td', [
            el('strong', [text('x')]),
            el('a', [text('bad')], { href: 'javascript:alert(1)' }),
            el('a', [text('ok')], { href: 'https://example.com/?a=1&b=2' }),
          ]),
        ]),
      ]),
    ]),
  )
  expect(html).toBe(
    '<table><thead><tr><th style="text-align:right">A&lt;b&gt;</th></tr></thead>' +
      '<tbody><tr><td style="text-align:right"><strong>x</strong>bad<a href="https://example.com/?a=1&amp;b=2">ok</a></td></tr></tbody></table>',
  )
})

test('a tree with no header row copies as nothing rather than as a broken table', () => {
  const empty = el('table', [])
  expect(tableMarkdown(empty)).toBe('')
  expect(tableCsv(empty)).toBe('')
  expect(tableHtml(empty)).toBe('')
})
