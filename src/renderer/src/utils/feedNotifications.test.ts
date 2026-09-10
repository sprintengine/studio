import assert from 'node:assert/strict'

import type { HostedModelFeed } from '../../../shared/hosted-model-feed'
import { cliUpdateNotice, newModelsNotice, retiredModelNotices, updateReadyNotice } from './feedNotifications'

const names: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex', grok: 'Grok Build' }
const displayName = (cli: string) => names[cli] ?? cli
const model = (id: string, label = id, extra: Record<string, unknown> = {}) => ({ id, label, ...extra })

// One toast per fetch, naming up to three, only for installed CLIs, never for
// ids the person added by hand.
assert.deepEqual(
  newModelsNotice({
    additions: { 'claude-code': [model('claude-opus-5-2', 'Opus 5.2'), model('claude-opus-5-2[1m]', 'Opus 5.2 (1M context)')] },
    installed: new Set(['claude-code']),
    userModels: () => [],
    displayName,
  }),
  { title: 'New models for Claude Code', description: 'Opus 5.2 and Opus 5.2 (1M context) are in the picker.' },
)
assert.deepEqual(
  newModelsNotice({
    additions: { 'claude-code': [model('a', 'A')], codex: [model('b', 'B'), model('c', 'C'), model('d', 'D'), model('e', 'E')] },
    installed: new Set(['claude-code', 'codex']),
    userModels: () => [],
    displayName,
  }),
  { title: 'New models for Claude Code and Codex', description: 'A, B, C, and 2 more are in the picker.' },
)
assert.deepEqual(
  newModelsNotice({ additions: { codex: [model('b', 'B')] }, installed: new Set(['codex']), userModels: () => [], displayName }),
  { title: 'New model for Codex', description: 'B is in the picker.' },
)
assert.equal(
  newModelsNotice({ additions: { grok: [model('g', 'G')] }, installed: new Set(['codex']), userModels: () => [], displayName }),
  null,
  'a CLI that is not installed makes no notice',
)
assert.equal(
  newModelsNotice({ additions: { codex: [model('mine', 'Mine')] }, installed: new Set(['codex']), userModels: () => ['mine'], displayName }),
  null,
  'an id the person already added by hand is not news',
)
assert.equal(newModelsNotice({ additions: {}, installed: new Set(['codex']), userModels: () => [], displayName }), null)

// Retired: only when remembered, only when newly retired.
const feed = (models: ReturnType<typeof model>[]): HostedModelFeed => ({
  schemaVersion: 1,
  updatedAt: '2026-09-04T00:00:00Z',
  clis: { 'claude-code': { models: models as HostedModelFeed['clis'][string]['models'] } },
})
const retired = feed([model('claude-opus-4-8', 'Opus 4.8', { retired: true, retiredAt: '2026-09-01' })])
assert.deepEqual(
  retiredModelNotices({
    previous: feed([model('claude-opus-4-8', 'Opus 4.8')]),
    next: retired,
    remembered: [{ who: 'Codex Reviewer', cli: 'claude-code', model: 'claude-opus-4-8' }],
    displayName,
  }),
  [{ title: 'Opus 4.8 has been retired', description: "Codex Reviewer used it. It launches with Claude Code's default until you pick another." }],
)
assert.deepEqual(
  retiredModelNotices({ previous: feed([model('claude-opus-4-8', 'Opus 4.8')]), next: retired, remembered: [], displayName }),
  [],
  'a retired id nobody selected leaves quietly',
)
assert.deepEqual(
  retiredModelNotices({
    previous: retired,
    next: retired,
    remembered: [{ who: 'Planner', cli: 'claude-code', model: 'claude-opus-4-8' }],
    displayName,
  }),
  [],
  'an id that was already retired is not announced again',
)
assert.deepEqual(
  retiredModelNotices({
    previous: null,
    next: retired,
    remembered: [{ who: 'Planner', cli: 'claude-code', model: 'claude-opus-4-8' }, { who: 'Reviewer', cli: 'claude-code', model: 'claude-opus-4-8' }],
    displayName,
  })[0].description,
  "Planner and Reviewer used it. They launch with Claude Code's default until you pick another.",
)

assert.deepEqual(
  cliUpdateNotice({ cli: 'codex', status: 'behind_latest', currentVersion: '0.153.2', latestVersion: '0.153.3', updateCommand: null, checkedAt: '' }, displayName),
  { title: 'Update available: Codex 0.153.3' },
)
assert.deepEqual(updateReadyNotice('Sprint Engine Studio', '0.4.0'), { title: 'Sprint Engine Studio 0.4.0 is ready', description: 'Installs the next time you quit.' })

console.log('feedNotifications: ok')
