import { expect, test } from 'vitest'

import { CLAUDE_AGENT_PROVIDER_ID, mapSdkMessage } from './claude-agent-provider'

// What a Claude chat's `turn_completed` says about the turn: the agent's last
// message (the CLI's `result`), and what every exchange of the turn spent, by
// the turn-usage contract (fresh input apart from the prompt cache's reads and
// writes).

function mapperState() {
  return {
    sessionId: 'conv_1',
    workspaceId: 'workspace',
    agentId: 'agent',
    providerId: CLAUDE_AGENT_PROVIDER_ID,
    modelId: 'sonnet',
    providerSessionId: 'native' as string | null,
    turn: { turnId: 'turn_1' } as { turnId: string } | null,
    queryCostUsd: 0,
  }
}

const result = (overrides: Record<string, unknown>) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  session_id: 'native',
  ...overrides,
})

test('turn_completed carries the last message and the turn’s usage', () => {
  const events = mapSdkMessage(
    mapperState(),
    result({
      result: 'All four tests pass now.',
      total_cost_usd: 0.01,
      usage: {
        input_tokens: 12,
        output_tokens: 40,
        cache_read_input_tokens: 9000,
        cache_creation_input_tokens: 300,
      },
    }),
  )
  const completed = events.find((event) => event.type === 'turn_completed')
  expect(completed?.payload).toMatchObject({
    turnId: 'turn_1',
    text: 'All four tests pass now.',
    usage: { inputTokens: 12, outputTokens: 40, cacheReadTokens: 9000, cacheWriteTokens: 300 },
    costUsd: 0.01,
  })
})

test('a turn a steered message extended reports every exchange’s usage once, at its end', () => {
  const state = mapperState()
  const first = mapSdkMessage(
    state,
    result({ result: 'Working on it.', usage: { input_tokens: 10, output_tokens: 5 } }),
    {
      exchangeContinues: true,
    },
  )
  expect(first.some((event) => event.type === 'turn_completed')).toBe(false)
  const last = mapSdkMessage(
    state,
    result({ result: 'Done.', usage: { input_tokens: 3, output_tokens: 7, cache_read_input_tokens: 100 } }),
  )
  const completed = last.find((event) => event.type === 'turn_completed')
  expect(completed?.payload?.text).toBe('Done.')
  expect(completed?.payload?.usage).toEqual({ inputTokens: 13, outputTokens: 12, cacheReadTokens: 100 })

  // The next turn starts counting again.
  const next = mapSdkMessage(state, result({ usage: { input_tokens: 1, output_tokens: 1 } }))
  expect(next.find((event) => event.type === 'turn_completed')?.payload?.usage).toEqual({
    inputTokens: 1,
    outputTokens: 1,
  })
})

test('a turn with no reply text and no usage says neither', () => {
  const events = mapSdkMessage(mapperState(), result({ result: '   ' }))
  const payload = events.find((event) => event.type === 'turn_completed')?.payload ?? {}
  expect('text' in payload).toBe(false)
  expect('usage' in payload).toBe(false)
})

test('a stopped exchange’s usage is not carried into the next turn', () => {
  const state = mapperState()
  mapSdkMessage(state, result({ usage: { input_tokens: 50, output_tokens: 50 } }), { exchangeContinues: true })
  mapSdkMessage(state, result({ usage: { input_tokens: 1, output_tokens: 1 } }), { interrupted: true })
  const next = mapSdkMessage(state, result({ usage: { input_tokens: 2, output_tokens: 2 } }))
  expect(next.find((event) => event.type === 'turn_completed')?.payload?.usage).toEqual({
    inputTokens: 2,
    outputTokens: 2,
  })
})
