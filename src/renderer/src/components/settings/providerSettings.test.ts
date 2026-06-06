import assert from 'node:assert/strict'

import type {
  ConversationProviderListResult,
  ConversationSecretStatus,
  ConversationSecretStatusResult,
} from '../../../../shared/electron-api'
import type { ConversationProviderListEntry } from '../../../../shared/plugin-manifest'
import {
  canClearProviderSecret,
  deriveProviderSecretView,
  deriveProviderTabState,
  orderProviders,
} from './providerSettings'

function provider(overrides: Partial<ConversationProviderListEntry> = {}): ConversationProviderListEntry {
  return {
    id: 'openrouter',
    displayName: 'OpenRouter',
    source: 'bundled',
    version: 1,
    providerType: 'model-provider',
    models: [{ id: 'openai/gpt-4o-mini', displayName: 'GPT-4o mini' }],
    supportsDynamicModels: true,
    adapter: { kind: 'declarative', execution: 'declarative', trust: 'not_required' },
    ...overrides,
  }
}

function status(overrides: Partial<ConversationSecretStatus> = {}): ConversationSecretStatus {
  return {
    providerId: 'openrouter',
    configured: true,
    source: 'settings',
    persistence: 'encrypted',
    encryptionAvailable: true,
    label: 'OpenRouter API key',
    ...overrides,
  }
}

// --- tab state -------------------------------------------------------------

assert.deepEqual(
  deriveProviderTabState(null, false),
  {
    kind: 'unavailable',
    message: 'Conversation providers need an app restart before this tab is available.',
  },
  'missing IPC reports unavailable'
)

assert.equal(deriveProviderTabState(null, true).kind, 'loading', 'null result while IPC present is loading')

assert.deepEqual(
  deriveProviderTabState({ ok: false, message: 'boom' }, true),
  { kind: 'error', message: 'boom' },
  'failed list result surfaces the error message'
)

assert.equal(
  deriveProviderTabState({ ok: true, providers: [] }, true).kind,
  'empty',
  'zero providers is the empty state'
)

const readyState = deriveProviderTabState(
  { ok: true, providers: [provider()] } satisfies ConversationProviderListResult,
  true
)
assert.equal(readyState.kind, 'ready', 'one provider yields the ready state')

// --- ordering: bundled first, then alphabetical ---------------------------

const ordered = orderProviders([
  provider({ id: 'z-user', displayName: 'Zeta', source: 'user' }),
  provider({ id: 'b-user', displayName: 'Beta', source: 'user' }),
  provider({ id: 'a-bundled', displayName: 'Alpha', source: 'bundled' }),
])
assert.deepEqual(
  ordered.map((entry) => entry.id),
  ['a-bundled', 'b-user', 'z-user'],
  'bundled providers sort ahead of user providers, then alphabetical'
)

// --- secret view derivation -----------------------------------------------

assert.deepEqual(
  deriveProviderSecretView({ ok: false, message: 'Conversation provider does not declare a secret.' }),
  { kind: 'none-required' },
  'a no-auth provider is not treated as an error'
)

assert.deepEqual(
  deriveProviderSecretView({ ok: false, message: 'Conversation provider is not installed.' }),
  { kind: 'error', message: 'Conversation provider is not installed.' },
  'a genuine status failure is an error view'
)

assert.deepEqual(
  deriveProviderSecretView({ ok: true, status: status({ configured: false, source: 'none' }) }),
  { kind: 'missing', label: 'OpenRouter API key', encryptionAvailable: true },
  'unconfigured auth provider is the missing-key view'
)

const configuredView = deriveProviderSecretView({
  ok: true,
  status: status(),
} satisfies ConversationSecretStatusResult)
assert.equal(configuredView.kind, 'configured', 'configured key yields the configured view')

// --- clearability ----------------------------------------------------------

assert.equal(canClearProviderSecret(deriveProviderSecretView({ ok: true, status: status() })), true)
assert.equal(
  canClearProviderSecret(deriveProviderSecretView({ ok: true, status: status({ source: 'environment' }) })),
  false,
  'environment keys cannot be cleared from the renderer'
)
assert.equal(canClearProviderSecret({ kind: 'none-required' }), false)
assert.equal(canClearProviderSecret({ kind: 'missing', label: 'API key', encryptionAvailable: true }), false)

console.log('providerSettings.test.ts passed')
