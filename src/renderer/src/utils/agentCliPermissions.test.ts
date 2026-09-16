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

const workspace = (agent: AgentState, rosterIds: string[] = []): Workspace => ({
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
  sprintEngineAutoState: {
    desiredMode: 'manual',
    runtimeState: 'idle',
    cliPermissionPreset: 'bypass',
    maxConcurrentAgents: 3,
    deliveredAgentNotificationEventKeys: [],
  },
  createdAt: 1,
  ...(rosterIds.length > 0
    ? {
        moduleState: {
          sprintengine: {
            state: {
              sprintEngineAgents: Object.fromEntries(
                rosterIds.map((id) => [id, { role: 'architect', status: 'idle', currentTaskId: null }]),
              ),
            },
          },
        },
      }
    : {}),
})

assert.equal(
  resolveAgentCliPermissionPreset(workspace(baseAgent('architect'), ['architect']), 'architect'),
  'bypass',
  'Sprint Engine roster agents use the Sprint Engine permission preset even when auto-run is off'
)

assert.equal(
  resolveAgentCliPermissionPreset(
    workspace(baseAgent('reviewer', { kind: 'specialist', cliPermissionPreset: 'bypass' })),
    'reviewer'
  ),
  'bypass',
  'specialist-kind agents keep their per-agent permission preset'
)
