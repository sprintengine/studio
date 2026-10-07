import { expect, test } from 'vitest'

import {
  claudeBillingOf,
  claudeStatusLineUpdates,
  codexBillingOf,
  codexRateLimitUpdates,
  isClaudeUsageLimitMessage,
  isCodexUsageLimitError,
  readClaudeRateLimitInfo,
} from './sources'

const HOUR = 60 * 60 * 1000
// Epoch seconds, as the CLIs send them.
const RESET_S = 1_791_370_800

test("a Claude rate_limit_event's info becomes its window: a fraction to a percent, seconds to ms", () => {
  // Shaped like the SDK's SDKRateLimitInfo on a subscription nearing its weekly cap.
  expect(
    readClaudeRateLimitInfo({
      status: 'allowed_warning',
      resetsAt: RESET_S,
      rateLimitType: 'seven_day',
      utilization: 0.82,
      surpassedThreshold: 0.75,
      isUsingOverage: false,
    }),
  ).toEqual({
    update: {
      id: 'seven_day',
      label: 'Weekly',
      usedPercent: 82,
      resetsAt: RESET_S * 1000,
      durationMs: 7 * 24 * HOUR,
      status: 'warning',
    },
    rejected: null,
    allowed: true,
  })
  expect(
    readClaudeRateLimitInfo({ status: 'allowed', rateLimitType: 'seven_day_opus', utilization: 0.1 })?.update,
  ).toMatchObject({ id: 'seven_day_opus', label: 'Weekly · Opus', usedPercent: 10, status: 'allowed' })
})

test('a rejected Claude event is a refusal with its window and reset, unless extra usage carries the turn', () => {
  const refused = readClaudeRateLimitInfo({
    status: 'rejected',
    resetsAt: RESET_S,
    rateLimitType: 'five_hour',
    utilization: 1,
    overageStatus: 'rejected',
    overageDisabledReason: 'out_of_credits',
  })
  expect(refused?.rejected).toEqual({ windowId: 'five_hour', resetsAt: RESET_S * 1000 })
  expect(refused?.update).toMatchObject({ id: 'five_hour', usedPercent: 100, status: 'rejected' })
  const carried = readClaudeRateLimitInfo({
    status: 'rejected',
    resetsAt: RESET_S,
    rateLimitType: 'five_hour',
    utilization: 1,
    overageStatus: 'allowed',
    isUsingOverage: true,
  })
  expect(carried?.rejected).toBe(null)
  expect(carried?.update?.status).toBe('warning')
})

test('a Claude event about a kind that is not a plan window moves no window, and junk is nothing', () => {
  expect(readClaudeRateLimitInfo({ status: 'allowed', rateLimitType: 'overage', utilization: 0.4 })).toEqual({
    update: null,
    rejected: null,
    allowed: true,
  })
  expect(readClaudeRateLimitInfo({ status: 'rejected' })?.rejected).toEqual({ windowId: null, resetsAt: null })
  expect(readClaudeRateLimitInfo({ status: 'maybe' })).toBe(null)
  expect(readClaudeRateLimitInfo(null)).toBe(null)
})

test("the status line's windows become updates that say how full, never whether refused", () => {
  expect(
    claudeStatusLineUpdates({
      five_hour: { usedPercentage: 23.5, resetsAt: RESET_S * 1000 },
      seven_day: { usedPercentage: 41 },
      spend_limit: { usedPercentage: 12 },
    }),
  ).toEqual([
    { id: 'five_hour', label: 'Session (5h)', usedPercent: 23.5, resetsAt: RESET_S * 1000, durationMs: 5 * HOUR },
    { id: 'seven_day', label: 'Weekly', usedPercent: 41, durationMs: 7 * 24 * HOUR },
  ])
})

test("Claude's billing comes from the init's credential source, and a legacy source says nothing", () => {
  expect(claudeBillingOf('none')).toBe('subscription')
  expect(claudeBillingOf('ANTHROPIC_API_KEY')).toBe('api')
  expect(claudeBillingOf('apiKeyHelper')).toBe('api')
  expect(claudeBillingOf('/login managed key')).toBe('api')
  expect(claudeBillingOf('oauth')).toBe(null)
  expect(claudeBillingOf(null)).toBe(null)
})

test('the message a Claude turn ends with on a usage limit is recognized, and other failures are not', () => {
  expect(isClaudeUsageLimitMessage("You've hit your limit · resets 3pm (Europe/London)")).toBe(true)
  expect(isClaudeUsageLimitMessage("You've reached your weekly limit")).toBe(true)
  expect(isClaudeUsageLimitMessage('API Error: 529 overloaded')).toBe(false)
})

test("Codex's account/rateLimits/read answer becomes one window per bucket and slot", () => {
  // Shaped like GetAccountRateLimitsResponse for a ChatGPT Plus sign-in.
  const response = {
    ordinaryUsageAllowed: true,
    rateLimits: {
      limitId: 'codex',
      limitName: null,
      normalModelSlug: null,
      primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: RESET_S },
      secondary: { usedPercent: 37, windowDurationMins: 10080, resetsAt: RESET_S + 86_400 },
      credits: null,
      individualLimit: null,
      spendControlReached: null,
      planType: 'plus',
      rateLimitReachedType: null,
    },
    rateLimitsByLimitId: {
      codex: {
        limitId: 'codex',
        limitName: null,
        normalModelSlug: null,
        primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: RESET_S },
        secondary: { usedPercent: 37, windowDurationMins: 10080, resetsAt: RESET_S + 86_400 },
        credits: null,
        individualLimit: null,
        spendControlReached: null,
        planType: 'plus',
        rateLimitReachedType: null,
      },
      codex_mini: {
        limitId: 'codex_mini',
        limitName: 'Mini',
        normalModelSlug: null,
        primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: RESET_S },
        secondary: null,
        credits: null,
        individualLimit: null,
        spendControlReached: null,
        planType: 'plus',
        rateLimitReachedType: 'rate_limit_reached',
      },
    },
    rateLimitResetCredits: null,
    accountId: null,
    rateLimitUpsell: null,
  }
  expect(codexRateLimitUpdates(response)).toEqual([
    {
      id: 'codex:primary',
      label: 'Session (5h)',
      usedPercent: 12,
      resetsAt: RESET_S * 1000,
      durationMs: 5 * HOUR,
      status: 'allowed',
    },
    {
      id: 'codex:secondary',
      label: 'Weekly',
      usedPercent: 37,
      resetsAt: (RESET_S + 86_400) * 1000,
      durationMs: 7 * 24 * HOUR,
      status: 'allowed',
    },
    {
      id: 'codex_mini:primary',
      label: 'Mini · Session (5h)',
      usedPercent: 100,
      resetsAt: RESET_S * 1000,
      durationMs: 5 * HOUR,
      status: 'rejected',
    },
  ])
})

test('a sparse account/rateLimits/updated snapshot updates the windows it carries and no others', () => {
  // AccountRateLimitsUpdatedNotification.rateLimits: the weekly window left null.
  expect(
    codexRateLimitUpdates({
      limitId: null,
      limitName: null,
      primary: { usedPercent: 15, windowDurationMins: 300, resetsAt: RESET_S },
      secondary: null,
      planType: null,
      rateLimitReachedType: null,
    }),
  ).toEqual([
    {
      id: 'codex:primary',
      label: 'Session (5h)',
      usedPercent: 15,
      resetsAt: RESET_S * 1000,
      durationMs: 5 * HOUR,
      status: 'allowed',
    },
  ])
  expect(codexRateLimitUpdates(null)).toEqual([])
})

test("Codex's billing comes from account/read: ChatGPT is a plan, an API key or Bedrock is not", () => {
  expect(
    codexBillingOf({
      account: { type: 'chatgpt', email: 'dev@example.com', planType: 'pro' },
      requiresOpenaiAuth: true,
    }),
  ).toEqual({ billing: 'subscription', plan: 'pro' })
  expect(codexBillingOf({ account: { type: 'chatgpt', email: null, planType: 'unknown' } })).toEqual({
    billing: 'subscription',
  })
  expect(codexBillingOf({ account: { type: 'apiKey' }, requiresOpenaiAuth: true })).toEqual({ billing: 'api' })
  expect(codexBillingOf({ account: { type: 'amazonBedrock', usesCodexManagedCredentials: false } })).toEqual({
    billing: 'api',
  })
  expect(codexBillingOf({ account: null, requiresOpenaiAuth: false })).toBe(null)
})

test('a Codex turn error is a usage limit only when Codex says usageLimitExceeded', () => {
  expect(
    isCodexUsageLimitError({
      message: "You've hit your usage limit.",
      codexErrorInfo: 'usageLimitExceeded',
      additionalDetails: null,
      misalignment: null,
    }),
  ).toBe(true)
  expect(isCodexUsageLimitError({ message: 'Slow down', codexErrorInfo: 'rateLimitExceeded' })).toBe(false)
  expect(isCodexUsageLimitError(null)).toBe(false)
})
