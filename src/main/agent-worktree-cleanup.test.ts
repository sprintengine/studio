import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, test } from 'vitest'

import { cleanupAgentWorktrees } from './agent-worktree-cleanup'
import { runGitCommand } from './git-run'

const execFileAsync = promisify(execFile)
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'dev@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'dev@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], { encoding: 'utf8', env })
  return stdout.trim()
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  )
}

let scratch = ''
let repo = ''
let container = ''

async function addWorktree(slug: string, branch = `agent/${slug}`): Promise<string> {
  const path = join(container, slug)
  await git(repo, 'worktree', 'add', '-q', '-b', branch, path, 'origin/main')
  return path
}

beforeAll(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'sprintengine-worktree-cleanup-')))
  const origin = join(scratch, 'origin.git')
  const seed = join(scratch, 'seed')
  await mkdir(seed, { recursive: true })
  await git(seed, 'init', '-q', '-b', 'main')
  await writeFile(join(seed, 'README.md'), '# app\n')
  await git(seed, 'add', '.')
  await git(seed, 'commit', '-q', '-m', 'init')
  await git(scratch, 'clone', '-q', '--bare', seed, origin)
  repo = join(scratch, 'app')
  await git(scratch, 'clone', '-q', origin, repo)
  container = join(scratch, '.sprintengine-worktrees', 'app')
  await mkdir(container, { recursive: true })
})

afterAll(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true })
})

test('only clean agent worktrees whose work is on the default branch are removed', async () => {
  // Merged: its one commit was pushed to origin/main and fetched.
  const merged = await addWorktree('merged')
  await writeFile(join(merged, 'feature.txt'), 'done\n')
  await git(merged, 'add', '.')
  await git(merged, 'commit', '-q', '-m', 'feature')
  await git(merged, 'push', '-q', 'origin', 'HEAD:main')
  await git(repo, 'fetch', '-q')

  // Never committed to, with dependencies installed (ignored files do not
  // make a worktree dirty, and go with it).
  const untouched = await addWorktree('untouched')
  await writeFile(join(repo, '.git', 'info', 'exclude'), 'node_modules/\n')
  await mkdir(join(untouched, 'node_modules', 'left-pad'), { recursive: true })
  await writeFile(join(untouched, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1\n')

  // Unmerged: a commit origin/main does not have.
  const unmerged = await addWorktree('unmerged')
  await writeFile(join(unmerged, 'wip.txt'), 'wip\n')
  await git(unmerged, 'add', '.')
  await git(unmerged, 'commit', '-q', '-m', 'wip')

  // Dirty: an untracked file, no commits.
  const dirty = await addWorktree('dirty')
  await writeFile(join(dirty, 'notes.md'), 'not committed\n')

  // In use: a workspace still points into it.
  const inUse = await addWorktree('in-use')

  // A live terminal sits in a subdirectory of this one.
  const live = await addWorktree('live')
  await mkdir(join(live, 'src'), { recursive: true })

  // Locked on purpose.
  const locked = await addWorktree('locked')
  await git(repo, 'worktree', 'lock', '--reason', 'kept for review', locked)

  // Not an agent worktree: made by hand in the Worktree manager.
  const manual = await addWorktree('manual', 'sprintengine/manual')

  const logs: string[] = []
  const dry = await cleanupAgentWorktrees(
    { repoRoot: repo, protectedPaths: [inUse], dryRun: true },
    { livePaths: () => [join(live, 'src')], log: (line) => logs.push(line) },
  )
  const verdicts = Object.fromEntries(dry.entries.map((entry) => [entry.path.split('/').pop(), entry.verdict]))
  assert.deepEqual(verdicts, {
    merged: 'removed',
    untouched: 'removed',
    unmerged: 'unmerged',
    dirty: 'dirty',
    'in-use': 'in-use',
    live: 'in-use',
    locked: 'locked',
  })
  assert.equal(dry.defaultRef, 'origin/main')
  assert.equal(dry.entries.find((entry) => entry.verdict === 'unmerged')?.uniqueCommits, 1)
  assert.equal(dry.entries.find((entry) => entry.verdict === 'dirty')?.changedPaths, 1)
  assert.ok(await exists(merged), 'a dry run removes nothing')
  assert.ok(logs.some((line) => line.startsWith('would remove') && line.includes('merged')))
  assert.ok(
    logs.some((line) => line.startsWith('kept (unmerged)')),
    'keeps are logged too',
  )

  const real = await cleanupAgentWorktrees(
    { repoRoot: repo, protectedPaths: [inUse] },
    { livePaths: () => [join(live, 'src')], log: () => {} },
  )
  assert.deepEqual(
    real.entries
      .filter((entry) => entry.verdict === 'removed')
      .map((entry) => entry.path.split('/').pop())
      .sort(),
    ['merged', 'untouched'],
  )
  assert.equal(await exists(merged), false)
  assert.equal(await exists(untouched), false)
  for (const kept of [unmerged, dirty, inUse, live, locked, manual]) assert.ok(await exists(kept), `${kept} is kept`)
  assert.match(await git(repo, 'branch', '--list', 'agent/merged'), /agent\/merged/, 'the branch itself is kept')
})

/** A branch whose two commits reach origin/main as ONE squash commit. */
async function squashMerged(slug: string, extra?: string): Promise<string> {
  const path = await addWorktree(slug)
  await writeFile(join(path, `${slug}-1.txt`), 'one\n')
  await git(path, 'add', '.')
  await git(path, 'commit', '-q', '-m', 'one')
  await writeFile(join(path, `${slug}-2.txt`), 'two\n')
  await git(path, 'add', '.')
  await git(path, 'commit', '-q', '-m', 'two')
  // Squash onto origin/main from a scratch clone, as a PR merge would.
  const merger = join(scratch, `merger-${slug}`)
  await git(scratch, 'clone', '-q', join(scratch, 'origin.git'), merger)
  await git(merger, 'fetch', '-q', path, `agent/${slug}`)
  await git(merger, 'merge', '-q', '--squash', 'FETCH_HEAD')
  await git(merger, 'commit', '-q', '-m', `squash ${slug}`)
  await git(merger, 'push', '-q', 'origin', 'HEAD:main')
  await git(repo, 'fetch', '-q')
  if (extra) {
    // Work the squash did not carry: committed on the branch afterwards.
    await writeFile(join(path, extra), 'not merged\n')
    await git(path, 'add', '.')
    await git(path, 'commit', '-q', '-m', 'after the merge')
  }
  return path
}

test('a squash-merged branch is removable; one carrying more work is kept', async () => {
  const squashed = await squashMerged('squashed')
  const moreWork = await squashMerged('more-work', 'late.txt')

  const report = await cleanupAgentWorktrees({ repoRoot: repo, protectedPaths: [] }, { log: () => {} })
  const byName = Object.fromEntries(report.entries.map((entry) => [entry.path.split('/').pop(), entry]))
  assert.equal(byName.squashed?.verdict, 'removed', 'its changes are already on origin/main')
  assert.match(byName.squashed?.detail ?? '', /squash-merged/)
  assert.equal(await exists(squashed), false)
  assert.equal(byName['more-work']?.verdict, 'unmerged', 'a commit the squash did not carry keeps it')
  assert.ok(await exists(moreWork))
  assert.match(await git(repo, 'branch', '--list', 'agent/squashed'), /agent\/squashed/, 'the branch is kept')
})

test('a git without merge-tree --write-tree falls back to the ancestry rule', async () => {
  const squashed = await squashMerged('old-git')
  const report = await cleanupAgentWorktrees(
    { repoRoot: repo, protectedPaths: [] },
    {
      log: () => {},
      // What git < 2.38 says to the flag: a usage error, never a tree.
      runGit: async (cwd, args) =>
        args[0] === 'merge-tree'
          ? { ok: false, stdout: '', stderr: "error: unknown option `write-tree'", message: 'usage: git merge-tree' }
          : runGitCommand(cwd, args),
    },
  )
  const entry = report.entries.find((candidate) => candidate.path === squashed)
  assert.equal(entry?.verdict, 'unmerged', 'an unsupported test is not "merged"')
  assert.ok(await exists(squashed))
})

test('with no default branch to compare against, nothing is removed', async () => {
  const lonely = join(scratch, 'lonely')
  await mkdir(lonely, { recursive: true })
  await git(lonely, 'init', '-q', '-b', 'trunk')
  await writeFile(join(lonely, 'a.txt'), 'a\n')
  await git(lonely, 'add', '.')
  await git(lonely, 'commit', '-q', '-m', 'a')
  const lonelyContainer = join(scratch, '.sprintengine-worktrees', 'lonely')
  await mkdir(lonelyContainer, { recursive: true })
  const path = join(lonelyContainer, 'x')
  await git(lonely, 'worktree', 'add', '-q', '-b', 'agent/x', path)
  const report = await cleanupAgentWorktrees({ repoRoot: lonely, protectedPaths: [] }, { log: () => {} })
  assert.equal(report.defaultRef, null)
  assert.deepEqual(
    report.entries.map((entry) => entry.verdict),
    ['no-default-branch'],
  )
  assert.ok(await exists(path))
})
