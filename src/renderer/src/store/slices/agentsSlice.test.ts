import assert from 'node:assert/strict'

import type { TerminalSessionSnapshot } from '../../../../shared/electron-api'
import type { LayoutTemplate, Workspace } from '../../types/workspace'
import { getEditorBuffer } from '../../utils/editorBuffers'
import { useWorkspaceStore } from '../workspaceStore'
import {
  createAgentsSlice,
  defaultAgent,
  defaultEditorState,
  normalizeAgentConversation,
  normalizeAgentExecution,
  normalizeAgentRuntime,
  normalizeAgentState,
} from './agentsSlice'
import { defaultWorkspaceMemoryConfig } from './memorySlice'
import { defaultSprintEngineAutoState, defaultMultiloopAutoState } from './runStateSlice'
import { defaultWorkspaceWorktreeState } from './worktreesSlice'

const standardTemplate: LayoutTemplate = {
  id: 'agents-slice-standard',
  name: 'Standard',
  description: 'Standard workspace test template',
  previewSlots: [],
  layout: {
    global: { tabSetEnableDrop: true, tabEnableClose: false },
    borders: [],
    layout: {
      type: 'row',
      children: [
        {
          type: 'tabset',
          weight: 100,
          children: [{ type: 'tab', name: 'Editor', component: 'editor' }],
        },
      ],
    },
  },
}

function terminalSession(input: Partial<TerminalSessionSnapshot> & { sessionId: string }): TerminalSessionSnapshot {
  return {
    sessionId: input.sessionId,
    processAlive: input.processAlive ?? true,
    kind: input.kind ?? 'agent',
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    terminalId: input.terminalId,
    cli: input.cli,
    cwd: input.cwd,
    sprintEngineStatePath: input.sprintEngineStatePath,
    executionMode: input.executionMode,
    worktreeId: input.worktreeId,
    worktreePath: input.worktreePath,
    agentSession: input.agentSession,
    visible: input.visible ?? true,
    startedAt: input.startedAt ?? 1,
    lastOutputAt: input.lastOutputAt ?? null,
    lastInputAt: input.lastInputAt ?? null,
    activity: input.activity ?? { kind: 'idle', since: 1 },
    exitedAt: input.exitedAt ?? null,
    outputBufferLength: input.outputBufferLength ?? 0,
    retainedOutputBytes: input.retainedOutputBytes ?? 0,
  }
}

assert.deepEqual(normalizeAgentExecution({ mode: 'worktree', worktreeId: ' wt-1 ', cwd: '/repo' }), {
  mode: 'worktree',
  worktreeId: 'wt-1',
  cwd: '/repo',
})
assert.deepEqual(normalizeAgentExecution({ mode: 'worktree', worktreeId: ' ', cwd: ' ' }), {
  mode: 'worktree',
  worktreeId: null,
  cwd: null,
})
assert.deepEqual(normalizeAgentExecution({ mode: 'current_workspace', worktreeId: 'wt-1', cwd: '/repo' }), {
  mode: 'current_workspace',
  worktreeId: null,
  cwd: null,
})
assert.equal(
  normalizeAgentState({
    ...defaultAgent('agent-normalize'),
    cliPermissionPreset: 'invalid' as never,
  }).cliPermissionPreset,
  'default',
)
assert.equal(
  normalizeAgentState({
    ...defaultAgent('agent-normalize-fallback'),
    cli: undefined,
  }, 'claude').cli,
  'claude-code',
)
assert.equal(
  normalizeAgentState({
    ...defaultAgent('agent-legacy'),
    name: 'Recovered Agent',
    cli: undefined,
  }).cli,
  undefined,
)

const carrier: { workspaces: Workspace[] } = {
  workspaces: [
    {
      id: 'ws-direct',
      name: 'Direct Workspace',
      mode: 'standard',
      folderPath: null,
      templateId: 'agents-slice-standard',
      agents: {},
      layoutModel: standardTemplate.layout,
      worktreeState: defaultWorkspaceWorktreeState(),
      memory: defaultWorkspaceMemoryConfig(),
      editorState: defaultEditorState(),
      sprintEngineState: null,
      multiloopState: null,
      sprintEngineAutoState: defaultSprintEngineAutoState(),
      multiloopAutoState: defaultMultiloopAutoState(),
      createdAt: 1,
    },
  ],
}
const directSlice = createAgentsSlice((mutator) => mutator(carrier))

directSlice.updateAgent('ws-direct', 'agent-direct', {
  name: 'Direct Agent',
  execution: { mode: 'worktree', worktreeId: ' worktree-a ', cwd: '/repo/worktree-a' },
})
assert.equal(carrier.workspaces[0].agents['agent-direct'].name, 'Direct Agent')
assert.deepEqual(carrier.workspaces[0].agents['agent-direct'].execution, {
  mode: 'worktree',
  worktreeId: 'worktree-a',
  cwd: '/repo/worktree-a',
})

directSlice.appendStream('ws-direct', 'agent-direct', 'hello')
directSlice.appendStream('ws-direct', 'agent-direct', ' world')
assert.equal(carrier.workspaces[0].agents['agent-direct'].status, 'streaming')
directSlice.commitStream('ws-direct', 'agent-direct')
assert.equal(carrier.workspaces[0].agents['agent-direct'].streamBuffer, '')
assert.equal(carrier.workspaces[0].agents['agent-direct'].status, 'complete')
assert.equal(carrier.workspaces[0].agents['agent-direct'].messages.at(-1)?.content, 'hello world')

directSlice.openFile('ws-direct', '/tmp/agent.ts', 'agent.ts', 'const agent = true')
directSlice.updateFileContent('ws-direct', '/tmp/agent.ts', 'const agent = false')
assert.equal(getEditorBuffer('ws-direct', '/tmp/agent.ts'), 'const agent = false')
assert.equal(carrier.workspaces[0].editorState?.openFiles[0]?.isDirty, true)
directSlice.markFileClean('ws-direct', '/tmp/agent.ts')
assert.equal(carrier.workspaces[0].editorState?.openFiles[0]?.isDirty, false)
directSlice.remapOpenFiles('ws-direct', '/tmp', '/var/tmp')
assert.equal(carrier.workspaces[0].editorState?.activeFilePath, '/var/tmp/agent.ts')
directSlice.removeOpenFilesForPath('ws-direct', '/var/tmp')
assert.deepEqual(carrier.workspaces[0].editorState?.openFiles, [])

carrier.workspaces[0].agents['live-agent'] = {
  ...defaultAgent('live-agent'),
  cliStartRequested: true,
  cliHasLaunched: true,
  cliSessionId: 'live-session',
}
carrier.workspaces[0].agents['codex-agent'] = {
  ...defaultAgent('codex-agent'),
  cli: 'codex',
  cliStartRequested: true,
  cliHasLaunched: true,
  cliSessionId: 'missing-codex',
}
carrier.workspaces[0].agents['claude-agent'] = {
  ...defaultAgent('claude-agent'),
  cli: 'claude',
  cliStartRequested: false,
  cliHasLaunched: true,
  cliSessionId: 'stable-claude',
  cliResumeAvailable: false,
}
carrier.workspaces[0].agents['claude-code-agent'] = {
  ...defaultAgent('claude-code-agent'),
  cli: 'claude-code',
  cliStartRequested: false,
  cliHasLaunched: true,
  cliSessionId: 'stable-claude-code',
  cliResumeAvailable: false,
}
carrier.workspaces[0].agents['sprintengine-agent'] = {
  ...defaultAgent('sprintengine-agent'),
  cli: 'codex',
  kind: 'sprintengine',
  cliStartRequested: true,
  cliHasLaunched: true,
  cliSessionId: 'stale-sprintengine',
  cliResumeAvailable: true,
}
directSlice.reconcileWorkspaceAgentLaunchFlags([
  terminalSession({
    sessionId: 'live-session',
    workspaceId: 'ws-direct',
    agentId: 'live-agent',
  }),
])
assert.equal(carrier.workspaces[0].agents['live-agent'].cliStartRequested, true)
assert.equal(carrier.workspaces[0].agents['live-agent'].cliSessionId, 'live-session')
assert.equal(carrier.workspaces[0].agents['codex-agent'].cliStartRequested, true)
assert.equal(carrier.workspaces[0].agents['codex-agent'].cliHasLaunched, true)
assert.equal(carrier.workspaces[0].agents['codex-agent'].cliSessionId, 'missing-codex')
assert.equal(carrier.workspaces[0].agents['codex-agent'].cliResumeAvailable, true)
assert.equal(carrier.workspaces[0].agents['claude-agent'].cliStartRequested, true)
assert.equal(carrier.workspaces[0].agents['claude-agent'].cliResumeAvailable, true)
assert.equal(carrier.workspaces[0].agents['claude-agent'].cliSessionId, 'stable-claude')
assert.equal(carrier.workspaces[0].agents['claude-code-agent'].cliStartRequested, true)
assert.equal(carrier.workspaces[0].agents['claude-code-agent'].cliResumeAvailable, true)
assert.equal(carrier.workspaces[0].agents['claude-code-agent'].cliSessionId, 'stable-claude-code')
assert.equal(carrier.workspaces[0].agents['sprintengine-agent'].cliStartRequested, false)
assert.equal(carrier.workspaces[0].agents['sprintengine-agent'].cliHasLaunched, false)
assert.equal(carrier.workspaces[0].agents['sprintengine-agent'].cliSessionId, undefined)
assert.equal(carrier.workspaces[0].agents['sprintengine-agent'].cliResumeAvailable, false)

directSlice.applyAgentTerminalSessionEvent({
  workspaceId: 'ws-direct',
  agentId: 'event-agent',
  sessionId: 'event-session',
  cli: 'codex',
})
assert.equal(carrier.workspaces[0].agents['event-agent'].cliSessionId, 'event-session')
assert.equal(carrier.workspaces[0].agents['event-agent'].cliStartRequested, true)
assert.equal(carrier.workspaces[0].agents['event-agent'].cliHasLaunched, true)
assert.equal(carrier.workspaces[0].agents['event-agent'].cliResumeAvailable, true)

directSlice.applyAgentTerminalLaunchStateEvent({
  workspaceId: 'ws-direct',
  agentId: 'event-agent',
  cliStartRequested: false,
})
assert.equal(
  carrier.workspaces[0].agents['event-agent'].cliSessionId,
  'event-session',
  'launch-state events preserve session id unless explicitly cleared',
)
assert.equal(carrier.workspaces[0].agents['event-agent'].cliStartRequested, false)

directSlice.applyAgentTerminalLaunchStateEvent({
  workspaceId: 'ws-direct',
  agentId: 'event-agent',
  cliSessionId: null,
  cliHasLaunched: false,
})
assert.equal(carrier.workspaces[0].agents['event-agent'].cliSessionId, undefined)
assert.equal(carrier.workspaces[0].agents['event-agent'].cliHasLaunched, false)

const storeWorkspaceId = useWorkspaceStore.getState().addWorkspace(standardTemplate, {
  name: 'Agents Slice Store Workspace',
})
useWorkspaceStore.getState().updateAgent(storeWorkspaceId, 'store-agent', {
  name: 'Store Agent',
  execution: { mode: 'worktree', worktreeId: ' store-wt ', cwd: '/repo/store-wt' },
  cliStartRequested: true,
  cliHasLaunched: true,
  cliSessionId: 'store-session',
})
assert.deepEqual(
  useWorkspaceStore.getState().workspaces.find((workspace) => workspace.id === storeWorkspaceId)
    ?.agents['store-agent']?.execution,
  {
    mode: 'worktree',
    worktreeId: 'store-wt',
    cwd: '/repo/store-wt',
  },
)
useWorkspaceStore.getState().reconcileWorkspaceAgentLaunchFlags([
  terminalSession({
    sessionId: 'store-session',
    workspaceId: storeWorkspaceId,
    agentId: 'store-agent',
  }),
])
assert.equal(
  useWorkspaceStore.getState().workspaces.find((workspace) => workspace.id === storeWorkspaceId)
    ?.agents['store-agent']?.cliSessionId,
  'store-session',
)

// --- conversation runtime normalization ------------------------------------

// defaultAgent is terminal.
assert.equal(defaultAgent('a').runtimeKind, 'terminal')
assert.equal(defaultAgent('a').conversation, undefined)

// A partial/blank conversation selection is rejected (no provider/model).
assert.equal(normalizeAgentConversation(undefined), undefined)
assert.equal(normalizeAgentConversation({ providerId: '  ', modelId: 'gpt-4o' }), undefined)
assert.deepEqual(
  normalizeAgentConversation({ providerId: ' openai-compatible ', modelId: ' gpt-4o ' }),
  { providerId: 'openai-compatible', modelId: 'gpt-4o' },
  'provider/model ids are trimmed',
)

// Legacy persisted agent (no runtimeKind) normalizes to terminal, never corrupt.
assert.deepEqual(
  normalizeAgentRuntime({}),
  { runtimeKind: 'terminal', conversation: undefined },
)

// A conversation kind with a valid pair is preserved.
assert.deepEqual(
  normalizeAgentRuntime({
    runtimeKind: 'conversation',
    conversation: { providerId: 'openai-compatible', modelId: 'gpt-4o' },
  }),
  { runtimeKind: 'conversation', conversation: { providerId: 'openai-compatible', modelId: 'gpt-4o' } },
)

// A conversation kind WITHOUT a valid pair falls back to terminal.
assert.deepEqual(
  normalizeAgentRuntime({ runtimeKind: 'conversation', conversation: { providerId: '', modelId: '' } }),
  { runtimeKind: 'terminal', conversation: undefined },
)

// normalizeAgentState round-trips the runtime fields and drops a stale
// conversation payload when the kind is terminal (no corruption on persist).
const conversationState = normalizeAgentState({
  ...defaultAgent('conv'),
  runtimeKind: 'conversation',
  conversation: { providerId: 'openai-compatible', modelId: 'gpt-4o' },
})
assert.equal(conversationState.runtimeKind, 'conversation')
assert.deepEqual(conversationState.conversation, { providerId: 'openai-compatible', modelId: 'gpt-4o' })

const staleState = normalizeAgentState({
  ...defaultAgent('stale'),
  runtimeKind: 'terminal',
  conversation: { providerId: 'openai-compatible', modelId: 'gpt-4o' },
})
assert.equal(staleState.runtimeKind, 'terminal')
assert.equal(staleState.conversation, undefined, 'terminal agents do not retain a conversation payload')

console.log('agentsSlice.test.ts: ok')
