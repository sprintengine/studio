import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { TerminalPromptUndelivered } from '../../../shared/electron-api'
import { undeliveredPromptEntry, undeliveredPromptNotice } from './undeliveredPrompt'

const displayName = (cli: string): string => ({ 'kimi-code': 'Kimi Code', grok: 'Grok Build' })[cli] ?? cli

function event(overrides: Partial<TerminalPromptUndelivered> = {}): TerminalPromptUndelivered {
  return {
    sessionId: 'sid',
    workspaceId: 'ws-1',
    agentId: 'agent-1',
    agentName: 'Iris',
    cli: 'kimi-code',
    text: 'Refactor the parser\nand keep the tests green',
    reason: 'exited',
    ...overrides,
  }
}

test('the notice names the agent and says why nothing was typed, for every reason', () => {
  const exited = undeliveredPromptNotice(event(), displayName)
  assert.equal(exited.title, 'Iris did not get your first message')
  assert.match(exited.message, /^Kimi Code exited before it was ready for input/)
  assert.match(exited.message, /Copy message/)

  assert.match(undeliveredPromptNotice(event({ reason: 'not-ready' }), displayName).message, /message box in time/)
  assert.match(undeliveredPromptNotice(event({ reason: 'write-failed' }), displayName).message, /stopped taking input/)

  const unnamed = undeliveredPromptNotice(event({ agentName: undefined }), displayName)
  assert.equal(unnamed.title, 'Kimi Code did not get your first message')
})

test('the bell row keeps the message exactly as written, and names where it came from', () => {
  const at = new Date('2026-09-24T12:00:00Z')
  const entry = undeliveredPromptEntry(event(), undeliveredPromptNotice(event(), displayName), at, 'n-1')
  assert.deepEqual(entry, {
    id: 'n-1',
    timestamp: '2026-09-24T12:00:00.000Z',
    level: 'error',
    source: 'terminal',
    title: 'Iris did not get your first message',
    message: undeliveredPromptNotice(event(), displayName).message,
    returnedPrompt: 'Refactor the parser\nand keep the tests green',
    sessionId: 'sid',
    workspaceId: 'ws-1',
    agentId: 'agent-1',
  })
})
