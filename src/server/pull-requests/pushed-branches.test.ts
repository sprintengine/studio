import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, test } from 'vitest'

import { defaultReadPushedBranches } from './pull-request-domain'

// The branches a turn pushed and did not stay on, read from a real clone: the
// one case a lookup of the checkout's own branch cannot see, because the
// agent went back to `main`, which is never looked up.

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_DIR: undefined,
      GIT_WORK_TREE: undefined,
      GIT_AUTHOR_NAME: 'dev',
      GIT_AUTHOR_EMAIL: 'dev@example.com',
      GIT_COMMITTER_NAME: 'dev',
      GIT_COMMITTER_EMAIL: 'dev@example.com',
      ...env,
    },
  })
}

function commit(repo: string, message: string, env: NodeJS.ProcessEnv = {}): void {
  git(repo, ['commit', '--allow-empty', '-q', '-m', message], env)
}

function cloneWithRemote(): { root: string; repo: string } {
  const root = mkdtempSync(join(tmpdir(), 'sprintengine-pushed-branches-'))
  roots.push(root)
  git(root, ['init', '-q', '--bare', '--initial-branch=main', 'remote.git'])
  git(root, ['clone', '-q', 'remote.git', 'repo'])
  const repo = join(root, 'repo')
  git(repo, ['switch', '-q', '-c', 'main'])
  commit(repo, 'base', { GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z', GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z' })
  git(repo, ['push', '-q', 'origin', 'main'])
  return { root, repo }
}

test('a branch pushed and left, and a push of HEAD under a new name, are found', async () => {
  const { repo } = cloneWithRemote()
  const turnStart = Date.now() - 5_000

  // Branched, committed, pushed, opened, and went back to main.
  git(repo, ['switch', '-q', '-c', 'fix/login'])
  commit(repo, 'fix')
  git(repo, ['push', '-q', '-u', 'origin', 'fix/login'])
  git(repo, ['switch', '-q', 'main'])
  // Committed on main and pushed it under a branch name it never made.
  commit(repo, 'on main')
  git(repo, ['push', '-q', 'origin', 'HEAD:refs/heads/quick-fix'])

  const pushed = await defaultReadPushedBranches(repo, turnStart)
  assert.deepEqual([...pushed].sort(), ['fix/login', 'quick-fix'])
})

test("an older push, another worktree's branch, and a fetched branch are not this turn's", async () => {
  const { root, repo } = cloneWithRemote()
  const old = { GIT_COMMITTER_DATE: '2026-02-01T00:00:00Z', GIT_AUTHOR_DATE: '2026-02-01T00:00:00Z' }
  git(repo, ['switch', '-q', '-c', 'last-week'])
  commit(repo, 'old work', old)
  git(repo, ['push', '-q', 'origin', 'last-week'])
  git(repo, ['switch', '-q', 'main'])
  const turnStart = Date.now() - 5_000

  // Another agent, in its own worktree, pushed the branch it works on.
  git(repo, ['worktree', 'add', '-q', '-b', 'agent/other', join(root, 'wt')])
  commit(join(root, 'wt'), 'other agent')
  git(join(root, 'wt'), ['push', '-q', 'origin', 'agent/other'])

  // Someone else pushed a branch, and this clone fetched it.
  git(root, ['clone', '-q', 'remote.git', 'colleague'])
  const colleague = join(root, 'colleague')
  git(colleague, ['switch', '-q', '-c', 'their-branch'])
  commit(colleague, 'theirs')
  git(colleague, ['push', '-q', 'origin', 'their-branch'])
  git(repo, ['fetch', '-q', 'origin'])

  assert.deepEqual(await defaultReadPushedBranches(repo, turnStart), [])
})

test('a folder git cannot answer for reads as nothing pushed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sprintengine-pushed-branches-'))
  roots.push(root)
  assert.deepEqual(await defaultReadPushedBranches(root, 0), [])
})
