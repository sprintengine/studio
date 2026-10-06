import assert from 'node:assert/strict'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { test } from 'vitest'
import { singleFencedCode } from './markdownFence'

type Node = { type: string; value?: string; lang?: string | null; meta?: string | null; children?: Node[] }
const parser = unified().use(remarkParse).use(remarkGfm)
const parse = (source: string) => parser.runSync(parser.parse(source)) as unknown as Node

const MESSAGES = [
  '```ts\nexport const a = 1\n\nexport function b() {\n  return a\n}\n```\n\n',
  '```ts title="src/cache.ts"\nconst key = `${root}\\0${path}`\n```\n',
  '~~~~python\nprint("a")\n~~~\n~~~~~\n',
  '````md\n```ts\ninner\n```\n````\n\n',
  '  ```js\n    indented\n  two\n three\nnone\n  ```\n',
  '   ~~~\n\tx\n   y\n~~~',
  '```\n\n\n```\n',
  '```\n```\n',
  '```js&#x20;python\nentity\n```',
  '```c\\+\\+\nescaped\n```\n',
  '```\nclosed early\n```\nThen prose right after.\n',
  '```\n``` not a closer\n``\nstill code\n',
  '``` ts `bad`\nnot a fence\n',
  '    ```\nindented code, not a fence\n',
  '```\nunicode: 缓存未命中 — ok\n```\n',
  ' ```\n\tfirst\n  second\n```\n',
]

function check(source: string): boolean {
  const fast = singleFencedCode(source)
  if (!fast) return false
  const real = parse(source)
  assert.equal(real.children?.length, 1, `one block: ${JSON.stringify(source)}`)
  const code = real.children![0]
  assert.equal(code.type, 'code', `a code block: ${JSON.stringify(source)}`)
  assert.equal(fast.value, code.value, `the value: ${JSON.stringify(source)}`)
  const placeholder = parse(fast.placeholder).children![0]
  assert.equal(placeholder.type, 'code')
  assert.equal(placeholder.lang, code.lang, `the language: ${JSON.stringify(source)}`)
  assert.equal(placeholder.meta, code.meta, `the meta: ${JSON.stringify(source)}`)
  return true
}

test('a fenced block read without the parser has the value, language and meta the parser reads, at every length', () => {
  let read = 0
  let prefixes = 0
  for (const message of MESSAGES) {
    for (let end = 1; end <= message.length; end++) {
      prefixes++
      if (check(message.slice(0, end))) read++
    }
  }
  // Most prefixes are one fence; the rest are declined, never misread.
  assert.ok(read > prefixes / 2, `${read} of ${prefixes} prefixes read without the parser`)
})

test('a streaming fence is read without the parser from its first complete line to its closer', () => {
  const message = MESSAGES[0]
  for (let end = message.indexOf('\n') + 1; end <= message.length; end++) {
    assert.ok(check(message.slice(0, end)), `read at ${end}: ${JSON.stringify(message.slice(0, end))}`)
  }
})

test('a segment that is more than one fence, or not a fence, is left to the parser', () => {
  assert.equal(singleFencedCode('```\na\n```\nprose'), null)
  assert.equal(singleFencedCode('prose\n```\na\n```'), null)
  assert.equal(singleFencedCode('```ts'), null, 'an opener still streaming')
  assert.equal(singleFencedCode('```\r\na\r\n```'), null)
  assert.equal(singleFencedCode('``` a`b\nc\n'), null)
})

test('random fence-shaped messages: never misread, at every length', () => {
  let state = 0x2545f491
  const random = (below: number) => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) % below
  }
  const OPENERS = ['```', '```ts', '~~~', '````', ' ```py x', '   ~~~~', '  ```', '``` a b']
  const LINES = [
    '',
    ' ',
    '  ',
    '\t',
    '   \t',
    'a',
    '  b',
    '\tc',
    ' d ',
    '```',
    '~~~',
    '````',
    ' ```',
    '   ```  ',
    '    ```',
    'e`f',
  ]
  let read = 0
  for (let message = 0; message < 300; message++) {
    const lines = [OPENERS[random(OPENERS.length)]]
    for (let count = random(7); count > 0; count--) lines.push(LINES[random(LINES.length)])
    const source = lines.join('\n') + ['', '\n', '\n\n', ' '][random(4)]
    for (let end = 1; end <= source.length; end++) if (check(source.slice(0, end))) read++
  }
  assert.ok(read > 1000, `${read} prefixes read without the parser`)
})
