import assert from 'node:assert/strict'

import type { DiscoveredCliModelCatalog } from '../../../shared/cli-model-catalog'
import { cliUpdateNotice, discoveredModelAdditions, newModelsNotice, updateReadyNotice } from './feedNotifications'
import { test } from 'vitest'

test('feedNotifications', async () => {
  const names: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex', grok: 'Grok Build' }
  const displayName = (cli: string) => names[cli] ?? cli
  const model = (id: string, displayName?: string) => ({ id, ...(displayName ? { displayName } : {}) })

  // One toast per refresh, naming up to three, only for installed CLIs, never for
  // ids the person added by hand.
  assert.deepEqual(
    newModelsNotice({
      additions: {
        'claude-code': [model('claude-opus-5-2', 'Opus 5.2'), model('claude-opus-5-2[1m]', 'Opus 5.2 (1M context)')],
      },
      installed: new Set(['claude-code']),
      userModels: () => [],
      displayName,
    }),
    { title: 'New models for Claude Code', description: 'Opus 5.2 and Opus 5.2 (1M context) are in the picker.' },
  )
  assert.deepEqual(
    newModelsNotice({
      additions: {
        'claude-code': [model('a', 'A')],
        codex: [model('b', 'B'), model('c', 'C'), model('d', 'D'), model('e', 'E')],
      },
      installed: new Set(['claude-code', 'codex']),
      userModels: () => [],
      displayName,
    }),
    { title: 'New models for Claude Code and Codex', description: 'A, B, C, and 2 more are in the picker.' },
  )
  assert.deepEqual(
    newModelsNotice({
      additions: { codex: [model('b', 'B')] },
      installed: new Set(['codex']),
      userModels: () => [],
      displayName,
    }),
    { title: 'New model for Codex', description: 'B is in the picker.' },
  )
  assert.equal(
    newModelsNotice({
      additions: { grok: [model('g', 'G')] },
      installed: new Set(['codex']),
      userModels: () => [],
      displayName,
    }),
    null,
    'a CLI that is not installed makes no notice',
  )
  assert.equal(
    newModelsNotice({
      additions: { codex: [model('mine', 'Mine')] },
      installed: new Set(['codex']),
      userModels: () => ['mine'],
      displayName,
    }),
    null,
    'an id the person already added by hand is not news',
  )
  assert.equal(
    newModelsNotice({ additions: {}, installed: new Set(['codex']), userModels: () => [], displayName }),
    null,
  )

  const codexBehind = {
    cli: 'codex',
    hostId: 'local' as const,
    status: 'behind_latest' as const,
    currentVersion: '0.153.2',
    latestVersion: '0.153.3',
    updateCommand: null,
    checkedAt: '',
  }
  assert.deepEqual(cliUpdateNotice(codexBehind, displayName), { title: 'Update available: Codex 0.153.3' })
  assert.deepEqual(
    cliUpdateNotice({ ...codexBehind, hostId: 'wsl:Ubuntu' }, displayName, 'WSL: Ubuntu'),
    { title: 'Update available: Codex 0.153.3 (WSL: Ubuntu)' },
    'a WSL machine’s update names the machine',
  )
  assert.deepEqual(updateReadyNotice('Sprint Engine Studio', '0.4.0'), {
    title: 'Sprint Engine Studio 0.4.0 is ready',
    description: 'Restart now to update, or it installs the next time you quit.',
  })

  console.log('feedNotifications: ok')
})

const catalog = (models: DiscoveredCliModelCatalog['models'], fetchedAt = '2026-09-22T10:00:00Z') => ({
  models,
  fetchedAt,
  source: 'argv-probe' as const,
})

test('a refresh that lists a new id announces it', () => {
  const before = { codex: catalog([{ id: 'gpt-5.5' }]) }
  const after = {
    codex: catalog([{ id: 'gpt-5.6', displayName: 'GPT-5.6', firstSeenAt: '2026-09-22T12:00:00Z' }, { id: 'gpt-5.5' }]),
  }
  assert.deepEqual(discoveredModelAdditions(before, after), {
    codex: [{ id: 'gpt-5.6', displayName: 'GPT-5.6', firstSeenAt: '2026-09-22T12:00:00Z' }],
  })
})

test('the first-ever probe, or the catalogs arriving at boot, announce nothing', () => {
  const after = { codex: catalog([{ id: 'gpt-5.6', firstSeenAt: '2026-09-22T12:00:00Z' }]) }
  assert.deepEqual(discoveredModelAdditions({}, after), {})
  assert.deepEqual(discoveredModelAdditions(undefined, after), {})
  assert.deepEqual(discoveredModelAdditions(after, after), {}, 'an unchanged catalog is not news')
})

test('a row without firstSeenAt, or one the previous catalog had, is not news', () => {
  const before = { codex: catalog([{ id: 'gpt-5.5', firstSeenAt: '2026-09-01T00:00:00Z' }]) }
  const after = {
    codex: catalog([{ id: 'gpt-5.5', firstSeenAt: '2026-09-01T00:00:00Z' }, { id: 'gpt-5.6' }], '2026-09-22T12:00:00Z'),
  }
  assert.deepEqual(discoveredModelAdditions(before, after), {})
})

test('a notice names an unlabelled id by the id itself', () => {
  assert.deepEqual(
    newModelsNotice({
      additions: { opencode: [{ id: 'openai/gpt-5.6' }] },
      installed: new Set(['opencode']),
      userModels: () => [],
      displayName: () => 'OpenCode',
    }),
    { title: 'New model for OpenCode', description: 'openai/gpt-5.6 is in the picker.' },
  )
})
