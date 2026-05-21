import assert from 'node:assert/strict'

import type { TerminalSessionSnapshot } from '../../../../shared/electron-api'
import type { LayoutTemplate, Workspace } from '../../types/workspace'
import { getEditorBuffer } from '../../utils/editorBuffers'
import { useWorkspaceStore } from '../workspaceStore'
import {
  createAgentsSlice,
  defaultAgent,
  defaultEditorState,
  normalizeAgentExecution,
  normalizeAgentState,
} from './agentsSlice'

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
  'claude',
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
      agents: {},
      layoutModel: standardTemplate.layout,
      editorState: defaultEditorState(),
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
assert.equal(carrier.workspaces[0].agents['sprintengine-agent'].cliStartRequested, false)
assert.equal(carrier.workspaces[0].agents['sprintengine-agent'].cliHasLaunched, false)
assert.equal(carrier.workspaces[0].agents['sprintengine-agent'].cliSessionId, undefined)
assert.equal(carrier.workspaces[0].agents['sprintengine-agent'].cliResumeAvailable, false)

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

console.log('agentsSlice.test.ts: ok')
