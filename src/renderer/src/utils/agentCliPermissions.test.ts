import assert from 'node:assert/strict'
import type { AgentState, Workspace } from '../types/workspace'
import { resolveAgentCliPermissionPreset } from './agentCliPermissions'

const baseAgent = (id: string, overrides: Partial<AgentState> = {}): AgentState => ({
  id,
  name: id,
  status: 'idle',
  execution: { mode: 'current_workspace', worktreeId: null, cwd: null },
  messages: [],
  streamBuffer: '',
  cli: 'claude-code',
  kind: 'general',
  ...overrides,
})

const workspace = (agent: AgentState): Workspace => ({
  id: 'workspace-1',
  name: 'Workspace',
  mode: 'sprintengine',
  folderPath: '/repo',
  templateId: 'test',
  layoutModel: { global: {}, borders: [], layout: { type: 'row', children: [] } },
  agents: { [agent.id]: agent },
  worktreeState: { containerPath: null, entries: {}, updatedAt: null },
  memory: { relativeRoot: null },
  editorState: { openFiles: [], activeFilePath: null },
  sprintEngineState: null,
  sprintEngineAutoState: {
    desiredMode: 'manual',
    runtimeState: 'idle',
    cliPermissionPreset: 'bypass_all',
    maxConcurrentAgents: 3,
    deliveredAgentNotificationEventKeys: [],
  },
  createdAt: 1,
})

assert.equal(
  resolveAgentCliPermissionPreset(workspace(baseAgent('architect', { kind: 'sprintengine' })), 'architect'),
  'bypass_all',
  'Sprint Engine agents use the Sprint Engine permission preset even when auto-run is off'
)

assert.equal(
  resolveAgentCliPermissionPreset(
    workspace(baseAgent('reviewer', { kind: 'watchtower', cliPermissionPreset: 'bypass_all' })),
    'reviewer'
  ),
  'bypass_all',
  'Watchtower and specialist agents keep their per-agent permission preset'
)
