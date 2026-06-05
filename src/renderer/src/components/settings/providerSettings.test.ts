import assert from 'node:assert/strict'

import type {
  ConversationProviderListResult,
  ConversationSecretStatus,
  ConversationSecretStatusResult,
} from '../../../../shared/electron-api'
import type { ConversationProviderListEntry } from '../../../../shared/plugin-manifest'
import {
  canClearProviderSecret,
  deriveProviderReadiness,
  deriveProviderSecretView,
  deriveProviderTabState,
  formatProviderModels,
  formatProviderSource,
  formatProviderType,
  orderProviders,
  summarizeProviderAdapter,
  summarizeProviderSecret,
} from './providerSettings'

function provider(overrides: Partial<ConversationProviderListEntry> = {}): ConversationProviderListEntry {
  return {
    id: 'openai-compatible',
    displayName: 'OpenAI-compatible',
    source: 'bundled',
    version: 1,
    providerType: 'model-provider',
    models: [{ id: 'gpt-4o', displayName: 'GPT-4o' }],
    adapter: { kind: 'declarative', execution: 'declarative', trust: 'not_required' },
    ...overrides,
  }
}

function status(overrides: Partial<ConversationSecretStatus> = {}): ConversationSecretStatus {
  return {
    providerId: 'openai-compatible',
    configured: true,
    source: 'settings',
    persistence: 'encrypted',
    encryptionAvailable: true,
    label: 'API key',
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

assert.deepEqual(
  summarizeProviderAdapter(provider()),
  { tone: 'neutral', label: 'Declarative provider' },
  'declarative providers are not reported as executable'
)
assert.deepEqual(
  summarizeProviderAdapter(
    provider({
      adapter: { kind: 'trusted-executable', execution: 'executable', trust: 'trusted', entry: 'dist/provider.js' },
    })
  ),
  { tone: 'good', label: 'Trusted adapter' },
  'trusted executable adapters report executable readiness'
)
assert.deepEqual(
  summarizeProviderAdapter(
    provider({
      adapter: {
        kind: 'trusted-executable',
        execution: 'blocked',
        trust: 'unsigned',
        entry: 'dist/provider.js',
        trustError: 'Unsigned executable provider adapters cannot run in production mode.',
      },
    })
  ),
  {
    tone: 'error',
    label: 'Adapter blocked',
    detail: 'Unsigned executable provider adapters cannot run in production mode.',
  },
  'blocked executable adapters surface the trust error'
)

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
  { kind: 'missing', label: 'API key', encryptionAvailable: true },
  'unconfigured auth provider is the missing-key view'
)

const configuredView = deriveProviderSecretView({
  ok: true,
  status: status(),
} satisfies ConversationSecretStatusResult)
assert.equal(configuredView.kind, 'configured', 'configured key yields the configured view')

// --- status summary (dot tone + text, never color-only) -------------------

assert.deepEqual(summarizeProviderSecret(undefined), { tone: 'neutral', label: 'Checking key status' })
assert.deepEqual(summarizeProviderSecret({ kind: 'none-required' }), {
  tone: 'neutral',
  label: 'No API key required',
})
assert.deepEqual(
  summarizeProviderSecret({ kind: 'missing', label: 'API key', encryptionAvailable: true }),
  { tone: 'warn', label: 'API key needed' }
)
assert.deepEqual(
  summarizeProviderSecret(deriveProviderSecretView({ ok: true, status: status({ source: 'environment' }) })),
  { tone: 'good', label: 'Using environment key' }
)
assert.deepEqual(
  summarizeProviderSecret(
    deriveProviderSecretView({
      ok: true,
      status: status({ source: 'session', persistence: 'session', encryptionAvailable: false }),
    })
  ),
  { tone: 'warn', label: 'Session-only key' }
)

// --- readiness verdict: honest, never a fake "connected" ------------------

assert.equal(
  deriveProviderReadiness({ kind: 'missing', label: 'API key', encryptionAvailable: true }).tone,
  'error',
  'missing key blocks readiness'
)
const sessionReadiness = deriveProviderReadiness(
  deriveProviderSecretView({
    ok: true,
    status: status({ source: 'session', persistence: 'session', encryptionAvailable: false }),
  })
)
assert.equal(sessionReadiness.tone, 'warn', 'session-only key is a readiness warning, not a hard pass')
assert.match(sessionReadiness.detail, /clears when Multicode quits/)

const encryptedReadiness = deriveProviderReadiness(deriveProviderSecretView({ ok: true, status: status() }))
assert.equal(encryptedReadiness.tone, 'good')
assert.equal(encryptedReadiness.headline, 'Credentials ready')
assert.doesNotMatch(encryptedReadiness.detail, /connected/i, 'readiness copy never claims a live connection')

// --- clearability ----------------------------------------------------------

assert.equal(canClearProviderSecret(deriveProviderSecretView({ ok: true, status: status() })), true)
assert.equal(
  canClearProviderSecret(deriveProviderSecretView({ ok: true, status: status({ source: 'environment' }) })),
  false,
  'environment keys cannot be cleared from the renderer'
)
assert.equal(canClearProviderSecret({ kind: 'none-required' }), false)
assert.equal(canClearProviderSecret({ kind: 'missing', label: 'API key', encryptionAvailable: true }), false)

// --- formatting ------------------------------------------------------------

assert.equal(formatProviderType('agent-harness'), 'Agent harness')
assert.equal(formatProviderType('model-provider'), 'Model provider')
assert.equal(formatProviderSource('bundled'), 'Built-in')
assert.equal(formatProviderSource('user'), 'User provider')
assert.equal(formatProviderModels([]), 'No models declared')
assert.equal(formatProviderModels([{ id: 'gpt-4o', displayName: 'GPT-4o' }]), 'GPT-4o')
assert.equal(
  formatProviderModels([{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]),
  'a, b +2 more',
  'model lists collapse to first two plus a remainder count'
)

console.log('providerSettings.test.ts passed')
