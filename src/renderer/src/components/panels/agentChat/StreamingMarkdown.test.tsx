import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { test } from 'vitest'
import { renderMarkdown } from '../../../utils/markdown'
import { StreamingMarkdown } from './StreamingMarkdown'

test('segmented markdown has the same markup as a complete parse', () => {
  const fence = '```ts\nconst value = 1\n```\n\n'
  const fixtures = [
    fence,
    `Intro\n\n${fence}After`,
    `# Heading\n\n${fence}Paragraph`,
    `**Bold** and *italic*\n\n${fence}More`,
    `- first\n- second\n\n${fence}Next`,
    `> quote\n\n${fence}after`,
    `A [link](https://example.com).\n\n${fence}after`,
    `A | B\n--- | ---\n1 | 2\n\n${fence}after`,
    `${fence}## Another heading`,
    `${fence}- item one\n- item two`,
    `${fence}A paragraph with \`inline code\`.`,
    `${fence}~~~sh\necho hi\n~~~\n\nafter`,
    `~~~js\nconst a = 1\n~~~\n\n${fence}tail`,
    `${fence}${fence}tail`,
    `Before\n\n${fence}${fence}After\n\nFinal`,
    `Before\n\n${fence}> after`,
  ]
  for (const source of fixtures) {
    const whole = renderToStaticMarkup(<>{renderMarkdown(source)}</>).replace(/\s+/gu, ' ')
    const segmented = renderToStaticMarkup(<StreamingMarkdown source={source} />).replace(/\s+/gu, ' ')
    assert.equal(segmented, whole, source)
  }
})

test('paragraph-level segments render the same markup as a whole parse at every point of a stream', () => {
  const fixtures = [
    'First paragraph with **bold** and `code`.\n\nSecond paragraph.\n\n## Heading\n\nThird, after the heading.',
    'Intro.\n\n- tight one\n- tight two\n\nAfter the list.\n\n- loose one\n\n- loose two\n\nAfter the loose list.',
    'Intro.\n\n1. first\n2. second\n\n10. ten\n11. eleven\n\nClosing words.',
    '- item\n\n  continued in the item\n\n  ```sh\n  npm test\n  ```\n\nOut of the list.',
    'Text.\n\n> quoted\n> still quoted\n\n> another quote\n\n> [!NOTE]\n> An alert.\n\nAfter quotes.',
    'Table:\n\n| a | b |\n| :- | -: |\n| 1 | 2 |\n\nAfter the table.\n\n---\n\nAfter the rule.',
    'Code:\n\n    indented code\n\n    more indented code\n\nProse again.\n\n```\nfenced\n\nwith a blank\n```\n\nDone.',
    'A <b>bold</b> tag.\n\n<div>\nblock html\n</div>\n\nAfter the block.\n\n-5 degrees, 12.5% more, 2024 was a year.\n\n**Bold start** of a paragraph.',
    'Heading underline\n===\n\nParagraph\n\n* * *\n\nLast.',
  ]
  for (const source of fixtures) {
    for (let length = 1; length <= source.length; length += length < source.length - 12 ? 5 : 1) {
      const prefix = source.slice(0, length)
      const whole = renderToStaticMarkup(<>{renderMarkdown(prefix)}</>).replace(/\s+/gu, ' ')
      const segmented = renderToStaticMarkup(<StreamingMarkdown source={prefix} />).replace(/\s+/gu, ' ')
      assert.equal(segmented, whole, JSON.stringify(prefix))
    }
  }
})
