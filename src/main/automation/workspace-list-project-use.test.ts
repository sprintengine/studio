import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { Workspace } from '../../renderer/src/types/workspace'
import { PROJECT_USE_HALF_LIFE_MS, withProjectUse, type ProjectUsageMap } from '../../shared/project-frecency'
import type { WorkspaceSyncSnapshot } from '../../shared/workspace-sync'
import { createAutomationTools, type AutomationBackends } from './automation-tools'

// `workspace.list` tells a paired phone how much each workspace's project is
// used, so the phone's New lists its projects in the order New chat here does.
// The fields are additive: a desktop with no usage to give lists as before.

const NOW = Date.UTC(2026, 9, 6, 12)

function workspace(id: string, overrides: Partial<Workspace> = {}): Workspace {
  return {
    id,
    name: `Chat ${id}`,
    mode: 'standard',
    folderPath: null,
    templateId: 'solo',
    layoutModel: { global: {}, borders: [], layout: { type: 'row', children: [] } },
    agents: {},
    worktreeState: { containerPath: null, entries: {}, updatedAt: null },
    memory: { relativeRoot: null },
    editorState: { openFiles: [], activeFilePath: null },
    createdAt: 1,
    ...overrides,
  }
}

const WORKSPACES = [
  workspace('ws-app', { folderPath: '/Users/dev/app' }),
  workspace('ws-wt', {
    folderPath: '/Users/dev/.sprintengine-worktrees/app/login-fix',
    worktree: { branch: 'agent/login-fix', repoRoot: '/Users/dev/app' },
  }),
  workspace('ws-notes', { folderPath: '/Users/dev/notes' }),
  workspace('ws-none'),
]

function snapshot(): WorkspaceSyncSnapshot {
  return {
    sequence: 1,
    state: {
      workspaces: WORKSPACES,
      activeWorkspaceId: 'ws-app',
      primaryWorkspaceWindowId: 'primary',
      workspaceWindows: [],
    },
  }
}

async function list(usage?: ProjectUsageMap): Promise<Array<Record<string, unknown>>> {
  // Only what `workspace.list` reads; every other tool is left unbuilt.
  const backends = {
    getWorkspaceSyncSnapshot: snapshot,
    readRepositoryIdentity: async () => null,
    now: () => NOW,
    ...(usage ? { projectUsage: () => usage } : {}),
  } as unknown as AutomationBackends
  const tool = createAutomationTools(backends).find((candidate) => candidate.name === 'workspace.list')
  assert.ok(tool, 'workspace.list is served')
  const result = await tool.handler({}, {} as never)
  assert.equal(result.isError, undefined)
  return (result.structuredContent as { workspaces: Array<Record<string, unknown>> }).workspaces
}

test('each row carries its project’s score and latest use, scored at the moment of the listing', async () => {
  let usage: ProjectUsageMap = {}
  usage = withProjectUse(usage, '/Users/dev/app', NOW - PROJECT_USE_HALF_LIFE_MS)
  usage = withProjectUse(usage, '/Users/dev/app', NOW)
  const rows = await list(usage)
  const byId = new Map(rows.map((row) => [row.id, row]))
  assert.equal(byId.get('ws-app')?.projectFrecency, 1.5, 'a use today and one a week ago')
  assert.equal(byId.get('ws-app')?.projectLastUsedAt, new Date(NOW).toISOString())
  // A worktree chat's folder is its own entry in the phone's list, used or not on its own.
  assert.equal(byId.get('ws-wt')?.projectFrecency, 0)
  assert.equal(byId.get('ws-notes')?.projectFrecency, 0, 'never used is 0, so the phone knows the field is served')
  assert.equal(byId.get('ws-notes')?.projectLastUsedAt, null)
  assert.equal(byId.get('ws-none')?.projectFrecency, 0, 'a chat with no folder is no project and never used')
})

test('a desktop with no usage to give lists the rows without the fields', async () => {
  const rows = await list()
  assert.equal(rows.length, WORKSPACES.length)
  for (const row of rows) {
    assert.equal('projectFrecency' in row, false)
    assert.equal('projectLastUsedAt' in row, false)
  }
})
