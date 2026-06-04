import assert from 'node:assert/strict'

import { isStoredAgentCliUnavailable } from './AgentPanel'
import type { PluginCatalogEntry } from '../../types/workspace'

const installedPlugins: PluginCatalogEntry[] = [
  { id: 'codex', displayName: 'Codex', source: 'bundled', version: 1, binary: 'codex' },
  { id: 'claude-code', displayName: 'Claude Code', source: 'bundled', version: 1, binary: 'claude' },
]

assert.equal(
  isStoredAgentCliUnavailable('opencode', 'ready', installedPlugins, undefined),
  true,
  'ready plugin catalog blocks an existing stored agent whose plugin id was removed',
)

assert.equal(
  isStoredAgentCliUnavailable('codex', 'ready', installedPlugins, undefined),
  false,
  'installed plugin ids remain launchable',
)

assert.equal(
  isStoredAgentCliUnavailable('opencode', 'loading', [], undefined),
  false,
  'loading catalog does not mark stored agent CLIs unavailable before registry evidence exists',
)

console.log('AgentPanel.test.ts: ok')
