import assert from 'node:assert/strict'

import { isStoredAgentCliUnavailable, resolveAgentRuntimeKind } from './AgentPanel'
import { conversationAgentRuntimePatch } from '../workspace/conversationSpawnOptions'
import type { AgentState, PluginCatalogEntry } from '../../types/workspace'

const installedPlugins: PluginCatalogEntry[] = [
  { id: 'codex', displayName: 'Codex', source: 'bundled', version: 1, binary: 'codex', resumeSession: true, sessionIdFromCaller: false, agentStateCapable: true },
  { id: 'claude-code', displayName: 'Claude Code', source: 'bundled', version: 1, binary: 'claude', resumeSession: true, sessionIdFromCaller: true, agentStateCapable: true },
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

// --- availability-aware launch guard --------------------------------------
// A registered-but-not-installed CLI (Claude Code on a Codex-only machine) must
// be flagged unavailable so the stored agent does not spawn a missing binary.
assert.equal(
  isStoredAgentCliUnavailable('claude-code', 'ready', installedPlugins, undefined, {
    map: {
      codex: { cli: 'codex', installed: true, resolvedPath: '/bin/codex', version: '1' },
      'claude-code': { cli: 'claude-code', installed: false, resolvedPath: null, version: null },
    },
    status: 'ready',
  }),
  true,
  'a stored Claude Code agent is unavailable when its binary is not installed',
)
assert.equal(
  isStoredAgentCliUnavailable('codex', 'ready', installedPlugins, undefined, {
    map: {
      codex: { cli: 'codex', installed: true, resolvedPath: '/bin/codex', version: '1' },
      'claude-code': { cli: 'claude-code', installed: false, resolvedPath: null, version: null },
    },
    status: 'ready',
  }),
  false,
  'an installed CLI stays launchable when availability is known',
)
assert.equal(
  isStoredAgentCliUnavailable('claude-code', 'ready', installedPlugins, undefined, {
    map: {},
    status: 'loading',
  }),
  false,
  'availability still loading does not block a stored agent (never-empty fallback)',
)
// The fresh-Mac case (MC-2093): NOTHING is installed. The catalog used to give
// up filtering here and hand back every registered CLI, so membership read the
// stored agent's CLI as present and the pane spawned against a missing binary.
assert.equal(
  isStoredAgentCliUnavailable('codex', 'ready', installedPlugins, undefined, {
    map: {
      codex: { cli: 'codex', installed: false, resolvedPath: null, version: null },
      'claude-code': { cli: 'claude-code', installed: false, resolvedPath: null, version: null },
    },
    status: 'ready',
  }),
  true,
  'a stored agent is unavailable when nothing at all is installed',
)
// …while a probe that never completed is still undecided, so the same machine
// mid-probe does not block agents that may well be there.
assert.equal(
  isStoredAgentCliUnavailable('codex', 'ready', installedPlugins, undefined, {
    map: {
      codex: { cli: 'codex', installed: false, resolvedPath: null, version: null },
      'claude-code': { cli: 'claude-code', installed: false, resolvedPath: null, version: null },
    },
    status: 'error',
  }),
  false,
  'an errored probe leaves a stored agent launchable rather than blocking on a guess',
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

// End-to-end spawn contract: the exact payload the spawn action writes must
// route to the conversation runtime in a standard workspace, and must still be
// forced back to terminal inside Sprint Engine workspaces.
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

console.log('AgentPanel.test.ts: ok')
