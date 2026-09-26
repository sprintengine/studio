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
