import assert from 'node:assert/strict'
import { listOpenProjectKnowledge, relativePathBetween, resolveProjectKnowledgeConfig } from './projectKnowledge'
import { test } from 'vitest'

test('projectKnowledge', async () => {
  function run(name: string, body: () => void): void {
    try {
      body()
      console.log(`ok - ${name}`)
    } catch (error) {
      console.error(`not ok - ${name}`)
      throw error
    }
  }

  type TestWorkspace = { folderPath: string | null; memory?: { relativeRoot: string | null } | null }

  run('relativePathBetween resolves a sibling folder', () => {
    assert.equal(relativePathBetween('/Users/x/workspace/sprintengine', '/Users/x/workspace/knowledge'), '../knowledge')
  })

  run('relativePathBetween resolves a nested folder', () => {
    assert.equal(
      relativePathBetween('/Users/x/workspace/sprintengine', '/Users/x/workspace/sprintengine/knowledge'),
      'knowledge',
    )
  })

  run('relativePathBetween returns "." for the same directory', () => {
    assert.equal(relativePathBetween('/Users/x/proj', '/Users/x/proj'), '.')
  })

  run('relativePathBetween returns null across Windows drives', () => {
    assert.equal(relativePathBetween('C:/work/proj', 'D:/shared/knowledge'), null)
  })

  run('listOpenProjectKnowledge dedupes workspaces sharing a configured project root', () => {
    const workspaces: TestWorkspace[] = [
      { folderPath: '/Users/x/workspace/sprintengine', memory: { relativeRoot: null } },
      { folderPath: '/Users/x/workspace/sprintengine', memory: { relativeRoot: null } },
    ]
    const entries = listOpenProjectKnowledge(workspaces, { '/Users/x/workspace/sprintengine': 'knowledge' })
    assert.equal(entries.length, 1)
    assert.equal(entries[0].name, 'sprintengine')
    assert.equal(entries[0].relativeRoot, 'knowledge')
    assert.equal(entries[0].workspaceCount, 2)
    assert.equal(entries[0].key, '/users/x/workspace/sprintengine')
  })

  run('listOpenProjectKnowledge collapses an inheriting worktree onto its configured ancestor', () => {
    const workspaces: TestWorkspace[] = [
      { folderPath: '/Users/x/workspace/sprintengine', memory: { relativeRoot: null } },
      { folderPath: '/Users/x/workspace/sprintengine/worktrees/run-1', memory: { relativeRoot: null } },
    ]
    const entries = listOpenProjectKnowledge(workspaces, { '/Users/x/workspace/sprintengine': 'knowledge' })
    assert.equal(entries.length, 1)
    assert.equal(entries[0].projectRoot, '/Users/x/workspace/sprintengine')
    assert.equal(entries[0].workspaceCount, 2)
  })

  run('listOpenProjectKnowledge lists an unconfigured project with a null root', () => {
    const workspaces: TestWorkspace[] = [{ folderPath: '/Users/x/workspace/sibling', memory: { relativeRoot: null } }]
    const entries = listOpenProjectKnowledge(workspaces, {})
    assert.equal(entries.length, 1)
    assert.equal(entries[0].name, 'sibling')
    assert.equal(entries[0].relativeRoot, null)
  })

  run('listOpenProjectKnowledge sorts distinct projects by name', () => {
    const workspaces: TestWorkspace[] = [
      { folderPath: '/Users/x/workspace/zeta', memory: { relativeRoot: null } },
      { folderPath: '/Users/x/workspace/alpha', memory: { relativeRoot: null } },
    ]
    const entries = listOpenProjectKnowledge(workspaces, {})
    assert.deepEqual(
      entries.map((entry) => entry.name),
      ['alpha', 'zeta'],
    )
  })

  run('listOpenProjectKnowledge skips workspaces without a folder', () => {
    const workspaces: TestWorkspace[] = [{ folderPath: null }]
    assert.equal(listOpenProjectKnowledge(workspaces, {}).length, 0)
  })

  // Guards the resolver contract the list relies on for shared-folder math.
  run('resolveProjectKnowledgeConfig prefers the deepest configured ancestor', () => {
    const config = resolveProjectKnowledgeConfig(
      '/Users/x/workspace/sprintengine/packages/app',
      {
        '/Users/x/workspace': 'shared',
        '/Users/x/workspace/sprintengine': 'knowledge',
      },
      null,
    )
    assert.equal(config?.projectRoot, '/Users/x/workspace/sprintengine')
    assert.equal(config?.relativeRoot, 'knowledge')
    assert.equal(config?.inherited, true)
  })
})
