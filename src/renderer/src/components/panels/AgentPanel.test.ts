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
// Which runtime a tab mounts is the agent's own stored selection, and nothing
// else: a provider-backed conversation, or the terminal.

const conversationAgent = {
  runtimeKind: 'conversation',
  conversation: { providerId: 'openai-compatible', modelId: 'gpt-4o' },
} as Pick<AgentState, 'runtimeKind' | 'conversation'>

assert.equal(resolveAgentRuntimeKind(undefined), 'terminal', 'a missing agent defaults to terminal')

assert.equal(
  resolveAgentRuntimeKind({} as Pick<AgentState, 'runtimeKind' | 'conversation'>),
  'terminal',
  'an agent with no runtimeKind (legacy persisted) is terminal',
)

assert.equal(
  resolveAgentRuntimeKind(conversationAgent),
  'conversation',
  'an agent with a valid conversation selection routes to the conversation runtime',
)

assert.equal(
  resolveAgentRuntimeKind(
    { runtimeKind: 'conversation', conversation: { providerId: '', modelId: '' } } as Pick<
      AgentState,
      'runtimeKind' | 'conversation'
    >,
  ),
  'terminal',
  'a conversation kind without a valid provider/model pair falls back to terminal',
)

// End-to-end spawn contract: the exact payload the spawn action writes must
// route to the conversation runtime.
const spawnedConversationAgent = conversationAgentRuntimePatch('openai-compatible', 'gpt-4o') as Pick<
  AgentState,
  'runtimeKind' | 'conversation'
>

assert.equal(
  resolveAgentRuntimeKind(spawnedConversationAgent),
  'conversation',
  'a spawned conversation agent routes to AgentChatView',
)

console.log('AgentPanel.test.ts: ok')
