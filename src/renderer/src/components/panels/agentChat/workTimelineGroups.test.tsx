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
