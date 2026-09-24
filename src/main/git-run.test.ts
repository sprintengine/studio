import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import {
  GIT_NETWORK_TIMEOUT_MS,
  GIT_READ_TIMEOUT_MS,
  classifyGitCommand,
  defaultGitTimeoutMs,
  gitEnv,
  runGitCommand,
} from './git-run'

test('reads are told apart from writes, so only reads get a deadline and skip optional locks', () => {
  const reads: string[][] = [
    ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    ['diff', '--numstat', '-z', 'HEAD'],
    ['rev-parse', '--show-toplevel'],
    ['rev-list', '--count', 'a..b'],
    ['for-each-ref', '--format=%(refname)', 'refs/heads'],
    ['branch', '--format=%(refname:short)', '--sort=refname'],
    ['branch'],
    ['tag', '--list'],
    ['symbolic-ref', '--quiet', '--short', 'HEAD'],
    ['stash', 'list', '--format=%H'],
    ['worktree', 'list', '--porcelain', '-z'],
    ['remote', '-v'],
    ['remote', 'get-url', 'origin'],
    ['config', '--get', 'remote.origin.url'],
    ['-c', 'core.quotepath=off', 'ls-files', '--others'],
    ['--version'],
  ]
  for (const args of reads) assert.equal(classifyGitCommand(args), 'read', args.join(' '))

  const writes: string[][] = [
    ['commit', '-m', 'x'],
    ['merge', '--no-edit', 'main'],
    ['rebase', 'main'],
    ['push'],
    ['pull', '--no-rebase'],
    ['worktree', 'add', '-b', 'agent/x', '/tmp/x', 'HEAD'],
    ['worktree', 'remove', '/tmp/x'],
    ['branch', '-d', 'feature'],
    ['branch', 'feature', 'abc123'],
    ['tag', 'v1', 'abc123'],
    ['tag', '-a', 'v1', '-m', 'release'],
    ['symbolic-ref', 'HEAD', 'refs/heads/main'],
    ['stash', 'push', '-m', 'x'],
    ['add', '-A'],
    ['update-ref', '-d', 'refs/x'],
    ['config', 'user.name', 'dev'],
    ['some-future-subcommand'],
  ]
  for (const args of writes) assert.equal(classifyGitCommand(args), 'write', args.join(' '))

  assert.equal(classifyGitCommand(['fetch', '--prune']), 'network')
  assert.equal(classifyGitCommand(['remote', 'update']), 'network')

  assert.equal(defaultGitTimeoutMs('read'), GIT_READ_TIMEOUT_MS)
  assert.equal(defaultGitTimeoutMs('network'), GIT_NETWORK_TIMEOUT_MS)
  assert.equal(defaultGitTimeoutMs('write'), null, 'a hook-running write is never killed')
})

test('every git runs without a terminal prompt, and only reads opt out of optional locks', () => {
  const read = gitEnv(undefined, 'read')
  assert.equal(read.GIT_TERMINAL_PROMPT, '0')
  assert.equal(read.GIT_OPTIONAL_LOCKS, '0')
  assert.equal(read.LC_ALL, 'C')

  const write = gitEnv()
  assert.equal(write.GIT_TERMINAL_PROMPT, '0')
  assert.equal(write.GIT_OPTIONAL_LOCKS, undefined, 'a write takes the locks it needs')

  assert.equal(gitEnv({ GIT_DIR: undefined }, 'read').GIT_DIR, undefined, 'caller overrides still win')
})

test('a git that outlives its deadline is stopped and reported as timed out', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'git-run-'))
  try {
    // `hash-object --stdin` waits on a stdin that is never closed: a stand-in
    // for a git blocked on a network mount or a lock.
    const startedAt = Date.now()
    const result = await runGitCommand(dir, ['hash-object', '--stdin'], undefined, { timeoutMs: 300 })
    assert.equal(result.ok, false)
    assert.match(result.message ?? '', /did not finish within/)
    assert.ok(Date.now() - startedAt < 10_000, 'the deadline, not the process, ended the call')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
