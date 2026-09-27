import { test, expect } from 'vitest'
import { deriveTurnFold } from './turnFolds'
import type { TranscriptEntry, TranscriptToolEntry } from './conversationProjection'
const tools: TranscriptToolEntry[] = ['one', 'two'].map((id) => ({
  kind: 'tool',
  id,
  turnId: 'turn',
  name: 'Read',
  status: 'done',
}))
const entry: Extract<TranscriptEntry, { kind: 'assistant' }> = {
  kind: 'assistant',
  turnId: 'turn',
  text: 'Answer',
  reasoning: '',
  status: 'complete',
  startedAt: 1000,
  completedAt: 81000,
}
test('only settled turns with several work rows fold', () => {
  expect(deriveTurnFold({ ...entry, status: 'streaming' }, tools, false)).toBeNull()
  expect(deriveTurnFold(entry, tools.slice(0, 1), false)).toBeNull()
  expect(deriveTurnFold(entry, tools, false)).toMatchObject({
    label: 'Worked for 1m 20s · 2 steps',
    defaultFolded: true,
  })
  expect(deriveTurnFold(entry, tools, true)?.defaultFolded).toBe(false)
})
test('failed and interrupted folds keep their outcome, live lanes stay outside', () => {
  expect(deriveTurnFold({ ...entry, status: 'failed' }, tools, false)?.label).toContain('Failed after')
  expect(deriveTurnFold({ ...entry, status: 'interrupted' }, tools, false)?.label).toContain('You stopped after')
  expect(deriveTurnFold(entry, [{ ...tools[0], status: 'running', subagentLane: true }, tools[1]], false)).toBeNull()
})

test('intermediate prose contributes to folding while final prose remains separate', () => {
  const withProse = { ...entry, intermediateText: [{ text: 'I will inspect the file.', beforeToolUseId: 'one' }] }
  expect(deriveTurnFold(withProse, tools.slice(0, 1), false)?.defaultFolded).toBe(true)
  expect(withProse.text).toBe('Answer')
})

test('a turn without a known start reports no duration instead of time since the epoch', () => {
  expect(deriveTurnFold({ ...entry, startedAt: undefined }, tools, false)?.label).toBe('Worked · 2 steps')
  expect(deriveTurnFold({ ...entry, startedAt: undefined, durationMs: 4000 }, tools, false)?.label).toBe(
    'Worked for 4s · 2 steps',
  )
  expect(deriveTurnFold({ ...entry, status: 'failed', startedAt: undefined }, tools, false)?.label).toBe(
    'Failed · 2 steps',
  )
  const withReasoning = { ...entry, reasoning: 'Thinking' }
  expect(deriveTurnFold(withReasoning, tools.slice(0, 1), false)?.label).toBe('Worked for 1m 20s · 1 step')
})
