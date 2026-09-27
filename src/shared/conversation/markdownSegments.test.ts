import assert from 'node:assert/strict'
import { test } from 'vitest'
import { splitMarkdownSegments } from './markdownSegments'

test('freezes only independent closed fences followed by a complete blank line', () => {
  const block = 'before\n\n```ts\nconst x = 1\n```\n\n'
  const cases: Array<[string, number]> = [
    ['', 0],
    ['hello', 0],
    ['```\nx\n```', 0],
    ['```\nx\n```\n', 0],
    ['```\nx\n```\n\n', 1],
    [block, 1],
    [block + 'after', 1],
    [block + 'after\n', 1],
    [block + '```py\nx\n```\n\n', 2],
    ['~~~\na\n~~~\n\n', 1],
    ['~~~~~\na\n~~~~~\n\n', 1],
    ['````\na\n```\n\n', 0],
    ['~~~~\na\n~~~\n\n', 0],
    ['```\na\n~~~\n\n', 0],
    ['~~~\na\n```\n\n', 0],
    ['```js\na\n```\n\n', 1],
    ['```bad`info\na\n```\n\n', 0],
    ['  ```\na\n  ```\n\n', 0],
    ['> ```\n> a\n> ```\n\n', 0],
    ['- ```\n  a\n  ```\n\n', 0],
    ['```\na\n```\nnot blank\n', 0],
    ['```\na\n```\n \n', 1],
    ['```\na\n```\n\t\n', 1],
    ['```\na\n```\n\n```\nb\n```\n\n', 2],
    ['```\na\n```\n\n```\nb\n```\n', 1],
    ['```\na\n```\n\nmore\n\n', 1],
    ['```\na\n```\n\n[id]: /a', 0],
    ['```\na\n```\n\n[^note]: text', 0],
    ['```\na\n```\n\n\r', 0],
    ['\uFEFF```\na\n```\n\n', 0],
    ['<div>\n```\na\n```\n\n', 0],
    ['<!-- open\n```\na\n```\n\n', 0],
    ['<div>\n</div>\n```\na\n```\n\n', 1],
    ['<!-- closed -->\n```\na\n```\n\n', 1],
    // An indented fence still opens a code block: the unindented ``` after it
    // closes it, and the next ``` opens a block that is still unclosed.
    ['  ```\n```\nx\n```\n\n', 0],
    [' ~~~\n~~~\n\n', 0],
    // HTML inside inline code or a code block is text, not an open element.
    ['Use `<div>` here\n```\na\n```\n\n', 1],
    ['Use ``<div>`` here\n```\na\n```\n\n', 1],
    ['```html\n<div>\n```\n\n```\nb\n```\n\n', 2],
  ]
  assert.ok(cases.length >= 30)
  for (const [source, count] of cases) {
    const parts = splitMarkdownSegments(source)
    assert.equal(parts.frozen.length, count, source)
    assert.equal(parts.frozen.join('') + parts.tail, source, source)
  }
})

test('frozen segments retain their identity as ordinary text grows', () => {
  const source = 'before\n\n```ts\nx\n```\n\nafter\n\n~~~\ny\n~~~\n\ntail'
  let previous: string[] = []
  for (let i = 0; i <= source.length; i++) {
    const current = splitMarkdownSegments(source.slice(0, i)).frozen
    assert.deepEqual(current.slice(0, previous.length), previous)
    previous = current
  }
})
