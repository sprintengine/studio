import assert from 'node:assert/strict'
import { test } from 'vitest'
import { createAnsiState, parseAnsi, type AnsiColor, type AnsiLine } from './ansi'

const fg = (index: number): AnsiColor => ({ kind: 'palette', index })
const rgb = (r: number, g: number, b: number): AnsiColor => ({ kind: 'rgb', r, g, b })

test('parses styling, controls, and terminal progress into spans', () => {
  const cases: Array<[string, AnsiLine[]]> = [
    ['', [[]]],
    ['plain', [[{ text: 'plain' }]]],
    ['a\nb', [[{ text: 'a' }], [{ text: 'b' }]]],
    ['a\r\nb', [[{ text: 'a' }], [{ text: 'b' }]]],
    ['a\n', [[{ text: 'a' }], []]],
    ['abc\rX', [[{ text: 'Xbc' }]]],
    ['abc\rXY', [[{ text: 'XYc' }]]],
    ['abc\bX', [[{ text: 'abX' }]]],
    ['\bX', [[{ text: 'X' }]]],
    ['\x1b[31mred', [[{ text: 'red', fg: fg(1) }]]],
    ['\x1b[32mgreen', [[{ text: 'green', fg: fg(2) }]]],
    ['\x1b[37mwhite', [[{ text: 'white', fg: fg(7) }]]],
    ['\x1b[90mgray', [[{ text: 'gray', fg: fg(8) }]]],
    ['\x1b[97mbright', [[{ text: 'bright', fg: fg(15) }]]],
    ['\x1b[41mred', [[{ text: 'red', bg: fg(1) }]]],
    ['\x1b[47mwhite', [[{ text: 'white', bg: fg(7) }]]],
    ['\x1b[100mgray', [[{ text: 'gray', bg: fg(8) }]]],
    ['\x1b[107mbright', [[{ text: 'bright', bg: fg(15) }]]],
    ['\x1b[38;5;196mred', [[{ text: 'red', fg: fg(196) }]]],
    ['\x1b[48;5;17mbg', [[{ text: 'bg', bg: fg(17) }]]],
    ['\x1b[38;2;12;34;56mrgb', [[{ text: 'rgb', fg: rgb(12, 34, 56) }]]],
    ['\x1b[48;2;2;4;6mbg', [[{ text: 'bg', bg: rgb(2, 4, 6) }]]],
    ['\x1b[1mbold', [[{ text: 'bold', bold: true }]]],
    ['\x1b[2mdim', [[{ text: 'dim', dim: true }]]],
    ['\x1b[3mitalic', [[{ text: 'italic', italic: true }]]],
    ['\x1b[4munder', [[{ text: 'under', underline: true }]]],
    ['\x1b[7minverse', [[{ text: 'inverse', inverse: true }]]],
    ['\x1b[9mstrike', [[{ text: 'strike', strike: true }]]],
    ['\x1b[1;31mhi', [[{ text: 'hi', bold: true, fg: fg(1) }]]],
    [
      '\x1b[1;2;3;4;7;9mx',
      [[{ text: 'x', bold: true, dim: true, italic: true, underline: true, inverse: true, strike: true }]],
    ],
    ['\x1b[31mred\x1b[0mplain', [[{ text: 'red', fg: fg(1) }, { text: 'plain' }]]],
    ['\x1b[1mb\x1b[22mn', [[{ text: 'b', bold: true }, { text: 'n' }]]],
    ['\x1b[3mi\x1b[23mn', [[{ text: 'i', italic: true }, { text: 'n' }]]],
    ['\x1b[4mu\x1b[24mn', [[{ text: 'u', underline: true }, { text: 'n' }]]],
    ['\x1b[7mi\x1b[27mn', [[{ text: 'i', inverse: true }, { text: 'n' }]]],
    ['\x1b[9ms\x1b[29mn', [[{ text: 's', strike: true }, { text: 'n' }]]],
    ['\x1b[31mr\x1b[39mn', [[{ text: 'r', fg: fg(1) }, { text: 'n' }]]],
    ['\x1b[41mr\x1b[49mn', [[{ text: 'r', bg: fg(1) }, { text: 'n' }]]],
    ['\x1b[31;44mx', [[{ text: 'x', fg: fg(1), bg: fg(4) }]]],
    ['\x1b[2Ktext', [[{ text: 'text' }]]],
    ['\x1b[?25ltext', [[{ text: 'text' }]]],
    ['\x1b]0;title\x07text', [[{ text: 'text' }]]],
    ['\x1b]0;title\x1b\\text', [[{ text: 'text' }]]],
    ['\x1b]8;;https://example.com\x07link\x1b]8;;\x07', [[{ text: 'link' }]]],
    ['10%\r20%\r100%', [[{ text: '100%' }]]],
    ['\x1b[31mred\nnext', [[{ text: 'red', fg: fg(1) }], [{ text: 'next', fg: fg(1) }]]],
  ]
  assert.ok(cases.length >= 40)
  for (const [input, expected] of cases) assert.deepEqual(parseAnsi(input), expected, JSON.stringify(input))
})

test('keeps escape sequences and cursor state across chunks', () => {
  const state = createAnsiState()
  assert.deepEqual(parseAnsi('abc\x1b[38;2;1;', state).lines, [[{ text: 'abc' }]])
  assert.deepEqual(parseAnsi('2;3mX', state).lines, [[{ text: 'abc' }, { text: 'X', fg: rgb(1, 2, 3) }]])
  assert.deepEqual(parseAnsi('\rY', state).lines, [
    [{ text: 'Y', fg: rgb(1, 2, 3) }, { text: 'bc' }, { text: 'X', fg: rgb(1, 2, 3) }],
  ])
  const osc = createAnsiState()
  parseAnsi('\x1b]8;;https://example.com\x1b', osc)
  assert.deepEqual(parseAnsi('\\visible', osc).lines, [[{ text: 'visible' }]])
  const capped = createAnsiState()
  parseAnsi('x'.repeat(2 * 1024 * 1024), capped)
  assert.equal(parseAnsi('tail', capped).lines[0].at(-1)?.text.endsWith('tail'), true)
})
