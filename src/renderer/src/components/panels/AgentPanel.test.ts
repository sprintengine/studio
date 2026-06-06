import assert from 'node:assert/strict'

import { isStoredAgentCliUnavailable, resolveAgentRuntimeKind } from './AgentPanel'
import { conversationAgentRuntimePatch } from '../workspace/conversationSpawnOptions'
import type { AgentState, PluginCatalogEntry } from '../../types/workspace'

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

// --- runtime kind routing --------------------------------------------------

const conversationAgent = {
  runtimeKind: 'conversation',
  conversation: { providerId: 'openai-compatible', modelId: 'gpt-4o' },
  kind: 'general',
} as Pick<AgentState, 'runtimeKind' | 'conversation' | 'kind'>

assert.equal(
  resolveAgentRuntimeKind(undefined, { isSprintEngineAgent: false, workspaceMode: 'standard' }),
  'terminal',
  'a missing agent defaults to terminal',
)

assert.equal(
  resolveAgentRuntimeKind({ kind: 'general' }, { isSprintEngineAgent: false, workspaceMode: 'standard' }),
  'terminal',
  'an agent with no runtimeKind (legacy persisted) is terminal',
)

assert.equal(
  resolveAgentRuntimeKind(conversationAgent, { isSprintEngineAgent: false, workspaceMode: 'standard' }),
  'conversation',
  'a standard agent with a valid conversation selection routes to the conversation runtime',
)

assert.equal(
  resolveAgentRuntimeKind(
    { runtimeKind: 'conversation', conversation: { providerId: '', modelId: '' }, kind: 'general' },
    { isSprintEngineAgent: false, workspaceMode: 'standard' },
  ),
  'terminal',
  'a conversation kind without a valid provider/model pair falls back to terminal',
)

assert.equal(
  resolveAgentRuntimeKind(conversationAgent, { isSprintEngineAgent: true, workspaceMode: 'sprintengine' }),
  'terminal',
  'Sprint Engine agents stay terminal even with a stored conversation selection',
)

assert.equal(
  resolveAgentRuntimeKind(conversationAgent, { isSprintEngineAgent: false, workspaceMode: 'multiloop' }),
  'terminal',
  'Multiloop workspaces stay terminal/MCP-owned',
)

// End-to-end spawn contract: the exact payload the spawn action writes must
// route to the conversation runtime in a standard workspace, and must still be
// forced back to terminal inside Sprint Engine / Multiloop workspaces.
const spawnedConversationAgent = conversationAgentRuntimePatch('openai-compatible', 'gpt-4o') as Pick<
  AgentState,
  'runtimeKind' | 'conversation' | 'kind'
>

assert.equal(
  resolveAgentRuntimeKind(spawnedConversationAgent, { isSprintEngineAgent: false, workspaceMode: 'standard' }),
  'conversation',
  'a spawned conversation agent routes to AgentChatView in a standard workspace',
)

assert.equal(
  resolveAgentRuntimeKind(spawnedConversationAgent, { isSprintEngineAgent: false, workspaceMode: 'sprintengine' }),
  'terminal',
  'the same spawned payload stays terminal in a Sprint Engine workspace',
)

assert.equal(
  resolveAgentRuntimeKind(spawnedConversationAgent, { isSprintEngineAgent: false, workspaceMode: 'multiloop' }),
  'terminal',
  'the same spawned payload stays terminal in a Multiloop workspace',
)

console.log('AgentPanel.test.ts: ok')
