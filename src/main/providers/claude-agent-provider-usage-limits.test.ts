import { afterEach, expect, test } from 'vitest'

import type { UsageLimitHit } from '../../shared/usage-limits'
import { onUsageLimitHit, usageLimitsStore, usageRateLimit } from '../usage-limits/store'
import { CLAUDE_AGENT_PROVIDER_ID, mapSdkMessage } from './claude-agent-provider'

// The subscription's limits as a Claude chat reports them: the SDK's
// `rate_limit_event`s carry the windows, the init's credential source says
// whether there is a subscription at all, and a turn that ends refused is a
// limit hit. The store is the app's one; each test starts from a clean
// provider by billing it to an API key, which forgets its windows.

// Epoch seconds, as the SDK sends them.
const RESET_S = Math.floor(Date.now() / 1000) + 3 * 60 * 60

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

const init = (apiKeySource: string) => ({
  type: 'system',
  subtype: 'init',
  session_id: 'native',
  apiKeySource,
  model: 'claude-sonnet-5',
  cwd: '/Users/dev/app',
  tools: [],
  mcp_servers: [],
  claude_code_version: '2.1.291',
})

// Shaped like the SDK's SDKRateLimitEvent.
const rateLimitEvent = (info: Record<string, unknown>) => ({
  type: 'rate_limit_event',
  rate_limit_info: info,
  uuid: '7c1e4b5a-2f0d-4c8e-9a61-1d2b3c4d5e6f',
  session_id: 'native',
})

const failedResult = (result: string) => ({
  type: 'result',
  subtype: 'success',
  is_error: true,
  result,
  duration_ms: 900,
  num_turns: 1,
  total_cost_usd: 0,
  usage: { input_tokens: 0, output_tokens: 0 },
  session_id: 'native',
})

const claudeSnapshot = () =>
  usageLimitsStore()
    .state()
    .snapshots.find((snapshot) => snapshot.provider === 'claude')

let stopHits: (() => void) | null = null
afterEach(() => {
  stopHits?.()
  stopHits = null
  usageLimitsStore().noteBilling('claude', 'api')
})

function collectHits(): UsageLimitHit[] {
  const hits: UsageLimitHit[] = []
  stopHits = onUsageLimitHit((hit) => hits.push(hit))
  return hits
}

test('a subscription session reads its windows off rate_limit_events, and none of them reach the transcript', () => {
  const state = mapperState()
  mapSdkMessage(state, init('none'))
  const events = mapSdkMessage(
    state,
    rateLimitEvent({ status: 'allowed', resetsAt: RESET_S, rateLimitType: 'five_hour', utilization: 0.42 }),
  )
  expect(events).toEqual([])
  mapSdkMessage(
    state,
    rateLimitEvent({
      status: 'allowed_warning',
      resetsAt: RESET_S + 86_400,
      rateLimitType: 'seven_day',
      utilization: 0.91,
    }),
  )
  expect(claudeSnapshot()?.windows.map((window) => [window.id, window.usedPercent, window.status])).toEqual([
    ['five_hour', 42, 'allowed'],
    ['seven_day', 91, 'warning'],
  ])
  expect(claudeSnapshot()?.windows[0].resetsAt).toBe(RESET_S * 1000)
})

test('an API-key session shows no limits, whatever events it sees', () => {
  const state = mapperState()
  mapSdkMessage(state, init('ANTHROPIC_API_KEY'))
  mapSdkMessage(
    state,
    rateLimitEvent({ status: 'allowed', resetsAt: RESET_S, rateLimitType: 'five_hour', utilization: 0.42 }),
  )
  expect(claudeSnapshot()).toBeUndefined()
  // Nor is a failed turn on it a plan's limit.
  const hits = collectHits()
  mapSdkMessage(state, failedResult("You've hit your limit · resets 3pm"))
  expect(hits).toEqual([])
})

test('a turn that ends after a rejected event is a limit hit, with the window and when it resets', () => {
  const hits = collectHits()
  const state = mapperState()
  mapSdkMessage(state, init('none'))
  mapSdkMessage(
    state,
    rateLimitEvent({
      status: 'rejected',
      resetsAt: RESET_S,
      rateLimitType: 'five_hour',
      utilization: 1,
      overageStatus: 'rejected',
      overageDisabledReason: 'org_level_disabled',
    }),
  )
  const events = mapSdkMessage(state, failedResult("You've hit your limit · resets 3pm"))
  expect(events.at(-1)?.type).toBe('turn_failed')
  expect(hits).toEqual([
    {
      provider: 'claude',
      sessionId: 'conv_1',
      resetsAt: RESET_S * 1000,
      windowId: 'five_hour',
      at: expect.any(Number),
    },
  ])
  expect(usageRateLimit('claude')).toEqual({ limited: true, resetsAt: RESET_S * 1000, windowId: 'five_hour' })
  // The refusal belonged to that turn; the next failure is judged on its own.
  mapSdkMessage(state, failedResult('API Error: 500'))
  expect(hits).toHaveLength(1)
})

test('a turn the CLI ends with its usage-limit message or its rate_limit error is a hit without a window', () => {
  const hits = collectHits()
  const state = mapperState()
  mapSdkMessage(state, init('none'))
  mapSdkMessage(state, failedResult("You've reached your weekly limit"))
  mapSdkMessage(state, {
    type: 'assistant',
    error: 'rate_limit',
    parent_tool_use_id: null,
    uuid: '0b7d2f1e-5a4c-4d3b-8e2f-6a7b8c9d0e1f',
    session_id: 'native',
    message: { id: 'msg_1', role: 'assistant', content: [{ type: 'text', text: 'Rate limited' }], stop_reason: null },
  })
  mapSdkMessage(state, failedResult('Request failed'))
  expect(hits.map((hit) => [hit.provider, hit.windowId, hit.resetsAt])).toEqual([
    ['claude', null, null],
    ['claude', null, null],
  ])
})

test('an event that allows requests again clears the refusal, so a later failure is not taken for one', () => {
  const hits = collectHits()
  const state = mapperState()
  mapSdkMessage(state, init('none'))
  mapSdkMessage(state, rateLimitEvent({ status: 'rejected', resetsAt: RESET_S, rateLimitType: 'five_hour' }))
  mapSdkMessage(state, rateLimitEvent({ status: 'allowed', resetsAt: RESET_S + 18_000, rateLimitType: 'five_hour' }))
  mapSdkMessage(state, failedResult('API Error: 500'))
  expect(hits).toEqual([])
})
