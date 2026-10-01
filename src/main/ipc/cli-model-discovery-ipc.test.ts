import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { DiscoveredCliModelCatalog } from '../../shared/cli-model-catalog'
import {
  CLI_MODELS_CHANGED_CHANNEL,
  CLI_MODELS_DISCOVER_CHANNEL,
  type CliModelDiscoveryInput,
  type CliModelDiscoveryResult,
} from '../../shared/ipc/cli-model-discovery'
import { discoverAndBroadcastCliModels, registerCliModelDiscoveryIpc } from './cli-model-discovery-ipc'

const CATALOG: DiscoveredCliModelCatalog = {
  models: [{ id: 'grok-4.6' }],
  fetchedAt: '2026-09-22T10:00:00.000Z',
  source: 'argv-probe',
}

const RESULT: CliModelDiscoveryResult = {
  startedAt: '2026-09-22T10:00:00.000Z',
  finishedAt: '2026-09-22T10:00:01.000Z',
  entries: [
    { cli: 'grok', catalog: CATALOG },
    { cli: 'codex', catalog: CATALOG, skipped: 'fresh' },
    { cli: 'cursor', catalog: null, error: 'Cursor did not print a model list.' },
    { cli: 'kimi-code', catalog: null, skipped: 'no-probe' },
  ],
}

function fakeWindow(destroyed = false) {
  const sent: Array<{ channel: string; payload: unknown }> = []
  return {
    sent,
    isDestroyed: () => destroyed,
    webContents: { send: (channel: string, payload: unknown) => void sent.push({ channel, payload }) },
  }
}

test('only catalogs a probe produced are pushed, to every live window', async () => {
  const a = fakeWindow()
  const b = fakeWindow()
  const gone = fakeWindow(true)
  const result = await discoverAndBroadcastCliModels(
    {},
    { discover: async () => RESULT, getWindows: () => [a, b, gone] },
  )
  assert.equal(result, RESULT, 'the caller gets the whole answer, skips and errors included')
  const expected = { channel: CLI_MODELS_CHANGED_CHANNEL, payload: { ...RESULT, entries: [RESULT.entries[0]] } }
  assert.deepEqual(a.sent, [expected])
  assert.deepEqual(b.sent, [expected])
  assert.deepEqual(gone.sent, [])
})

test('a pass that produced nothing pushes nothing', async () => {
  const win = fakeWindow()
  await discoverAndBroadcastCliModels(
    {},
    { discover: async () => ({ ...RESULT, entries: RESULT.entries.slice(1) }), getWindows: () => [win] },
  )
  assert.deepEqual(win.sent, [])
})

test('the discover channel passes the declared fields on and drops the rest', async () => {
  const handlers = new Map<string, (event: unknown, raw?: unknown) => Promise<unknown>>()
  const inputs: CliModelDiscoveryInput[] = []
  registerCliModelDiscoveryIpc(
    { handle: (channel: string, handler: never) => void handlers.set(channel, handler) } as never,
    {
      discover: async (input) => {
        inputs.push(input)
        return { ...RESULT, entries: [] }
      },
      getWindows: () => [],
    },
  )
  const handle = handlers.get(CLI_MODELS_DISCOVER_CHANNEL)
  assert.ok(handle)
  await handle({}, { force: true, clis: ['codex', 7], previous: { codex: CATALOG }, cliRuntimes: 'x', extra: 1 })
  await handle({}, 'nonsense')
  assert.deepEqual(inputs, [{ force: true, clis: ['codex'], previous: { codex: CATALOG } }, {}])
})

test("a pass main starts itself runs with the mirrored per-CLI overrides; a window's own win", async () => {
  const inputs: CliModelDiscoveryInput[] = []
  const deps = {
    discover: async (input: CliModelDiscoveryInput) => {
      inputs.push(input)
      return { ...RESULT, entries: [] }
    },
    getWindows: () => [],
    mainCliRuntimes: () => ({
      codex: { command: '/opt/codex/bin/codex' },
      'claude-code': { command: '', hostId: 'wsl:Ubuntu' as const },
    }),
  }
  await discoverAndBroadcastCliModels({ clis: ['codex'] }, deps)
  await discoverAndBroadcastCliModels({ cliRuntimes: { codex: { command: 'codex' } } }, deps)
  await discoverAndBroadcastCliModels({}, { ...deps, mainCliRuntimes: () => ({}) })
  await discoverAndBroadcastCliModels(
    {},
    {
      ...deps,
      mainCliRuntimes: () => {
        throw new Error('mirror unreadable')
      },
    },
  )
  assert.deepEqual(inputs, [
    { clis: ['codex'], cliRuntimes: deps.mainCliRuntimes() },
    { cliRuntimes: { codex: { command: 'codex' } } },
    {},
    {},
  ])
})
