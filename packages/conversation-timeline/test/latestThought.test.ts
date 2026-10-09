import { expect, test } from 'vitest'

import type { TranscriptEntry, TranscriptToolEntry } from '../src/conversationProjection.js'
import {
  deriveConversationTimelineRows,
  firstThoughtSentence,
  latestTurnThought,
  reasoningPreview,
} from '../src/conversationTimeline.js'

// The working line's second line: the agent's latest thought while its turn
// is folded.

const tool = (id: string, status: TranscriptToolEntry['status'] = 'done'): TranscriptToolEntry => ({
  kind: 'tool',
  id,
  turnId: 'turn',
  name: 'Read',
  status,
})

function assistant(
  overrides: Partial<Extract<TranscriptEntry, { kind: 'assistant' }>> = {},
): Extract<TranscriptEntry, { kind: 'assistant' }> {
  return {
    kind: 'assistant',
    turnId: 'turn',
    text: '',
    reasoning: '',
    status: 'streaming',
    startedAt: 1000,
    ...overrides,
  }
}

function workingRow(entries: TranscriptEntry[]) {
  const row = deriveConversationTimelineRows(entries, true).find((candidate) => candidate.kind === 'working')
  if (row?.kind !== 'working') throw new Error('no working row')
  return row
}

test('the preview is the first line worth showing, as plain words', () => {
  expect(reasoningPreview('\n\n## Checking the **fixture**\nmore detail')).toBe('Checking the fixture')
  expect(reasoningPreview('```\ncode first\n```')).toBe('code first')
})

test('a thought is the first sentence of that line, and a dot inside a word does not end it', () => {
  expect(firstThoughtSentence('Start with the grid. Then the padding.')).toBe('Start with the grid.')
  expect(firstThoughtSentence('Open `a.ts` and check v1.5 first! Then run it.')).toBe('Open a.ts and check v1.5 first!')
  expect(firstThoughtSentence('No full stop here')).toBe('No full stop here')
  expect(firstThoughtSentence('   ')).toBe('')
})

test('the thinking since the last step is the newest thought', () => {
  const entry = assistant({
    reasoning: 'Now compare the tiers.',
    reasoningSegments: [{ text: 'Read the CSS first.', beforeToolUseId: 'a' }],
  })
  expect(latestTurnThought(entry, [tool('a')])).toBe('Now compare the tiers.')
})

test('otherwise the last of the thinking and the prose between steps, prose after thinking at the same step', () => {
  const tools = [tool('a'), tool('b')]
  expect(
    latestTurnThought(
      assistant({
        reasoningSegments: [
          { text: 'Read the CSS first.', beforeToolUseId: 'a' },
          { text: 'The gap is fixed.', beforeToolUseId: 'b' },
        ],
        intermediateText: [{ text: 'Widening the gap now.', beforeToolUseId: 'b' }],
      }),
      tools,
    ),
  ).toBe('Widening the gap now.')
  expect(
    latestTurnThought(
      assistant({
        reasoningSegments: [{ text: 'The gap is fixed.', beforeToolUseId: 'b' }],
        intermediateText: [{ text: 'Reading the CSS.', beforeToolUseId: 'a' }],
      }),
      tools,
    ),
  ).toBe('The gap is fixed.')
})

test('prose that shows a picture is drawn outside the fold, so it is not the thought', () => {
  expect(
    latestTurnThought(
      assistant({
        reasoningSegments: [{ text: 'Render it.', beforeToolUseId: 'a' }],
        intermediateText: [{ text: 'Here it is: ![chart](chart.png)', beforeToolUseId: 'a' }],
      }),
      [tool('a')],
    ),
  ).toBe('Render it.')
})

test('the working row carries the thought and its turn while the agent works', () => {
  const row = workingRow([
    assistant({ reasoningSegments: [{ text: 'Check the cards. Then the header.', beforeToolUseId: 'a' }] }),
    tool('a', 'running'),
  ])
  expect(row.latestThought).toBe('Check the cards.')
  expect(row.turnId).toBe('turn')
})

test('while the agent replies, the reply is on screen and the row carries no thought', () => {
  const row = workingRow([
    assistant({ text: 'I widened the gap.', reasoningSegments: [{ text: 'Check the cards.', beforeToolUseId: 'a' }] }),
    tool('a'),
  ])
  expect(row.stage).toBe('responding')
  expect(row.latestThought).toBeUndefined()
})

test('a new thought replaces the row; the same one keeps it', () => {
  const entries: TranscriptEntry[] = [assistant({ reasoning: 'First idea.' })]
  const first = deriveConversationTimelineRows(entries, true)
  const same = deriveConversationTimelineRows([assistant({ reasoning: 'First idea.' })], true, first)
  expect(same.find((row) => row.kind === 'working')).toBe(first.find((row) => row.kind === 'working'))
  const next = deriveConversationTimelineRows([assistant({ reasoning: 'Second idea.' })], true, first)
  const row = next.find((candidate) => candidate.kind === 'working')
  expect(row?.kind === 'working' && row.latestThought).toBe('Second idea.')
})
