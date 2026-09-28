import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import type { TranscriptToolEntry } from './conversationProjection'
import { LaneMark, laneAgentState, laneOutcomeWords } from './subagentStatus'

const lane = (fields: Partial<TranscriptToolEntry> = {}): TranscriptToolEntry => ({
  kind: 'tool',
  id: 'toolu_lane',
  turnId: 'turn-1',
  name: 'Agent',
  status: 'done',
  subagentLane: true,
  startedAt: 1_000,
  completedAt: 90_000,
  ...fields,
})

test('a settled agent says how it ended and how long it took', () => {
  expect(laneOutcomeWords(lane())).toBe('Done in 1m 29s')
  expect(laneOutcomeWords(lane({ outputStatus: 'error' }))).toBe('Failed after 1m 29s')
  expect(laneOutcomeWords(lane({ agent: { state: 'stopped' } }))).toBe('Stopped after 1m 29s')
  expect(laneOutcomeWords(lane({ outputStatus: 'declined' }))).toBe('Declined')
  expect(laneOutcomeWords(lane({ status: 'running' }))).toBeUndefined()
})

test('an agent whose end was never recorded says only that it ran in the background', () => {
  const legacy = lane({ agent: { state: 'unknown', background: true } })
  expect(laneAgentState(legacy)).toBe('unknown')
  expect(laneOutcomeWords(legacy)).toBe('Ran in the background')
})

test('an agent with no span of its own falls back to the time it reported', () => {
  const reported = lane({
    completedAt: undefined,
    agent: { state: 'completed', usage: { totalTokens: 1, toolUses: 1, durationMs: 7_000 } },
  })
  expect(laneOutcomeWords(reported)).toBe('Done in 7s')
})

test('an agent is a character, or with characters off the working mark and then its kind glyph', () => {
  expect(renderToStaticMarkup(<LaneMark tool={lane({ status: 'running' })} characters />)).toContain(
    'agent-glyph--working',
  )
  expect(renderToStaticMarkup(<LaneMark tool={lane({ status: 'running' })} characters={false} />)).toContain(
    'working-mark',
  )
  const settled = renderToStaticMarkup(<LaneMark tool={lane({ outputStatus: 'error' })} characters={false} />)
  expect(settled).not.toContain('agent-glyph')
  expect(settled).toContain('--tone-error')
})
