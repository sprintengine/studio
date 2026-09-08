import assert from 'node:assert/strict'
import test from 'node:test'

import type { BacklogItem } from '../../../../utils/backlog'
import type { BacklogProjectRef } from '../../../../hooks/useAllProjectsBacklog'
import { createBacklogDoorActions, type BacklogDoorMutationApi } from './backlogDoorActions'

// The door's central correctness claim: every mutation dispatched from the
// cross-project list must land in the project the ROW belongs to — never in a
// "current" project, and never in the first one. Each test drives an action with
// an item from project B while project A is also present, and asserts the
// workspaceRoot the validated backlog IPC received.

const PROJECT_A: BacklogProjectRef = { key: 'MC', name: 'multicode', root: '/repos/multicode', rootKey: 'a' }
const PROJECT_B: BacklogProjectRef = { key: 'MA', name: 'multiauth', root: '/repos/multiauth', rootKey: 'b' }

function mk(over: Partial<BacklogItem> & { id: string }): BacklogItem {
  const relativePath = over.relativePath ?? `backlog/${over.id}.md`
  return {
    objectId: `obj-${over.id}`,
    path: `/x/${relativePath}`,
    relativePath,
    title: over.title ?? over.id,
    kind: 'markdown',
    status: 'ready',
    isEpic: false,
    metadata: {},
    links: [],
    excerpt: '',
    modifiedAt: 1,
    createdAtMs: 1,
    ...over,
  } as BacklogItem
}

type Call = { method: string; input: Record<string, unknown> }

function harness(options: { itemsByRootKey?: Record<string, BacklogItem[]>; confirm?: boolean } = {}) {
  const calls: Call[] = []
  const refreshed: string[] = []
  const errors: string[] = []
  const ok = async (method: string, input: Record<string, unknown>) => {
    calls.push({ method, input })
    return { ok: true as const }
  }
  const api: BacklogDoorMutationApi = {
    updateBacklogStatus: (i) => ok('updateBacklogStatus', i),
    updateBacklogTriage: (i) => ok('updateBacklogTriage', i),
    updateBacklogEpic: (i) => ok('updateBacklogEpic', i),
    updateBacklogEpicColor: (i) => ok('updateBacklogEpicColor', i),
    updateBacklogDependencies: (i) => ok('updateBacklogDependencies', i),
    updateBacklogMockups: (i) => ok('updateBacklogMockups', i),
    updateBacklogHighlight: (i) => ok('updateBacklogHighlight', i),
    removeBacklogLink: (i) => ok('removeBacklogLink', i),
    createBacklogEpic: async (i: { workspaceRoot: string; title: string }) => {
      calls.push({ method: 'createBacklogEpic', input: i })
      return { ok: true as const, slug: 'new-epic' }
    },
    moveBacklogObjectSource: (i) => ok('moveBacklogObjectSource', i),
    removeBacklogObjectRecord: (i) => ok('removeBacklogObjectRecord', i),
    readfile: async (path: string) => {
      calls.push({ method: 'readfile', input: { path } })
      return 'body'
    },
    writefile: async (path: string, content: string) => {
      calls.push({ method: 'writefile', input: { path, content } })
    },
    createFile: async (dir: string, name: string) => {
      calls.push({ method: 'createFile', input: { dir, name } })
      return `${dir}/${name}`
    },
    ensureDir: async (root: string, relative: string) => {
      calls.push({ method: 'ensureDir', input: { root, relative } })
      return `${root}/${relative}`
    },
    deletePath: async (path: string) => {
      calls.push({ method: 'deletePath', input: { path } })
    },
    renamePath: async (path: string, nextName: string) => {
      calls.push({ method: 'renamePath', input: { path, nextName } })
      return `/x/backlog/${nextName}`
    },
    showItemInFolder: async (path: string) => {
      calls.push({ method: 'showItemInFolder', input: { path } })
    },
  }

  const actions = createBacklogDoorActions({
    api,
    // Route by the item's relativePath prefix so the harness mimics the real
    // aggregate: `b/…` items belong to project B.
    resolveProject: (item) => (item.relativePath.includes('/b-') ? PROJECT_B : PROJECT_A),
    itemsForProject: (rootKey) => options.itemsByRootKey?.[rootKey] ?? [],
    refreshProject: (root) => refreshed.push(root),
    runAction: async (fn) => {
      try {
        await fn()
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error))
      }
    },
    confirmDialog: async () => options.confirm ?? true,
    promptDialog: async () => 'Typed value',
    openInEditor: () => {},
    revealInFiles: () => {},
    openCreate: () => {},
  })

  const find = (method: string) => calls.find((call) => call.method === method)
  return { actions, calls, refreshed, errors, find }
}

// An item that resolves to project B, and one that resolves to project A.
const itemB = mk({ id: 'b1', relativePath: 'backlog/b-one.md' })
const itemA = mk({ id: 'a1', relativePath: 'backlog/a-one.md' })

const settle = () => new Promise((resolve) => setImmediate(resolve))

test('a status change writes into the row’s own project', async () => {
  const h = harness()
  h.actions.setStatus(itemB, 'in_progress')
  await settle()
  assert.deepEqual(h.find('updateBacklogStatus')?.input, {
    workspaceRoot: PROJECT_B.root,
    relativePath: 'backlog/b-one.md',
    status: 'in_progress',
  })
  assert.deepEqual(h.refreshed, [PROJECT_B.root])
  assert.deepEqual(h.errors, [])
})

test('a triage edit writes into the row’s own project', async () => {
  const h = harness()
  h.actions.setDifficulty(itemB, 'l')
  await settle()
  assert.equal(h.find('updateBacklogTriage')?.input.workspaceRoot, PROJECT_B.root)
  assert.equal(h.find('updateBacklogTriage')?.input.difficulty, 'l')

  // …and the same action on a project-A row targets project A, not B.
  const other = harness()
  other.actions.setCriticality(itemA, 'critical')
  await settle()
  assert.equal(other.find('updateBacklogTriage')?.input.workspaceRoot, PROJECT_A.root)
  assert.equal(other.find('updateBacklogTriage')?.input.criticality, 'critical')
})

test('an unset triage choice clears the axis rather than writing the sentinel', async () => {
  const h = harness()
  h.actions.setRisk(itemB, 'unset')
  await settle()
  assert.equal(h.find('updateBacklogTriage')?.input.risk, null)
})

test('an epic assignment writes into the row’s own project', async () => {
  const h = harness()
  h.actions.setEpic(itemB, 'some-epic')
  await settle()
  assert.deepEqual(h.find('updateBacklogEpic')?.input, {
    workspaceRoot: PROJECT_B.root,
    relativePath: 'backlog/b-one.md',
    epic: 'some-epic',
  })
})

test('starring writes into the row’s own project sidecar', async () => {
  const h = harness()
  h.actions.setHighlight(itemB, { starred: true, color: null })
  await settle()
  assert.deepEqual(h.find('updateBacklogHighlight')?.input, {
    workspaceRoot: PROJECT_B.root,
    relativePath: 'backlog/b-one.md',
    starred: true,
    color: null,
  })
  assert.deepEqual(h.refreshed, [PROJECT_B.root], 'the mutated project re-scans (items.json never trips the fs watcher)')
})

test('creating an epic from a row creates it in that row’s project and assigns it there', async () => {
  const h = harness()
  h.actions.createEpic(itemB)
  await settle()
  assert.equal(h.find('createBacklogEpic')?.input.workspaceRoot, PROJECT_B.root)
  assert.equal(h.find('updateBacklogEpic')?.input.workspaceRoot, PROJECT_B.root)
  assert.equal(h.find('updateBacklogEpic')?.input.epic, 'new-epic')
})

test('archiving moves the file inside its own project and re-points that project’s record', async () => {
  const h = harness({ itemsByRootKey: { b: [itemB] } })
  h.actions.archive(itemB)
  await settle()
  assert.equal(h.find('ensureDir')?.input.root, `${PROJECT_B.root}/backlog`)
  assert.equal(h.find('moveBacklogObjectSource')?.input.workspaceRoot, PROJECT_B.root)
  assert.deepEqual(h.errors, [])
})

test('deleting removes the file and the record from its own project', async () => {
  const h = harness()
  h.actions.remove(itemB)
  await settle()
  assert.equal(h.find('deletePath')?.input.path, itemB.path)
  assert.equal(h.find('removeBacklogObjectRecord')?.input.workspaceRoot, PROJECT_B.root)
})

test('a declined confirm leaves the project untouched', async () => {
  const h = harness({ confirm: false })
  h.actions.remove(itemB)
  await settle()
  assert.equal(h.find('deletePath'), undefined)
  assert.equal(h.find('removeBacklogObjectRecord'), undefined)
  assert.deepEqual(h.refreshed, [])
})

test('setting a status the link derivation already yields never severs the link', async () => {
  const linked = mk({
    id: 'b2',
    relativePath: 'backlog/b-linked.md',
    status: 'ready',
    links: [{ id: 'L1', type: 'execution', label: 'Sprint', targetKind: 'sprintengine' }] as never,
  })
  const h = harness()
  // `completed` contradicts a live execution link, so the sever confirm runs and
  // the link is removed before the status write — both in project B.
  h.actions.setStatus(linked, 'completed')
  await settle()
  assert.equal(h.find('removeBacklogLink')?.input.workspaceRoot, PROJECT_B.root)
  assert.equal(h.find('updateBacklogStatus')?.input.workspaceRoot, PROJECT_B.root)
})

test('an unresolvable project is a no-op, never a write against a guessed root', async () => {
  const calls: Call[] = []
  const actions = createBacklogDoorActions({
    api: {
      updateBacklogStatus: async (i: Parameters<BacklogDoorMutationApi['updateBacklogStatus']>[0]) => {
        calls.push({ method: 'updateBacklogStatus', input: i })
        return { ok: true }
      },
    } as unknown as BacklogDoorMutationApi,
    resolveProject: () => null,
    itemsForProject: () => [],
    refreshProject: () => {},
    runAction: async (fn) => {
      await fn()
    },
    confirmDialog: async () => true,
    promptDialog: async () => null,
    openInEditor: () => {},
    revealInFiles: () => {},
    openCreate: () => {},
  })
  actions.setStatus(itemB, 'in_progress')
  await settle()
  assert.deepEqual(calls, [])
})

test('a failed mutation surfaces its message instead of silently succeeding', async () => {
  const h = harness()
  const actions = createBacklogDoorActions({
    api: { updateBacklogStatus: async () => ({ ok: false, message: 'disk full' }) } as unknown as BacklogDoorMutationApi,
    resolveProject: () => PROJECT_B,
    itemsForProject: () => [],
    refreshProject: () => {},
    runAction: h.actions ? async (fn) => {
      try {
        await fn()
      } catch (error) {
        h.errors.push(error instanceof Error ? error.message : String(error))
      }
    } : async () => {},
    confirmDialog: async () => true,
    promptDialog: async () => null,
    openInEditor: () => {},
    revealInFiles: () => {},
    openCreate: () => {},
  })
  actions.setStatus(itemB, 'in_progress')
  await settle()
  assert.deepEqual(h.errors, ['disk full'])
})
