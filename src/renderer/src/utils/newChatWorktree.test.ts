import assert from 'node:assert/strict'
import { afterEach, test, vi } from 'vitest'

import type { GitWorktreeCreateInput } from '../../../shared/electron-api'

const diagnostics: Array<{ title: string; message: string }> = []
vi.mock('./diagnostics', () => ({
  publishDiagnosticSync: (input: { title: string; message: string }) => {
    diagnostics.push(input)
  },
}))

const { createNewChatWorktree } = await import('./newChatWorktree')

const originalWindow = (globalThis as { window?: unknown }).window

function stubApi(api: Record<string, unknown>) {
  ;(globalThis as { window?: unknown }).window = { api }
}

afterEach(() => {
  ;(globalThis as { window?: unknown }).window = originalWindow
  diagnostics.length = 0
})

test('a worktree made from the pool answers its folder and a marker naming the project', async () => {
  const creates: GitWorktreeCreateInput[] = []
  stubApi({
    getGitRepoRoot: async () => '/Users/dev/app',
    createGitWorktree: async (input: GitWorktreeCreateInput) => {
      creates.push(input)
      return { ok: true, data: { path: input.destinationPath, branch: input.branchName, baseRef: 'main' } }
    },
  })
  const made = await createNewChatWorktree('/Users/dev/app', 'fix-login', 'wsl:Ubuntu')
  assert.equal(made.ok, true)
  if (!made.ok) return
  assert.equal(made.worktree.repoRoot, '/Users/dev/app')
  assert.equal(made.worktree.baseRef, 'main')
  assert.equal(made.folderPath, creates[0]?.destinationPath)
  assert.equal(creates[0]?.fromPool, true)
  assert.equal(creates[0]?.hostId, 'wsl:Ubuntu', 'the machine the chat runs on makes its worktree')
  assert.deepEqual(diagnostics, [])
})

test('a refused worktree says why and answers the same words', async () => {
  stubApi({
    getGitRepoRoot: async () => '/Users/dev/app',
    createGitWorktree: async () => ({ ok: false, message: 'branch already exists' }),
  })
  const made = await createNewChatWorktree('/Users/dev/app', 'taken', null)
  assert.deepEqual(made, { ok: false, message: 'branch already exists' })
  assert.deepEqual(
    diagnostics.map((entry) => entry.title),
    ['Worktree failed'],
  )
})

test('an IPC call that throws is a failure with a diagnostic, never a rejection', async () => {
  stubApi({
    getGitRepoRoot: async () => '/Users/dev/app',
    createGitWorktree: async () => {
      throw new Error('fetch timed out')
    },
  })
  const made = await createNewChatWorktree('/Users/dev/app', '', null)
  assert.deepEqual(made, { ok: false, message: 'fetch timed out' })
  assert.deepEqual(diagnostics, [
    { level: 'error', source: 'workspace', title: 'Worktree failed', message: 'fetch timed out' },
  ])

  stubApi({
    getGitRepoRoot: async () => {
      throw new Error('git not found')
    },
  })
  const unread = await createNewChatWorktree('/Users/dev/app', '', null)
  assert.deepEqual(unread, { ok: false, message: 'git not found' })
})

test('no project and no repository are refused before anything is made', async () => {
  let created = false
  stubApi({
    getGitRepoRoot: async () => null,
    createGitWorktree: async () => {
      created = true
      return { ok: false, message: 'unreachable' }
    },
  })
  assert.equal((await createNewChatWorktree(null, '', null)).ok, false)
  assert.equal((await createNewChatWorktree('/Users/dev/notes', '', null)).ok, false)
  assert.equal(created, false)
  assert.deepEqual(
    diagnostics.map((entry) => entry.title),
    ['Worktree needs a project', 'Worktree needs a git repository'],
  )
})
