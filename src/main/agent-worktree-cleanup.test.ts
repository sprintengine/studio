import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, test } from 'vitest'

import { cleanupAgentWorktrees } from './agent-worktree-cleanup'

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
