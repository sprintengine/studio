import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'
import type { FSWatcher } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { test } from 'vitest'

import type { GitCheckoutChange } from '../shared/ipc/git'
import { classifyGitDirEntry, createGitRepoWatch, resolveGitDirs } from './git-repo-watch'

type FakeDirWatch = { dir: string; recursive: boolean; fire: (filename: string | null) => void; closed: boolean }

function harness() {
  const dirs: FakeDirWatch[] = []
  const emitted: GitCheckoutChange[][] = []
  const timers: Array<{ callback: () => void; cleared: boolean }> = []
  const repeating: Array<() => void> = []
  const watch = createGitRepoWatch({
    emit: (changes) => emitted.push(changes),
    resolveDirs: async (checkoutPath) => {
      if (checkoutPath.includes('not-a-repo')) return null
      if (checkoutPath.endsWith('wt-a')) {
        return {
          toplevel: checkoutPath,
          gitDir: '/Users/dev/app/.git/worktrees/wt-a',
          commonDir: '/Users/dev/app/.git',
        }
      }
      return { toplevel: checkoutPath, gitDir: '/Users/dev/app/.git', commonDir: '/Users/dev/app/.git' }
    },
    watch: (dir, options, listener) => {
      const record: FakeDirWatch = {
        dir,
        recursive: options.recursive,
        fire: (name) => listener('change', name),
        closed: false,
      }
      dirs.push(record)
      const emitter = new EventEmitter() as unknown as FSWatcher
      ;(emitter as unknown as { close: () => void }).close = () => {
        record.closed = true
      }
      return emitter
    },
    setTimer: (callback) => {
      const timer = { callback, cleared: false }
      timers.push(timer)
      return timer
    },
    clearTimer: (timer) => {
      ;(timer as { cleared: boolean }).cleared = true
    },
    setRepeating: (callback) => {
      repeating.push(callback)
      return callback
    },
    clearRepeating: () => {
      repeating.length = 0
    },
  })
  const flush = (): void => {
    for (const timer of timers.splice(0)) if (!timer.cleared) timer.callback()
  }
  const dir = (path: string): FakeDirWatch => {
    const found = dirs.find((record) => record.dir === path && !record.closed)
    assert.ok(found, `watching ${path}`)
    return found
  }
  return { watch, dirs, emitted, flush, dir, repeating }
}

test('what a change in a git directory means', () => {
  assert.deepEqual(classifyGitDirEntry('index', false), ['worktree'])
  assert.deepEqual(classifyGitDirEntry('index.lock', false), ['worktree'])
  assert.deepEqual(classifyGitDirEntry('HEAD', false), ['worktree', 'refs'])
  assert.deepEqual(classifyGitDirEntry('MERGE_HEAD', false), ['worktree'])
  assert.deepEqual(classifyGitDirEntry('packed-refs', true), ['refs'])
  assert.equal(classifyGitDirEntry('packed-refs', false), null, 'only the common dir has one')
  assert.equal(classifyGitDirEntry('FETCH_HEAD', true), null, 'a fetch that moved a ref is seen under refs/')
  assert.equal(classifyGitDirEntry('COMMIT_EDITMSG', false), null)
  assert.equal(classifyGitDirEntry('ORIG_HEAD', false), null)
  assert.deepEqual(classifyGitDirEntry(null, false), ['worktree', 'refs'], 'no filename: assume the worst')
})

test('checkouts of one repository share the watchers on its common dir', async () => {
  const { watch, dirs } = harness()
  await watch.retain('/Users/dev/app')
  await watch.retain('/Users/dev/app/')
  await watch.retain('/Users/dev/wt-a')
  const open = dirs.filter((record) => !record.closed).map((record) => `${record.dir}${record.recursive ? ' (r)' : ''}`)
  assert.deepEqual(open.sort(), [
    '/Users/dev/app/.git',
    '/Users/dev/app/.git/refs (r)',
    '/Users/dev/app/.git/worktrees',
    '/Users/dev/app/.git/worktrees/wt-a',
  ])
  watch.release('/Users/dev/wt-a')
  assert.equal(dirs.find((record) => record.dir.endsWith('worktrees/wt-a'))?.closed, true)
  watch.release('/Users/dev/app')
  assert.equal(watch.watchedDirCount(), 3, 'still retained once')
  watch.release('/Users/dev/app')
  assert.equal(watch.watchedDirCount(), 0, 'the last release closes everything')
})

test('a ref moving reaches every checkout of the repository; an index change only its own', async () => {
  const { watch, emitted, flush, dir } = harness()
  await watch.retain('/Users/dev/app')
  await watch.retain('/Users/dev/wt-a')

  dir('/Users/dev/app/.git/refs').fire('heads/agent/x')
  dir('/Users/dev/app/.git/refs').fire('heads/agent/x.lock')
  flush()
  assert.equal(emitted.length, 1, 'a burst is one delivery')
  assert.deepEqual(emitted[0].map((change) => [change.checkoutKey, change.kinds.join('+')]).sort(), [
    ['/Users/dev/app', 'refs'],
    ['/Users/dev/wt-a', 'refs'],
  ])

  dir('/Users/dev/app/.git/worktrees/wt-a').fire('index')
  flush()
  assert.deepEqual(emitted[1], [{ checkoutKey: '/Users/dev/wt-a', kinds: ['worktree'], reason: 'gitdir' }])

  dir('/Users/dev/app/.git').fire('index')
  flush()
  assert.deepEqual(emitted[2], [{ checkoutKey: '/Users/dev/app', kinds: ['worktree'], reason: 'gitdir' }])

  dir('/Users/dev/app/.git').fire('packed-refs')
  flush()
  assert.equal(emitted[3].length, 2, 'packed-refs is repository-wide')

  dir('/Users/dev/app/.git').fire('FETCH_HEAD')
  dir('/Users/dev/app/.git').fire('logs')
  flush()
  assert.equal(emitted.length, 4, 'noise delivers nothing')
})

test('nothing is delivered while no window is focused, and it all arrives on focus', async () => {
  const { watch, emitted, flush, dir, repeating } = harness()
  await watch.retain('/Users/dev/app')
  watch.setFocused(false)
  dir('/Users/dev/app/.git').fire('HEAD')
  dir('/Users/dev/app/.git/refs').fire('heads/main')
  repeating.forEach((tick) => tick())
  flush()
  assert.equal(emitted.length, 0, 'held while unfocused, and the fallback does not tick')

  watch.setFocused(true)
  flush()
  assert.deepEqual(emitted[0], [{ checkoutKey: '/Users/dev/app', kinds: ['refs', 'worktree'], reason: 'gitdir' }])
})

test('the slow fallback and agent activity reach checkouts no watcher can see into', async () => {
  const { watch, emitted, flush, repeating } = harness()
  await watch.retain('/Users/dev/not-a-repo')
  await watch.retain('/Users/dev/app')
  assert.equal(repeating.length, 1, 'one fallback timer for everything')
  repeating[0]()
  flush()
  assert.deepEqual(emitted[0].map((change) => [change.checkoutKey, change.reason]).sort(), [
    ['/Users/dev/app', 'fallback'],
    ['/Users/dev/not-a-repo', 'fallback'],
  ])

  watch.noteActivity('/Users/dev/app/')
  watch.noteActivity('/Users/dev/unwatched')
  flush()
  assert.deepEqual(emitted[1], [{ checkoutKey: '/Users/dev/app', kinds: ['worktree'], reason: 'activity' }])
})

test('a real commit is reported through the real watchers', async () => {
  const execFileAsync = promisify(execFile)
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'sprintengine-repo-watch-')))
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'test',
    GIT_AUTHOR_EMAIL: 'dev@example.com',
    GIT_COMMITTER_NAME: 'test',
    GIT_COMMITTER_EMAIL: 'dev@example.com',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
  }
  const git = (...args: string[]) => execFileAsync('git', ['-C', repo, ...args], { env })
  const repo = join(scratch, 'repo')
  const changes: GitCheckoutChange[] = []
  const watch = createGitRepoWatch({ emit: (batch) => changes.push(...batch), debounceMs: 50 })
  try {
    await mkdir(repo, { recursive: true })
    await git('init', '-q', '-b', 'main')
    await writeFile(join(repo, 'a.txt'), 'a\n')
    await git('add', 'a.txt')
    await git('commit', '-q', '-m', 'first')

    const dirs = await resolveGitDirs(repo)
    assert.equal(dirs?.gitDir, join(repo, '.git'))
    assert.equal(dirs?.commonDir, join(repo, '.git'))

    await watch.retain(repo)
    await writeFile(join(repo, 'b.txt'), 'b\n')
    await git('add', 'b.txt')
    await git('commit', '-q', '-m', 'second')

    const deadline = Date.now() + 10_000
    while (Date.now() < deadline && !changes.some((change) => change.kinds.includes('refs'))) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const kinds = new Set(changes.flatMap((change) => change.kinds))
    assert.ok(kinds.has('refs'), 'the branch moved')
    assert.ok(kinds.has('worktree'), 'the index moved')
  } finally {
    watch.dispose()
    await rm(scratch, { recursive: true, force: true })
  }
})
