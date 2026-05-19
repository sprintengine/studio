import assert from 'node:assert/strict'

import type { Workspace } from '../../types/workspace'
import {
  mapMigrationWorkspaces,
  normalizeWorkspaceForPartialize,
} from './normalizers'

const baseWorkspace = (overrides: Partial<Workspace> = {}): Workspace => ({
  id: 'ws-1',
  name: 'Test',
  folderPath: '/Users/example/project',
  folderMissing: false,
  mode: 'standard',
  layoutModel: undefined as unknown as Workspace['layoutModel'],
  agents: {},
  sprintEngineState: null,
  sprintEngineContext: null,
  multiloopState: null,
  multiloopContext: null,
  sprintEngineAutoState: undefined,
  multiloopAutoState: undefined,
  guidedBriefState: null,
  sprintEngineRoleCliDefaults: undefined,
  memory: undefined,
  worktreeState: undefined,
  editorState: { openFiles: [], activeFilePath: null },
  highlight: undefined,
  lastTerminalOutputAt: undefined,
  ...overrides,
} as unknown as Workspace)

// mapMigrationWorkspaces mutates the carrier in place, mapping each workspace.
const carrier = { workspaces: [baseWorkspace({ id: 'a' }), baseWorkspace({ id: 'b' })] }
mapMigrationWorkspaces(carrier, (ws) => ({ ...ws, name: `${ws.id}-renamed` }))
assert.deepEqual(
  carrier.workspaces.map((w) => w.name),
  ['a-renamed', 'b-renamed'],
)
assert.equal(carrier.workspaces.length, 2)

// normalizeWorkspaceForPartialize strips file content while keeping the file list.
const dirty = baseWorkspace({
  editorState: {
    openFiles: [
      { path: '/a.ts', name: 'a.ts', content: 'should be stripped', isDirty: true },
      { path: '/b.ts', name: 'b.ts', content: 'also stripped', isDirty: true },
    ],
    activeFilePath: '/a.ts',
  } as unknown as Workspace['editorState'],
})
const cleaned = normalizeWorkspaceForPartialize(dirty)
const cleanedFiles = cleaned.editorState?.openFiles ?? []
assert.equal(cleanedFiles.length, 2)
for (const file of cleanedFiles) {
  assert.equal(file.isDirty, false)
  assert.equal((file as unknown as { content?: string }).content, undefined)
}
assert.equal(cleaned.editorState?.activeFilePath, '/a.ts')

// normalizeWorkspaceForPartialize zeros the in-memory stream buffer + status on agents
// that survive a save so they cold-load idle instead of streaming.
const withAgent = baseWorkspace({
  agents: {
    'agent-1': {
      id: 'agent-1',
      name: 'Specialist',
      kind: 'specialist',
      specialistId: 'architect',
      status: 'streaming',
      streamBuffer: 'partial chunk',
      cliOnboardingPromptSent: false,
      cliStartupPrompt: 'kept',
    },
  } as unknown as Workspace['agents'],
})
const withAgentCleaned = normalizeWorkspaceForPartialize(withAgent)
const persistedAgent = (withAgentCleaned.agents as Record<string, { status: string; streamBuffer: string; cliStartupPrompt?: string }>)['agent-1']
assert.equal(persistedAgent.status, 'idle')
assert.equal(persistedAgent.streamBuffer, '')
// Specialist agents that have not yet sent their onboarding prompt keep cliStartupPrompt.
assert.equal(persistedAgent.cliStartupPrompt, 'kept')

const withAgentAlreadyOnboarded = baseWorkspace({
  agents: {
    'agent-2': {
      id: 'agent-2',
      name: 'Specialist',
      kind: 'specialist',
      specialistId: 'architect',
      status: 'idle',
      streamBuffer: '',
      cliOnboardingPromptSent: true,
      cliStartupPrompt: 'should be dropped',
    },
  } as unknown as Workspace['agents'],
})
const onboardedCleaned = normalizeWorkspaceForPartialize(withAgentAlreadyOnboarded)
const onboardedAgent = (onboardedCleaned.agents as Record<string, { cliStartupPrompt?: string }>)['agent-2']
assert.equal(onboardedAgent.cliStartupPrompt, undefined)

console.log('normalizers.test.ts: ok')
