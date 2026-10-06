import { createInterface } from 'node:readline'
import { Readable } from 'node:stream'
import { expect, test } from 'vitest'

import { plainLineBreaks } from './lineBreaks'

test('line and paragraph separators become plain line breaks', () => {
  expect(plainLineBreaks('one\u2028two\u2029three\r\nfour\rfive\u0085six')).toBe('one\ntwo\nthree\nfour\nfive\nsix')
  expect(plainLineBreaks('one line\nand another')).toBe('one line\nand another')
})

test('a message with plain line breaks stays one JSON line to a line reader', async () => {
  const read = async (message: string) => {
    const lines: string[] = []
    const reader = createInterface({ input: Readable.from([`${JSON.stringify({ message })}\n`]) })
    for await (const line of reader) lines.push(line)
    return lines
  }
  const spoken = 'Test this one.\u2029And see how it comes through.'
  // As written, the separator ends the line in the middle of the frame.
  expect(await read(spoken)).toHaveLength(2)
  const lines = await read(plainLineBreaks(spoken))
  expect(lines).toHaveLength(1)
  expect(JSON.parse(lines[0])).toEqual({ message: 'Test this one.\nAnd see how it comes through.' })
})
