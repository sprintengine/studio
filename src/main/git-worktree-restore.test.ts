import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, afterEach, beforeAll, test } from 'vitest'

import { cleanupAgentWorktrees } from './agent-worktree-cleanup'
import { agentWorktreeLockReason, setAgentWorktreeLockProfile } from './agent-worktree-lock'
import { createGitWorktree, restoreGitWorktree } from './git'

/**
 * The way back to a settled chat whose worktree the cleanup gave back: the
 * worktree is checked out again at the same path from the branch the cleanup
 * kept, locked and seeded as it was when first made; and every way that
 * cannot happen says why.
 */

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

async function chatWorktree(slug: string): Promise<string> {
  const created = await createGitWorktree({
    repoRoot: repo,
    containerPath: container,
    destinationPath: join(container, slug),
    branchName: `agent/${slug}`,
    baseRef: 'HEAD',
    copyIncludedFiles: true,
    agentLockOwner: `agent/${slug}`,
  })
  assert.ok(created.ok, created.ok ? '' : created.message)
  return created.data.path
}

beforeAll(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'sprintengine-worktree-restore-')))
  repo = join(scratch, 'app')
  await mkdir(repo, { recursive: true })
  await git(repo, 'init', '-q', '-b', 'main')
  await writeFile(join(repo, 'README.md'), '# app\n')
  await writeFile(join(repo, '.gitignore'), '.env\n')
  await writeFile(join(repo, '.worktreeinclude'), '.env\n')
  await git(repo, 'add', '.')
  await git(repo, 'commit', '-q', '-m', 'init')
  await writeFile(join(repo, '.env'), 'TOKEN=source\n')
  container = join(scratch, '.sprintengine-worktrees', 'app')
})

afterEach(() => setAgentWorktreeLockProfile(null))

afterAll(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true })
})

test('a worktree the cleanup gave back comes back at its path, on its branch, locked and seeded', async () => {
  setAgentWorktreeLockProfile('/Users/dev/profile-a')
  const path = await chatWorktree('chat-ab12')
  await writeFile(join(path, 'feature.txt'), 'the work\n')
  await git(path, 'add', 'feature.txt')
  await git(path, 'commit', '-q', '-m', 'the work')
  await git(repo, 'merge', '-q', '--ff-only', 'agent/chat-ab12')

  const swept = await cleanupAgentWorktrees(
    { repoRoot: repo, protectedPaths: [], ownedOnly: true },
    { log: () => {}, now: () => Date.now() + 2 * 60 * 60_000 },
  )
  assert.equal(swept.entries.find((entry) => entry.path === path)?.verdict, 'removed')
  assert.equal(await exists(path), false)
  assert.equal(await git(repo, 'branch', '--list', 'agent/chat-ab12'), 'agent/chat-ab12', 'the branch is kept')

  const restored = await restoreGitWorktree({
    repoRoot: repo,
    path,
    branchName: 'agent/chat-ab12',
    copyIncludedFiles: true,
    agentLockOwner: 'agent/chat-ab12',
  })
  assert.ok(restored.ok, restored.ok ? '' : restored.message)
  assert.equal(restored.data.path, path)
  assert.equal(restored.data.branch, 'agent/chat-ab12', 'on the branch, not detached')
  assert.equal(restored.data.locked, true)
  assert.equal(restored.data.lockedReason, agentWorktreeLockReason('agent/chat-ab12'))
  assert.equal(restored.data.agentLock, 'this-profile')
  assert.equal(await readFile(join(path, 'feature.txt'), 'utf8'), 'the work\n', "the branch's work is checked out")
  assert.equal(await readFile(join(path, '.env'), 'utf8'), 'TOKEN=source\n', 'seeded from .worktreeinclude')

  // Asked again (a second window got there first): already back, not a failure.
  const again = await restoreGitWorktree({ repoRoot: repo, path, branchName: 'agent/chat-ab12' })
  assert.ok(again.ok, again.ok ? '' : again.message)
  assert.equal(again.data.path, path)
})

test('a deleted branch, an occupied path and a branch checked out elsewhere each say why', async () => {
  // The branch is gone.
  const gone = await chatWorktree('gone')
  await git(repo, 'worktree', 'unlock', gone)
  await git(repo, 'worktree', 'remove', gone)
  await git(repo, 'branch', '-D', 'agent/gone')
  const noBranch = await restoreGitWorktree({ repoRoot: repo, path: gone, branchName: 'agent/gone' })
  assert.equal(noBranch.ok, false)
  assert.match(noBranch.ok ? '' : noBranch.message, /Branch "agent\/gone" no longer exists/)
  assert.equal(await exists(gone), false, 'nothing is left at the path')

  // Something else now sits at the path.
  const taken = await chatWorktree('taken')
  await git(repo, 'worktree', 'unlock', taken)
  await git(repo, 'worktree', 'remove', taken)
  await mkdir(taken, { recursive: true })
  await writeFile(join(taken, 'notes.md'), 'not a worktree\n')
  const occupied = await restoreGitWorktree({ repoRoot: repo, path: taken, branchName: 'agent/taken' })
  assert.equal(occupied.ok, false)
  assert.match(occupied.ok ? '' : occupied.message, /Something else is at/)
  assert.equal(await readFile(join(taken, 'notes.md'), 'utf8'), 'not a worktree\n', 'and it is left alone')

  // The branch is checked out in another worktree.
  await chatWorktree('held')
  const elsewhere = await restoreGitWorktree({
    repoRoot: repo,
    path: join(container, 'held-again'),
    branchName: 'agent/held',
  })
  assert.equal(elsewhere.ok, false)
  assert.match(elsewhere.ok ? '' : elsewhere.message, /is checked out at/)

  // Never a path outside the app's worktree container.
  const outside = await restoreGitWorktree({ repoRoot: repo, path: join(scratch, 'loose'), branchName: 'agent/held' })
  assert.equal(outside.ok, false)
  assert.equal(await exists(join(scratch, 'loose')), false)
})

test('the branch being gone is final; a path that is taken is not', async () => {
  const gone = await chatWorktree('final')
  await git(repo, 'worktree', 'unlock', gone)
  await git(repo, 'worktree', 'remove', gone)
  await git(repo, 'branch', '-D', 'agent/final')
  const noBranch = await restoreGitWorktree({ repoRoot: repo, path: gone, branchName: 'agent/final' })
  assert.equal(noBranch.ok, false)
  assert.equal('definitive' in noBranch && noBranch.definitive, true)

  const taken = await chatWorktree('for-now')
  await git(repo, 'worktree', 'unlock', taken)
  await git(repo, 'worktree', 'remove', taken)
  await mkdir(taken, { recursive: true })
  const occupied = await restoreGitWorktree({ repoRoot: repo, path: taken, branchName: 'agent/for-now' })
  assert.equal(occupied.ok, false)
  assert.equal('definitive' in occupied, false)
})

test("only a path in this project's own container, named without climbing out of it, is recreated", async () => {
  const path = await chatWorktree('confined')
  await git(repo, 'worktree', 'unlock', path)
  await git(repo, 'worktree', 'remove', path)

  const refusals = [
    // Climbs out of the container, back into the project itself (spelled
    // out: `join` would resolve the climb away).
    `${container}/../../app/escaped`,
    // Another project's container, next door.
    join(scratch, '.sprintengine-worktrees', 'other', 'confined'),
    // A container named after a folder inside this project: git answers for
    // it, but it is not the project's top level.
    join(repo, '.sprintengine-worktrees', 'src', 'confined'),
  ]
  await mkdir(join(repo, 'src'), { recursive: true })
  for (const candidate of refusals) {
    const refused = await restoreGitWorktree({ repoRoot: repo, path: candidate, branchName: 'agent/confined' })
    assert.equal(refused.ok, false, candidate)
    assert.match(refused.ok ? '' : refused.message, /not one of the app's worktrees/)
    assert.equal('definitive' in refused && refused.definitive, true)
  }
  assert.equal(await exists(join(repo, 'escaped')), false)
  assert.equal(await exists(join(scratch, '.sprintengine-worktrees', 'other')), false)
  assert.equal(await exists(join(repo, '.sprintengine-worktrees')), false)

  const restored = await restoreGitWorktree({ repoRoot: repo, path, branchName: 'agent/confined' })
  assert.ok(restored.ok, restored.ok ? '' : restored.message)
})

test("an entry git still lists for a folder that is gone is cleared when it is this profile's, and refused when not", async () => {
  setAgentWorktreeLockProfile('/Users/dev/profile-a')
  const own = await chatWorktree('stale-own')
  await rm(own, { recursive: true, force: true })
  const kept = await chatWorktree('stale-kept')
  await rm(kept, { recursive: true, force: true })

  const restored = await restoreGitWorktree({
    repoRoot: repo,
    path: own,
    branchName: 'agent/stale-own',
    agentLockOwner: 'agent/stale-own',
  })
  assert.ok(restored.ok, restored.ok ? '' : restored.message)
  assert.equal(restored.data.branch, 'agent/stale-own')
  assert.equal(restored.data.agentLock, 'this-profile')
  assert.equal(await exists(join(own, 'README.md')), true)
  // Only its own entry went: the other missing one is still listed.
  assert.match(await git(repo, 'worktree', 'list', '--porcelain'), new RegExp(`worktree ${kept}\\n`))

  // Another profile's lock on the missing one is not lifted.
  setAgentWorktreeLockProfile('/Users/dev/profile-b')
  const other = await restoreGitWorktree({ repoRoot: repo, path: kept, branchName: 'agent/stale-kept' })
  assert.equal(other.ok, false)
  assert.match(other.ok ? '' : other.message, /Prune worktrees from the Worktree manager/)
  assert.match(await git(repo, 'worktree', 'list', '--porcelain'), new RegExp(`worktree ${kept}\\n`))
})

test('two windows asking at once share one restore', async () => {
  const path = await chatWorktree('twice')
  await git(repo, 'worktree', 'unlock', path)
  await git(repo, 'worktree', 'remove', path)
  const input = { repoRoot: repo, path, branchName: 'agent/twice', copyIncludedFiles: true }
  const [first, second] = await Promise.all([restoreGitWorktree(input), restoreGitWorktree({ ...input })])
  assert.ok(first.ok, first.ok ? '' : first.message)
  assert.equal(second, first, 'the second caller is handed the first one’s answer')
})

test('an add git reports as failed, that left the worktree on its branch, is the worktree back', async () => {
  const path = await chatWorktree('hooked')
  await git(repo, 'worktree', 'unlock', path)
  await git(repo, 'worktree', 'remove', path)
  // A post-checkout hook that fails: git made the worktree, then says it failed.
  const hook = join(repo, '.git', 'hooks', 'post-checkout')
  await writeFile(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  try {
    const restored = await restoreGitWorktree({
      repoRoot: repo,
      path,
      branchName: 'agent/hooked',
      agentLockOwner: 'agent/hooked',
    })
    assert.ok(restored.ok, restored.ok ? '' : restored.message)
    assert.equal(restored.data.branch, 'agent/hooked')
    assert.equal(restored.data.locked, true, 'locked all the same')
  } finally {
    await rm(hook, { force: true })
  }
})
