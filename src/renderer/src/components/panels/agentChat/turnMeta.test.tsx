import { expect, test } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { TranscriptEntry } from './conversationProjection'
import {
  compactionLabel,
  CompactionDivider,
  formatTokenCount,
  formatTurnModel,
  TurnMeta,
  turnMetaParts,
} from './turnMeta'

type Assistant = Extract<TranscriptEntry, { kind: 'assistant' }>

const turn = (values: Partial<Assistant> = {}): Assistant => ({
  kind: 'assistant',
  turnId: 't1',
  text: 'Done.',
  reasoning: '',
  status: 'complete',
  ...values,
})

test('token counts read in thousands and millions', () => {
  expect(formatTokenCount(950)).toBe('950')
  expect(formatTokenCount(12_345)).toBe('12.3k')
  expect(formatTokenCount(182_000)).toBe('182k')
  expect(formatTokenCount(999_700)).toBe('1M')
  expect(formatTokenCount(1_240_000)).toBe('1.2M')
})

test('a model id drops its snapshot date, and the harness default is not shown as a name', () => {
  expect(formatTurnModel('claude-sonnet-4-5-20250929')).toBe('claude-sonnet-4-5')
  expect(formatTurnModel('gpt-5-codex')).toBe('gpt-5-codex')
  expect(formatTurnModel('default')).toBe('Default model')
})

test('cost shows only for a turn billed through an API key', () => {
  const reported = { costUsd: 0.4213, inputTokens: 52_000, outputTokens: 1_900, modelId: 'claude-opus-4-5' }
  expect(turnMetaParts(turn({ ...reported, apiKeySource: 'none' }))).toEqual({
    model: 'claude-opus-4-5',
    tokens: '52k in · 1.9k out',
  })
  expect(turnMetaParts(turn(reported)).cost).toBeUndefined()
  expect(turnMetaParts(turn({ ...reported, apiKeySource: 'ANTHROPIC_API_KEY' })).cost).toBe('$0.42')
  expect(turnMetaParts(turn({ costUsd: 0.004, apiKeySource: 'apiKeyHelper' })).cost).toBe('<$0.01')
  expect(turnMetaParts(turn())).toEqual({})
})

test('the model waits for hover unless the reply switched to it', () => {
  const entry = turn({ modelId: 'claude-opus-4-5' })
  expect(renderToStaticMarkup(<TurnMeta entry={entry} />)).not.toContain('data-turn-model')
  expect(renderToStaticMarkup(<TurnMeta entry={entry} />)).toContain('opacity-0')
  const switched = renderToStaticMarkup(<TurnMeta entry={entry} modelSwitched />)
  expect(switched).toContain('data-turn-model')
  expect(switched).toContain('claude-opus-4-5')
})

test('a compaction divider says what triggered it and how much context it freed', () => {
  const base = { kind: 'compaction' as const, id: 'c1', createdAt: 0 }
  expect(compactionLabel(base)).toBe('Context compacted')
  expect(compactionLabel({ ...base, trigger: 'manual', preTokens: 90_000 })).toBe(
    'Context compacted · on request · from 90k tokens',
  )
  const auto = { ...base, trigger: 'auto' as const, preTokens: 182_000, postTokens: 24_000 }
  expect(compactionLabel(auto)).toBe('Context compacted · automatically · 182k → 24k tokens')
  const html = renderToStaticMarkup(<CompactionDivider entry={auto} />)
  expect(html).toContain('role="separator"')
  expect(html).toContain('aria-label="Context compacted · automatically · 182k → 24k tokens"')
})

test('the token line says how much of the input the prompt cache served', () => {
  expect(
    turnMetaParts(turn({ inputTokens: 11_300_000, cachedInputTokens: 10_900_000, outputTokens: 47_300 })).tokens,
  ).toBe('11.3M in · 10.9M cached · 47.3k out')
  // Nothing cached, or a provider that does not say, reads as before.
  expect(turnMetaParts(turn({ inputTokens: 52_000, cachedInputTokens: 0, outputTokens: 1_900 })).tokens).toBe(
    '52k in · 1.9k out',
  )
})
