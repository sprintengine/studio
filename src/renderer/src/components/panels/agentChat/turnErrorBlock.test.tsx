import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import type { TranscriptEntry } from './conversationProjection'
import { isAuthShapedFailure, TurnErrorBlock, type TimelineChrome } from './timelineRows'

type AssistantEntry = Extract<TranscriptEntry, { kind: 'assistant' }>

// The failure Claude Code reports when its login lapsed and could not refresh.
const EXPIRED = 'Failed to authenticate: OAuth session expired and could not be refreshed'

const failedTurn = (failureDetail: string): AssistantEntry =>
  ({
    kind: 'assistant',
    id: 'a1',
    turnId: 'turn-1',
    text: '',
    reasoning: '',
    tools: [],
    status: 'failed',
    failureReason: 'provider',
    failureDetail,
  }) as unknown as AssistantEntry

const chrome = (extra: Partial<TimelineChrome> = {}): TimelineChrome => ({
  assistantName: 'Claude Code',
  retryTurnId: 'turn-1',
  onRetry: () => undefined,
  retryDisabled: false,
  ...extra,
})

const render = (entry: AssistantEntry, timelineChrome: TimelineChrome) =>
  renderToStaticMarkup(<TurnErrorBlock entry={entry} chrome={timelineChrome} />)

test('a lapsed login offers Sign in beside Retry when this machine can run it', () => {
  const html = render(failedTurn(EXPIRED), chrome({ onSignIn: async () => undefined, platform: 'darwin' }))
  expect(html).toContain('Sign in</button>')
  expect(html).toContain('Retry</button>')
  expect(html).toContain('Sign in, then retry.')
  expect(html).not.toContain('WSL')
})

test('on Windows the copy says it is the Windows sign-in, not the one inside WSL', () => {
  const html = render(failedTurn(EXPIRED), chrome({ onSignIn: async () => undefined, platform: 'win32' }))
  expect(html).toContain('Claude Code for Windows')
  expect(html).toContain('WSL')
})

test('where Studio cannot sign in, the copy names the command to run instead', () => {
  const html = render(failedTurn(EXPIRED), chrome())
  expect(html).not.toContain('Sign in</button>')
  expect(html).toContain('claude auth login')
})

test('a failure that is not about signing in offers no sign-in', () => {
  const html = render(failedTurn('network timeout'), chrome({ onSignIn: async () => undefined }))
  expect(html).not.toContain('Sign in')
  expect(html).toContain('Something went wrong while responding.')
})

test('the auth matcher reads real login failures and not words that merely contain "auth"', () => {
  expect(isAuthShapedFailure(EXPIRED)).toBe(true)
  expect(isAuthShapedFailure('HTTP 401 Unauthorized')).toBe(true)
  expect(isAuthShapedFailure('Invalid API key · Please run /login')).toBe(true)
  expect(isAuthShapedFailure('Could not read src/authors.ts')).toBe(false)
  expect(isAuthShapedFailure('Request 14010 timed out')).toBe(false)
})
