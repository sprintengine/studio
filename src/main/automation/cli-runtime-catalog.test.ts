import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { LoadedPlugin } from '../../shared/plugin-manifest'
import { createAutomationTools, type AutomationBackends, type CliModelSources } from './automation-tools'

// `cli.runtime.list`'s `catalog`: the model picker's own rows for each CLI,
// for a client that draws the same picker (the phone's New chat).

const NOW = Date.parse('2026-10-05T12:00:00Z')

function plugin(id: string, manifest: Record<string, unknown> = {}): LoadedPlugin {
  return {
    manifest: {
      schemaVersion: 1,
      id,
      displayName: id === 'claude-code' ? 'Claude Code' : id === 'zai' ? 'Z.AI' : id,
      version: 1,
      binary: id === 'claude-code' ? 'claude' : id,
      permissionPresets: {},
      launch: { args: [] },
      promptInjection: { mode: 'argv' },
      completion: { mode: 'exit' },
      capabilities: { resumeSession: true, sessionIdFromCaller: false, toolUse: true, mcpServers: true },
      ...manifest,
    } as unknown as LoadedPlugin['manifest'],
    source: 'bundled',
    manifestPath: `/plugins/${id}/manifest.json`,
    pluginRoot: `/plugins/${id}`,
  }
}

const CLAUDE = plugin('claude-code', {
  modelSelection: {
    args: ['--model', '{{model}}'],
    options: [{ id: 'opus', label: 'Opus' }],
    allowCustomId: true,
  },
  reasoningSelection: { args: ['--effort', '{{reasoning}}'], levels: [{ id: 'low' }, { id: 'high' }] },
})
// The claude binary pointed at another provider's endpoint: a hosted runtime.
const ZAI = plugin('zai', {
  binary: 'claude',
  launch: { args: [], env: { ANTHROPIC_BASE_URL: 'https://api.example.com/anthropic' } },
  modelSelection: { args: ['--model', '{{model}}'], options: [{ id: 'glm-5', label: 'GLM-5' }] },
})
const PLAIN = plugin('plain-cli')

const SOURCES: CliModelSources = {
  discovered: {
    'claude-code': {
      fetchedAt: '2026-10-05T00:00:00Z',
      source: 'agent-sdk',
      models: [
        { id: 'claude-opus-5', displayName: 'Opus 5', firstSeenAt: '2026-10-01T00:00:00Z' },
        { id: 'claude-opus-5[1m]', displayName: 'Opus 5 (1M context)' },
        { id: 'claude-sonnet-5', displayName: 'Sonnet 5', firstSeenAt: '2026-01-01T00:00:00Z' },
      ],
    },
  },
  userModels: (cli) => (cli === 'claude-code' ? ['claude-haiku-5'] : undefined),
}

async function list(backends: Partial<AutomationBackends>): Promise<Array<Record<string, unknown>>> {
  const tools = createAutomationTools({
    ...({} as AutomationBackends),
    listPlugins: () => [CLAUDE, ZAI, PLAIN],
    now: () => NOW,
    ...backends,
  })
  const registration = tools.find((candidate) => candidate.name === 'cli.runtime.list')!
  const result = await registration.handler({})
  return (result.structuredContent as { clis: Array<Record<string, unknown>> }).clis
}

function catalogOf(clis: Array<Record<string, unknown>>, id: string): Record<string, unknown> {
  return clis.find((entry) => entry.id === id)!.catalog as Record<string, unknown>
}

test("a CLI's catalog lists the picker's rows: what the CLI reported, then the ids added in Settings", async () => {
  const clis = await list({ readCliModelSources: async () => SOURCES })
  const models = catalogOf(clis, 'claude-code').models as Array<{ id: string }>
  assert.deepEqual(
    models.map((model) => model.id),
    ['claude-opus-5', 'claude-opus-5[1m]', 'claude-sonnet-5', 'claude-haiku-5'],
  )
})

test("a model's context windows share a family, each named as the picker names it", async () => {
  const clis = await list({ readCliModelSources: async () => SOURCES })
  const models = catalogOf(clis, 'claude-code').models as Array<Record<string, unknown>>
  assert.deepEqual(models.slice(0, 2), [
    {
      id: 'claude-opus-5',
      label: 'Opus 5',
      family: 'claude-opus-5',
      familyDefault: true,
      contextLabel: 'Standard',
      isNew: true,
      origin: 'discovered',
    },
    {
      id: 'claude-opus-5[1m]',
      label: 'Opus 5 (1M context)',
      family: 'claude-opus-5',
      familyDefault: false,
      contextLabel: '1M',
      isNew: true,
      origin: 'discovered',
    },
  ])
})

test('only a model first listed here recently is new, and an id the person added is never new', async () => {
  const clis = await list({ readCliModelSources: async () => SOURCES })
  const models = catalogOf(clis, 'claude-code').models as Array<Record<string, unknown>>
  assert.equal(models[2]?.isNew, undefined)
  assert.deepEqual(models[3], {
    id: 'claude-haiku-5',
    family: 'claude-haiku-5',
    familyDefault: true,
    contextLabel: 'Standard',
    origin: 'user',
  })
})

test("a CLI that has not reported a list answers its manifest's seed", async () => {
  const clis = await list({ readCliModelSources: async () => SOURCES })
  const models = catalogOf(clis, 'zai').models as Array<{ id: string; origin: string }>
  assert.deepEqual(
    models.map((model) => [model.id, model.origin]),
    [['glm-5', 'manifest']],
  )
})

test('a CLI with a chat runtime is conversational, and one without is not', async () => {
  const clis = await list({ readCliModelSources: async () => SOURCES })
  assert.equal(catalogOf(clis, 'claude-code').conversational, true)
  assert.equal(catalogOf(clis, 'zai').conversational, false)
  assert.equal(catalogOf(clis, 'plain-cli').conversational, false)
})

test('a hosted runtime names the CLI it rides on its provider line, as the picker does', async () => {
  const clis = await list({ readCliModelSources: async () => SOURCES })
  assert.equal(catalogOf(clis, 'zai').hostedVia, 'claude-code')
  assert.equal(catalogOf(clis, 'zai').providerLabel, 'Z.AI · via Claude Code')
  assert.equal(catalogOf(clis, 'claude-code').hostedVia, null)
  assert.equal(catalogOf(clis, 'claude-code').providerLabel, 'Claude Code')
})

test('a CLI that offers no model choice has an empty catalog that takes no custom id', async () => {
  const clis = await list({ readCliModelSources: async () => SOURCES })
  assert.deepEqual(catalogOf(clis, 'plain-cli').models, [])
  assert.equal(catalogOf(clis, 'plain-cli').allowCustomModelId, false)
  assert.equal(catalogOf(clis, 'claude-code').allowCustomModelId, true)
})

test("the manifest's own models stay as they were beside the catalog", async () => {
  const clis = await list({ readCliModelSources: async () => SOURCES })
  assert.deepEqual(clis.find((entry) => entry.id === 'claude-code')!.models, [{ id: 'opus', label: 'Opus' }])
})

test('a gateway with no model sources answers without a catalog, as before it had one', async () => {
  const clis = await list({})
  for (const entry of clis) assert.equal('catalog' in entry, false)
})

test('model sources that cannot be read leave the rows without a catalog rather than failing the list', async () => {
  const clis = await list({ readCliModelSources: () => Promise.reject(new Error('cache unreadable')) })
  assert.equal(clis.length, 3)
  for (const entry of clis) assert.equal('catalog' in entry, false)
})
