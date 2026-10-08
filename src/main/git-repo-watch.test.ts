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
import { classifyGitDirEntry, createGitRepoWatch, readCheckoutState, resolveGitDirs } from './git-repo-watch'

type FakeDirWatch = { dir: string; recursive: boolean; fire: (filename: string | null) => void; closed: boolean }

function harness(options: { missing?: Set<string> } = {}) {
  const missing = options.missing ?? new Set<string>()
  // What the fallback reads per checkout; a path left out reads as unreadable.
  const readings = new Map<string, string | null>()
  const reads: string[] = []
  const dirs: FakeDirWatch[] = []
  const emitted: GitCheckoutChange[][] = []
  const timers: Array<{ callback: () => void; cleared: boolean }> = []
  const repeating: Array<() => void> = []
  const watch = createGitRepoWatch({
    emit: (changes) => emitted.push(changes),
    readCheckout: async (checkoutPath) => {
      reads.push(checkoutPath)
      return readings.get(checkoutPath) ?? null
    },
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
      if (missing.has(dir)) throw Object.assign(new Error(`ENOENT: ${dir}`), { code: 'ENOENT' })
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
  /** One fallback tick, run to the end. */
  const tickFallback = async (): Promise<void> => {
    repeating.forEach((tick) => tick())
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  return { watch, dirs, emitted, flush, dir, repeating, missing, readings, reads, tickFallback }
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
    '/Users/dev/app/.git/reftable',
    '/Users/dev/app/.git/worktrees',
    '/Users/dev/app/.git/worktrees/wt-a',
    '/Users/dev/app/.git/worktrees/wt-a/reftable',
  ])
  watch.release('/Users/dev/wt-a')
  assert.equal(dirs.find((record) => record.dir.endsWith('worktrees/wt-a'))?.closed, true)
  watch.release('/Users/dev/app')
  assert.equal(watch.watchedDirCount(), 4, 'still retained once')
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

test('a reftable repository reports its refs through reftable/', async () => {
  const { watch, emitted, flush, dir } = harness()
  await watch.retain('/Users/dev/app')
  await watch.retain('/Users/dev/wt-a')
  dir('/Users/dev/app/.git/reftable').fire('tables.list')
  flush()
  assert.deepEqual(emitted[0].map((change) => [change.checkoutKey, change.kinds.join('+')]).sort(), [
    ['/Users/dev/app', 'refs'],
    ['/Users/dev/wt-a', 'refs'],
  ])
  // A linked checkout's own table (its HEAD) is that checkout's alone.
  dir('/Users/dev/app/.git/worktrees/wt-a/reftable').fire('tables.list')
  flush()
  assert.deepEqual(emitted[1], [{ checkoutKey: '/Users/dev/wt-a', kinds: ['refs', 'worktree'], reason: 'gitdir' }])
  assert.deepEqual(classifyGitDirEntry('reftable', true), ['refs'])
})

test('a worktrees/ folder that appears after the checkout was watched is watched then', async () => {
  const { watch, emitted, flush, dir, dirs, missing } = harness({ missing: new Set(['/Users/dev/app/.git/worktrees']) })
  await watch.retain('/Users/dev/app')
  assert.equal(
    dirs.some((record) => record.dir === '/Users/dev/app/.git/worktrees'),
    false,
    'nothing to watch yet',
  )
  missing.clear()
  // The first `worktree add` creates it; the common dir reports the new entry.
  dir('/Users/dev/app/.git').fire('worktrees')
  flush()
  assert.deepEqual(emitted[0], [{ checkoutKey: '/Users/dev/app', kinds: ['refs'], reason: 'gitdir' }])
  dir('/Users/dev/app/.git/worktrees').fire('wt-b')
  flush()
  assert.deepEqual(emitted[1], [{ checkoutKey: '/Users/dev/app', kinds: ['refs'], reason: 'gitdir' }])

  // Pruned away and back again: the stale watch is replaced, not stacked.
  dir('/Users/dev/app/.git').fire('worktrees')
  assert.equal(dirs.filter((record) => record.dir === '/Users/dev/app/.git/worktrees' && !record.closed).length, 1)
  watch.release('/Users/dev/app')
  assert.equal(watch.watchedDirCount(), 0)
  assert.ok(dirs.every((record) => record.closed))
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
  const { watch, emitted, flush, repeating, tickFallback } = harness()
  await watch.retain('/Users/dev/not-a-repo')
  await watch.retain('/Users/dev/app')
  assert.equal(repeating.length, 1, 'one fallback timer for everything')
  await tickFallback()
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

test('the fallback reads each checkout once and marks only the ones whose reading moved', async () => {
  const { watch, emitted, flush, readings, reads, tickFallback } = harness()
  readings.set('/Users/dev/app', 'main clean')
  readings.set('/Users/dev/app/wt-a', 'wt-a clean')
  await watch.retain('/Users/dev/app')
  await watch.retain('/Users/dev/app/wt-a')
  const marked = (): string[] => (emitted.at(-1) ?? []).map((change) => change.checkoutKey).sort()

  await tickFallback()
  flush()
  assert.deepEqual(marked(), ['/Users/dev/app', '/Users/dev/app/wt-a'], 'a first reading has nothing to match')
  assert.deepEqual(reads.sort(), ['/Users/dev/app', '/Users/dev/app/wt-a'], 'one reading per checkout')

  const batches = emitted.length
  await tickFallback()
  flush()
  assert.equal(emitted.length, batches, 'nothing moved, so no view goes back to git')

  readings.set('/Users/dev/app/wt-a', 'wt-a edited')
  await tickFallback()
  flush()
  assert.deepEqual(emitted.at(-1), [
    { checkoutKey: '/Users/dev/app/wt-a', kinds: ['refs', 'worktree'], reason: 'fallback' },
  ])

  readings.set('/Users/dev/app', null)
  await tickFallback()
  flush()
  assert.deepEqual(marked(), ['/Users/dev/app'], 'a reading that failed counts as moved')
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

/** A real repository, watched for real, and a way to wait for what it reports. */
async function realRepo(initArgs: string[] = []) {
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
  const repo = join(scratch, 'repo')
  const git = (...args: string[]) => execFileAsync('git', ['-C', repo, ...args], { env })
  await mkdir(repo, { recursive: true })
  const changes: GitCheckoutChange[] = []
  const watch = createGitRepoWatch({ emit: (batch) => changes.push(...batch), debounceMs: 50 })
  const cleanup = async (): Promise<void> => {
    watch.dispose()
    await rm(scratch, { recursive: true, force: true })
  }
  try {
    await git('init', '-q', '-b', 'main', ...initArgs)
  } catch {
    await cleanup()
    return null
  }
  await writeFile(join(repo, 'a.txt'), 'a\n')
  await git('add', 'a.txt')
  await git('commit', '-q', '-m', 'first')
  const refsReported = async (): Promise<boolean> => {
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      if (changes.some((change) => change.kinds.includes('refs'))) return true
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    return false
  }
  const settle = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 300))
    changes.length = 0
  }
  return { scratch, repo, git, watch, refsReported, settle, cleanup }
}

test('a branch created in a reftable repository is reported', async () => {
  const real = await realRepo(['--ref-format=reftable'])
  // A git without the reftable backend (before 2.45) has nothing to watch.
  if (!real) return
  try {
    await real.watch.retain(real.repo)
    await real.settle()
    await real.git('branch', 'feature')
    assert.ok(await real.refsReported(), 'the new branch reached the views')
  } finally {
    await real.cleanup()
  }
})

test('worktrees added and removed after the first are still reported', async () => {
  const real = await realRepo()
  assert.ok(real)
  try {
    // No linked worktree yet, so no `worktrees/` to watch.
    await real.watch.retain(real.repo)
    await real.settle()
    await real.git('worktree', 'add', '-q', '--detach', join(real.scratch, 'wt-1'))
    assert.ok(await real.refsReported(), 'the first add')
    await real.settle()
    await real.git('worktree', 'add', '-q', '--detach', join(real.scratch, 'wt-2'))
    await real.settle()
    await real.git('worktree', 'remove', join(real.scratch, 'wt-2'))
    assert.ok(await real.refsReported(), 'a removal once worktrees/ exists')
  } finally {
    await real.cleanup()
  }
})

test('a checkout reading moves with a working-tree edit and a commit, and holds still otherwise', async () => {
  const real = await realRepo()
  assert.ok(real)
  try {
    const first = await readCheckoutState(real.repo)
    assert.ok(first)
    assert.equal(await readCheckoutState(real.repo), first, 'nothing moved, the same reading')

    await writeFile(join(real.repo, 'a.txt'), 'edited\n')
    const edited = await readCheckoutState(real.repo)
    assert.notEqual(edited, first, 'an edit no watcher saw')

    await real.git('commit', '-q', '-am', 'second')
    const committed = await readCheckoutState(real.repo)
    assert.notEqual(committed, edited, 'a commit moves HEAD')
    assert.notEqual(committed, first)
  } finally {
    await real.cleanup()
  }
})
