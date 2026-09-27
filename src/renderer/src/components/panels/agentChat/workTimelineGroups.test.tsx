import { expect, test } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { partitionWorkTimeline, WorkTimeline } from './timelineRows'
import type { TranscriptToolEntry } from './conversationProjection'

const tool = (id: string, name = 'Read'): TranscriptToolEntry => ({
  kind: 'tool',
  id,
  turnId: 'turn',
  name,
  status: 'done',
  input: { path: id },
  summary: id,
})

test('prose splits consecutive tool groups and stays outside their disclosures', () => {
  const tools = [tool('a'), tool('b'), tool('c'), tool('d', 'Bash'), tool('e', 'Bash')]
  expect(partitionWorkTimeline(tools)).toEqual([{ text: [], tools }])
  const intermediateText = [{ beforeToolUseId: 'd', text: 'Now checking the tests.' }]
  expect(partitionWorkTimeline(tools, intermediateText)).toEqual([
    { text: [], tools: tools.slice(0, 3) },
    { text: ['Now checking the tests.'], tools: tools.slice(3) },
  ])
  const html = renderToStaticMarkup(<WorkTimeline tools={tools} live={false} intermediateText={intermediateText} />)
  expect(html).toContain('Read 3 files')
  expect(html).toContain('Ran 2 commands')
  expect(html.indexOf('Now checking the tests.')).toBeGreaterThan(html.indexOf('Read 3 files'))
  expect(html.indexOf('Now checking the tests.')).toBeLessThan(html.indexOf('Ran 2 commands'))
  const singles = renderToStaticMarkup(
    <WorkTimeline tools={[tools[0], tools[3]]} live={false} intermediateText={intermediateText} />,
  )
  expect(singles).not.toContain(' steps')
  expect(singles).toContain('Now checking the tests.')
})

test('a settled group rests folded, names its failures, and does not count flat steps', () => {
  const failed: TranscriptToolEntry = { ...tool('c', 'Bash'), toolKind: 'command', outputStatus: 'error' }
  const html = renderToStaticMarkup(<WorkTimeline tools={[tool('a'), tool('b'), failed]} live={false} />)
  expect(html).toContain('aria-expanded="false"')
  expect(html).not.toContain('data-tool-kind')
  expect(html).toContain('1 failed')
  expect(html).toContain('aria-label="Read 2 files and ran 1 command, 1 failed"')
  expect(html).not.toContain(' steps')
})

test('the step running now stays outside the fold', () => {
  const live: TranscriptToolEntry = { ...tool('c', 'Bash'), status: 'running', input: { command: 'npm test' } }
  const html = renderToStaticMarkup(<WorkTimeline tools={[tool('a'), tool('b'), live]} live />)
  expect(html).toContain('Read 2 files')
  expect(html.match(/data-tool-kind=/g)).toHaveLength(1)
  expect(html).toContain('>running<')
})
