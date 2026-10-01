import { test } from 'vitest'
import assert from 'node:assert/strict'
import { redactConversationValue } from './conversation-tool-details'

test('redaction keeps a reported credential source but not a credential', () => {
  const redacted = redactConversationValue({
    type: 'session_updated',
    payload: { apiKeySource: 'none', apiKey: 'sk-ant-private', authToken: 'private' },
  })
  assert.deepEqual(redacted.payload, { apiKeySource: 'none', apiKey: '[redacted]', authToken: '[redacted]' })
  // A value outside the SDK's labels is not a label, so it is not kept.
  const odd = redactConversationValue({ apiKeySource: 'sk-ant-private' })
  assert.equal(odd.apiKeySource, '[redacted]')
})

test('redaction keeps token counts, including the compaction sizes, but not a token', () => {
  const redacted = redactConversationValue({
    type: 'context_compacted',
    payload: { trigger: 'auto', preTokens: 182_000, postTokens: 24_000, sessionToken: 'private' },
  })
  assert.deepEqual(redacted.payload, {
    trigger: 'auto',
    preTokens: 182_000,
    postTokens: 24_000,
    sessionToken: '[redacted]',
  })
  // A string under a counting name is still treated as a secret.
  assert.equal(redactConversationValue({ refreshTokens: 'private' }).refreshTokens, '[redacted]')
})
