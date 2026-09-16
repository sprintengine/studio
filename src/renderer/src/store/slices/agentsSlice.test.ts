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
    executionMode: input.executionMode,
    worktreeId: input.worktreeId,
    worktreePath: input.worktreePath,
    agentSession: input.agentSession,
    visible: input.visible ?? true,
    suspended: input.suspended ?? false,
    reapExempt: input.reapExempt ?? false,
    startedAt: input.startedAt ?? 1,
    lastOutputAt: input.lastOutputAt ?? null,
    lastInputAt: input.lastInputAt ?? null,
    lastVisibleAt: input.lastVisibleAt ?? null,
    activity: input.activity ?? { kind: 'idle', since: 1 },
    fileChanges: input.fileChanges ?? [],
    activeSubagents: input.activeSubagents ?? 0,
    contextUsage: input.contextUsage ?? null,
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
  // Corruption floors to `manual` since MC-2210: no flag stopped being the
  // conservative answer once Claude Code began reading it as auto mode.
  'manual',
)
assert.equal(
  normalizeAgentState({
    ...defaultAgent('agent-normalize-fallback'),
    cli: undefined,
  }, 'claude-code').cli,
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
// Reconcile is now manifest-driven: it trusts the resume flag stamped at
// session assign (agent.cliResumeAvailable), not a re-derivation from cli. A
// launched resume-capable agent carries the stamped flag, so reconcile keeps it
// start-requested (resumable) when its session is not currently live.
carrier.workspaces[0].agents['codex-agent'] = {
  ...defaultAgent('codex-agent'),
  cli: 'codex',
  cliStartRequested: true,
  cliHasLaunched: true,
  cliSessionId: 'missing-codex',
  cliResumeAvailable: true,
}
carrier.workspaces[0].agents['claude-agent'] = {
  ...defaultAgent('claude-agent'),
  cli: 'claude-code',
  cliStartRequested: false,
  cliHasLaunched: true,
  cliSessionId: 'stable-claude',
  cliResumeAvailable: true,
}
carrier.workspaces[0].agents['claude-code-agent'] = {
  ...defaultAgent('claude-code-agent'),
  cli: 'claude-code',
  cliStartRequested: false,
  cliHasLaunched: true,
  cliSessionId: 'stable-claude-code',
  cliResumeAvailable: true,
}
// A launched agent whose CLI cannot resume: no live session means the gate is
// cleared outright, because there is nothing to resume into.
carrier.workspaces[0].agents['parked-agent'] = {
  ...defaultAgent('parked-agent'),
  cli: 'codex',
  cliStartRequested: true,
  cliHasLaunched: true,
  cliSessionId: 'stale-parked',
  cliResumeAvailable: false,
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
// No live session: the launch/resume GATE is cleared (nothing auto-resumes)...
assert.equal(carrier.workspaces[0].agents['parked-agent'].cliStartRequested, false)
assert.equal(carrier.workspaces[0].agents['parked-agent'].cliHasLaunched, false)
assert.equal(carrier.workspaces[0].agents['parked-agent'].cliResumeAvailable, false)
// ...but the session IDENTITY survives. This reconcile runs at hydration
// (WorkspaceManager) and used to wipe cliSessionId here, which re-orphaned the
// painted snapshot the persist normalizers now preserve — a second, independent
// route back to the mint-fresh-uuid → spawn bug.
assert.equal(
  carrier.workspaces[0].agents['parked-agent'].cliSessionId,
  'stale-parked',
  'reconcile clears the resume gate but never the session identity',
)

// A cold-loaded automations-host agent (identity kept by
// partialize, every gate flag already false) survives the same reconcile with its
// id intact — this is the shape that reaches TerminalView on cold load, and it is
// what lets it resolve a sidecar and pause instead of spawning.
carrier.workspaces[0].agents['cold-host-agent'] = {
  ...defaultAgent('cold-host-agent'),
  cli: 'claude-code',
  cliStartRequested: false,
  cliHasLaunched: false,
  cliResumeAvailable: false,
  cliSessionId: 'cold-host-session',
  harnessSessionId: 'cold-host-harness',
}
directSlice.reconcileWorkspaceAgentLaunchFlags([])
assert.equal(
  carrier.workspaces[0].agents['cold-host-agent'].cliSessionId,
  'cold-host-session',
  'cold-loaded host agent keeps its session identity through hydration reconcile',
)
assert.equal(
  carrier.workspaces[0].agents['cold-host-agent'].harnessSessionId,
  'cold-host-harness',
  'and keeps the harness resume token',
)
assert.equal(carrier.workspaces[0].agents['cold-host-agent'].cliStartRequested, false)
assert.equal(carrier.workspaces[0].agents['cold-host-agent'].cliHasLaunched, false)
assert.equal(
  carrier.workspaces[0].agents['cold-host-agent'].cliResumeAvailable,
  false,
  'still no resume gate — identity alone must never auto-resume',
)

// The session event carries resume capabilities stamped main-side; the applier
// stores them verbatim (codex: resume yes, stable-session no) rather than
// re-deriving from cli.
directSlice.applyAgentTerminalSessionEvent({
  workspaceId: 'ws-direct',
  agentId: 'event-agent',
  sessionId: 'event-session',
  cli: 'codex',
  cliResumeAvailable: true,
  cliUsesStableSessionId: false,
})
assert.equal(carrier.workspaces[0].agents['event-agent'].cliSessionId, 'event-session')
assert.equal(carrier.workspaces[0].agents['event-agent'].cliStartRequested, true)
assert.equal(carrier.workspaces[0].agents['event-agent'].cliHasLaunched, true)
assert.equal(carrier.workspaces[0].agents['event-agent'].cliResumeAvailable, true)
assert.equal(carrier.workspaces[0].agents['event-agent'].cliUsesStableSessionId, false)

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

// Launch-state events never materialize a missing agent: a reset dispatched for
// an agent that was since removed (a workspace teardown) must not
// re-create it as a ghost record.
directSlice.applyAgentTerminalLaunchStateEvent({
  workspaceId: 'ws-direct',
  agentId: 'removed-agent',
  cliSessionId: null,
  cliStartRequested: false,
})
assert.equal(
  carrier.workspaces[0].agents['removed-agent'],
  undefined,
  'launch-state event for an unknown agent is dropped, not upserted',
)

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
