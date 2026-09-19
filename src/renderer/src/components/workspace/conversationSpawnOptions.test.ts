import assert from 'node:assert/strict'

import {
  buildConversationSpawnOptions,
  conversationAgentRuntimePatch,
  resolveDefaultConversationOption,
} from './conversationSpawnOptions'
import type { ConversationProviderListResult } from '../../../../shared/electron-api'
import type { ConversationProviderListEntry } from '../../../../shared/plugin-manifest'
import { test } from 'vitest'

test('conversationSpawnOptions', async () => {
  function provider(overrides: Partial<ConversationProviderListEntry> = {}): ConversationProviderListEntry {
    return {
      id: 'openai-compatible',
      displayName: 'OpenAI Compatible API',
      source: 'bundled',
      version: 1,
      providerType: 'model-provider',
      models: [],
      supportsDynamicModels: false,
      adapter: { kind: 'declarative', execution: 'declarative', trust: 'not_required' },
      ...overrides,
    }
  }

  // One option per model, in catalog order, with provider/model ids preserved
  // exactly and the model display name used when present.
  const populated: ConversationProviderListResult = {
    ok: true,
    providers: [
      provider({
        models: [
          { id: 'gpt-4o-mini', displayName: 'GPT-4o mini' },
          { id: 'gpt-4o', displayName: 'GPT-4o' },
        ],
      }),
    ],
  }

  assert.deepEqual(
    buildConversationSpawnOptions(populated),
    [
      {
        providerId: 'openai-compatible',
        providerLabel: 'OpenAI Compatible API',
        providerType: 'model-provider',
        modelId: 'gpt-4o-mini',
        modelLabel: 'GPT-4o mini',
      },
      {
        providerId: 'openai-compatible',
        providerLabel: 'OpenAI Compatible API',
        providerType: 'model-provider',
        modelId: 'gpt-4o',
        modelLabel: 'GPT-4o',
      },
    ],
    'one option per model, ids preserved, display names used',
  )

  // A model without a display name falls back to its id for the label, but the
  // modelId stays exact.
  assert.deepEqual(
    buildConversationSpawnOptions({
      ok: true,
      providers: [provider({ models: [{ id: 'local-model' }] })],
    }),
    [
      {
        providerId: 'openai-compatible',
        providerLabel: 'OpenAI Compatible API',
        providerType: 'model-provider',
        modelId: 'local-model',
        modelLabel: 'local-model',
      },
    ],
    'missing model display name falls back to the model id',
  )

  // Multiple providers flatten in order; ids from each provider are kept distinct.
  const multi = buildConversationSpawnOptions({
    ok: true,
    providers: [
      provider({ id: 'openai-compatible', displayName: 'OpenAI Compatible API', models: [{ id: 'gpt-4o' }] }),
      provider({ id: 'anthropic-compatible', displayName: 'Anthropic Compatible API', models: [{ id: 'sonnet' }] }),
    ],
  })
  assert.deepEqual(
    multi.map((option) => `${option.providerId}:${option.modelId}`),
    ['openai-compatible:gpt-4o', 'anthropic-compatible:sonnet'],
    'providers flatten in order with ids preserved per provider',
  )

  // Empty catalog, failed result, and missing result all yield no rows — never a
  // fabricated entry.
  assert.deepEqual(buildConversationSpawnOptions({ ok: true, providers: [] }), [], 'empty provider list yields no rows')
  assert.deepEqual(
    buildConversationSpawnOptions({ ok: false, message: 'providers unavailable' }),
    [],
    'failed result yields no rows',
  )
  assert.deepEqual(buildConversationSpawnOptions(null), [], 'missing result yields no rows')

  // Default-option resolution: remembered pair wins when still installed, else the
  // first available option; no options yields null.
  const options = buildConversationSpawnOptions(populated)
  assert.equal(
    resolveDefaultConversationOption([], { providerId: 'openai-compatible', modelId: 'gpt-4o' }),
    null,
    'no options yields null',
  )
  assert.equal(
    resolveDefaultConversationOption(options, null)?.modelId,
    'gpt-4o-mini',
    'no remembered pair falls back to the first available option',
  )
  assert.equal(
    resolveDefaultConversationOption(options, { providerId: 'openai-compatible', modelId: 'gpt-4o' })?.modelId,
    'gpt-4o',
    'a remembered pair that is still installed is reused',
  )
  assert.equal(
    resolveDefaultConversationOption(options, { providerId: 'openai-compatible', modelId: 'removed-model' })?.modelId,
    'gpt-4o-mini',
    'a remembered pair that is no longer installed falls back to the first option',
  )

  // Dynamic providers accept a remembered model that is not in the seed list, so it
  // still seeds a new spawn (synthesized from the provider label).
  const dynamicDefault = resolveDefaultConversationOption(
    options,
    { providerId: 'openai-compatible', modelId: 'anthropic/claude-live-only' },
    new Set(['openai-compatible']),
  )
  assert.deepEqual(
    dynamicDefault,
    {
      providerId: 'openai-compatible',
      providerLabel: 'OpenAI Compatible API',
      providerType: 'model-provider',
      modelId: 'anthropic/claude-live-only',
      modelLabel: 'anthropic/claude-live-only',
    },
    'a remembered live-only model on a dynamic provider seeds the spawn',
  )
  assert.equal(
    resolveDefaultConversationOption(options, {
      providerId: 'openai-compatible',
      modelId: 'anthropic/claude-live-only',
    })?.modelId,
    'gpt-4o-mini',
    'without the dynamic flag, an unknown remembered model still falls back to the first option',
  )

  // Subscription first: with an agent-harness provider installed, a new spawn
  // defaults to it even when the last conversation used a metered API provider.
  const withHarness = buildConversationSpawnOptions({
    ok: true,
    providers: [
      provider({
        models: [
          { id: 'gpt-4o-mini', displayName: 'GPT-4o mini' },
          { id: 'gpt-4o', displayName: 'GPT-4o' },
        ],
      }),
      provider({
        id: 'claude-agent',
        displayName: 'Claude Code',
        providerType: 'agent-harness',
        models: [
          { id: 'sonnet', displayName: 'Sonnet' },
          { id: 'opus', displayName: 'Opus' },
        ],
      }),
    ],
  })
  assert.deepEqual(
    resolveDefaultConversationOption(withHarness, { providerId: 'openai-compatible', modelId: 'gpt-4o' }),
    {
      providerId: 'claude-agent',
      providerLabel: 'Claude Code',
      providerType: 'agent-harness',
      modelId: 'sonnet',
      modelLabel: 'Sonnet',
    },
    'a metered remembered model never silently seeds a spawn while the subscription harness is installed',
  )
  assert.equal(
    resolveDefaultConversationOption(withHarness, { providerId: 'claude-agent', modelId: 'opus' })?.modelId,
    'opus',
    'the remembered model is honored within the harness provider',
  )
  assert.equal(
    resolveDefaultConversationOption(withHarness, null)?.providerId,
    'claude-agent',
    'no remembered pair defaults straight to the harness provider',
  )

  // An unavailable provider (e.g. harness CLI not found) keeps its rows, marked
  // with the reason — default resolution must be able to tell "no subscription
  // installed" apart from "subscription installed but currently undetectable".
  const withUnavailableHarness = buildConversationSpawnOptions({
    ok: true,
    providers: [
      provider({ models: [{ id: 'gpt-4o-mini', displayName: 'GPT-4o mini' }] }),
      provider({
        id: 'claude-agent',
        displayName: 'Claude Code',
        providerType: 'agent-harness',
        models: [{ id: 'sonnet', displayName: 'Sonnet' }],
        unavailable: 'The Claude Code CLI wasn’t found from the app.',
      }),
    ],
  })
  assert.equal(
    withUnavailableHarness.find((option) => option.providerId === 'claude-agent')?.unavailable,
    'The Claude Code CLI wasn’t found from the app.',
    'unavailable providers keep their rows, marked with the reason',
  )
  // Fail closed, never open: an installed-but-undetectable subscription harness
  // yields NO spawn default — a probe false-negative must not silently re-route
  // new conversations onto a metered API provider.
  assert.equal(
    resolveDefaultConversationOption(withUnavailableHarness, null),
    null,
    'an unavailable harness suppresses the spawn default instead of falling through to metered',
  )
  assert.equal(
    resolveDefaultConversationOption(withUnavailableHarness, { providerId: 'claude-agent', modelId: 'sonnet' }),
    null,
    'a remembered harness model on an unavailable harness also fails closed',
  )
  // With no harness installed at all, unavailable metered rows are skipped too.
  const onlyUnavailableMetered = buildConversationSpawnOptions({
    ok: true,
    providers: [
      provider({
        models: [{ id: 'gpt-4o', displayName: 'GPT-4o' }],
        unavailable: 'unreachable',
      }),
    ],
  })
  assert.equal(resolveDefaultConversationOption(onlyUnavailableMetered, null), null, 'no available options yields null')

  // The spawn patch opts the agent into the conversation runtime and clears every
  // terminal field, so a spawned agent never starts a CLI session.
  const patch = conversationAgentRuntimePatch('openai-compatible', 'gpt-4o')
  assert.equal(patch.runtimeKind, 'conversation', 'patch sets the conversation runtime')
  assert.deepEqual(
    patch.conversation,
    { providerId: 'openai-compatible', modelId: 'gpt-4o' },
    'patch carries the exact provider/model pair',
  )
  assert.equal(patch.cliStartRequested, false, 'no terminal start is requested')
  assert.equal('cliSessionId' in patch && patch.cliSessionId, undefined, 'no terminal session id is assigned')
  assert.equal(patch.cli, undefined, 'no CLI is selected for a conversation agent')
  assert.equal(patch.cliStartupPrompt, undefined, 'no startup prompt is queued')

  console.log('conversationSpawnOptions tests passed')
})
