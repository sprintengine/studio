import { test } from 'vitest'
import assert from 'node:assert/strict'
import { apiKeyBillingNotice, normalizeApiKeySource } from './apiKeySource'

test('only the SDK labels survive normalization', () => {
  assert.equal(normalizeApiKeySource('none'), 'none')
  assert.equal(normalizeApiKeySource('/login managed key'), '/login managed key')
  assert.equal(normalizeApiKeySource('[redacted]'), null)
  assert.equal(normalizeApiKeySource('sk-ant-api03-example'), null)
  assert.equal(normalizeApiKeySource(undefined), null)
  assert.equal(normalizeApiKeySource(42), null)
})

test('a subscription session raises no billing notice', () => {
  // `none` is what a claude.ai login reports; the legacy labels, `oauth` among
  // them, are never emitted by current CLIs and do not mean API billing.
  for (const source of [null, undefined, 'none', 'oauth', 'user', 'project', 'org', 'temporary', '[redacted]']) {
    assert.equal(apiKeyBillingNotice(source), null, String(source))
  }
})

test('each billing source names where its key came from', () => {
  assert.match(apiKeyBillingNotice('ANTHROPIC_API_KEY') ?? '', /ANTHROPIC_API_KEY, set in your environment/)
  assert.match(apiKeyBillingNotice('apiKeyHelper') ?? '', /apiKeyHelper command/)
  assert.match(apiKeyBillingNotice('/login managed key') ?? '', /Console \/login/)
  assert.equal(apiKeyBillingNotice('toString'), null, 'prototype keys are not sources')
})
