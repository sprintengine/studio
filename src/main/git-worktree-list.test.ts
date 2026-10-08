import assert from 'node:assert/strict'
import { test } from 'vitest'

import { parseGitWorktreePorcelain } from './git-worktree-list'

test('with -z, a worktree path holding a newline is read whole', () => {
  const output = [
    'worktree /Users/dev/app',
    'HEAD 1111111111111111111111111111111111111111',
    'branch refs/heads/main',
    '',
    'worktree /Users/dev/odd\nname',
    'HEAD 2222222222222222222222222222222222222222',
    'branch refs/heads/agent/odd',
    'locked held: dirty',
    '',
  ].join('\0')
  const entries = parseGitWorktreePorcelain(output)
  assert.equal(entries.length, 2)
  assert.equal(entries[1].path, '/Users/dev/odd\nname')
  assert.equal(entries[1].branch, 'agent/odd')
  assert.equal(entries[1].lockedReason, 'held: dirty')
})

test('without -z, each line is one attribute', () => {
  const output = 'worktree /Users/dev/app\r\nHEAD 1111111111111111111111111111111111111111\r\ndetached\r\nlocked\r\n'
  const [entry] = parseGitWorktreePorcelain(output)
  assert.equal(entry.path, '/Users/dev/app')
  assert.equal(entry.detached, true)
  assert.equal(entry.locked, true)
  assert.equal(entry.lockedReason, null)
})
