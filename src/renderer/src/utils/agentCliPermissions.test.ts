import assert from 'node:assert/strict'
import type { AgentState, Workspace } from '../types/workspace'
import { resolveAgentCliPermissionPreset } from './agentCliPermissions'
import { test } from 'vitest'

test('agentCliPermissions', async () => {
  // The permission preset a launch uses is the agent's own, and only the agent's:
  // there is no workspace-level fallback to inherit from, so an agent that was
  // never given one launches on the CLI's default rather than on somebody else's
  // choice.

  const baseAgent = (id: string, overrides: Partial<AgentState> = {}): AgentState => ({
    id,
    name: id,
    status: 'idle',
    execution: { mode: 'current_workspace', worktreeId: null, cwd: null },
    messages: [],
    streamBuffer: '',
    cli: 'claude-code',
    ...overrides,
  })

  const workspace = (agent: AgentState): Workspace => ({
    id: 'workspace-1',
    name: 'Workspace',
    mode: 'standard',
    folderPath: '/repo',
    templateId: 'test',
    layoutModel: { global: {}, borders: [], layout: { type: 'row', children: [] } },
    agents: { [agent.id]: agent },
    worktreeState: { containerPath: null, entries: {}, updatedAt: null },
    memory: { relativeRoot: null },
    editorState: { openFiles: [], activeFilePath: null },
    createdAt: 1,
  })

  assert.equal(
    resolveAgentCliPermissionPreset(workspace(baseAgent('reviewer', { cliPermissionPreset: 'bypass' })), 'reviewer'),
    'bypass',
    'an agent launches on its own stored permission preset',
  )

  assert.equal(
    resolveAgentCliPermissionPreset(workspace(baseAgent('reviewer')), 'reviewer'),
    undefined,
    'an agent with no stored preset resolves to none — the launch falls back to the CLI default',
  )

  assert.equal(
    resolveAgentCliPermissionPreset(
      workspace(baseAgent('reviewer', { cliPermissionPreset: 'bypass' })),
      'someone-else',
    ),
    undefined,
    'an unknown agent id never inherits another agent’s preset',
  )

  assert.equal(
    resolveAgentCliPermissionPreset(null, 'reviewer'),
    undefined,
    'no workspace resolves to none rather than throwing',
  )

  console.log('agentCliPermissions.test.ts: ok')
})
