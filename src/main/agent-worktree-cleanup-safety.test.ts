import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, afterEach, beforeAll, test } from 'vitest'

import { cleanupAgentWorktrees, type AgentWorktreeCleanupDeps } from './agent-worktree-cleanup'
import { agentWorktreeLockReason, setAgentWorktreeLockProfile } from './agent-worktree-lock'
import { createGitWorktree, pruneGitWorktrees, removeGitWorktree } from './git'
import { runGitCommand } from './git-run'
import { listGitWorktrees } from './git-worktree-list'

/**
 * The ways the agent worktree cleanup could take someone's work, each tried on
 * a real repository: a worktree another profile is using, one too new to have
 * an owner on record, ignored files and index-hidden edits that `git status`
 * does not show, and a protected path spelled through a symlink.
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

const later = (): number => Date.now() + 2 * 60 * 60_000
const quiet: AgentWorktreeCleanupDeps = { log: () => {}, now: later }

let unresolvedScratch = ''
let scratch = ''
let repo = ''
let container = ''

async function addWorktree(slug: string): Promise<string> {
  const path = join(container, slug)
  await git(repo, 'worktree', 'add', '-q', '-b', `agent/${slug}`, path, 'origin/main')
  return path
}

async function verdictOf(path: string, deps: AgentWorktreeCleanupDeps = quiet, protectedPaths: string[] = []) {
  const report = await cleanupAgentWorktrees({ repoRoot: repo, protectedPaths, dryRun: true }, deps)
  return report.entries.find((entry) => entry.path === path)
}

beforeAll(async () => {
  unresolvedScratch = await mkdtemp(join(tmpdir(), 'sprintengine-worktree-safety-'))
  scratch = await realpath(unresolvedScratch)
  const seed = join(scratch, 'seed')
  await mkdir(seed, { recursive: true })
  await git(seed, 'init', '-q', '-b', 'main')
  await writeFile(join(seed, 'README.md'), '# app\n')
  await writeFile(join(seed, 'config.json'), '{"debug":false}\n')
  await writeFile(join(seed, '.gitignore'), 'node_modules/\ndist/\n.env\n*.local\nscratch/\n')
  await writeFile(join(seed, '.worktreeinclude'), '.env\n')
  await git(seed, 'add', '.')
  await git(seed, 'commit', '-q', '-m', 'init')
  await git(scratch, 'clone', '-q', '--bare', seed, join(scratch, 'origin.git'))
  repo = join(scratch, 'app')
  await git(scratch, 'clone', '-q', join(scratch, 'origin.git'), repo)
  await writeFile(join(repo, '.env'), 'TOKEN=source\n')
  container = join(scratch, '.sprintengine-worktrees', 'app')
  await mkdir(container, { recursive: true })
})

afterEach(() => setAgentWorktreeLockProfile(null))

afterAll(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true })
})

test('a worktree another profile locked at creation is kept; its own profile releases it', async () => {
  setAgentWorktreeLockProfile('/Users/dev/profile-a')
  const created = await createGitWorktree({
    repoRoot: repo,
    containerPath: container,
    destinationPath: join(container, 'other-profile'),
    branchName: 'agent/other-profile',
    baseRef: 'origin/main',
    agentLockOwner: 'agent-claude-1234',
  })
  assert.ok(created.ok, created.ok ? '' : created.message)
  const path = created.data.path
  assert.equal(created.data.locked, true, 'creation locks it')
  assert.equal(created.data.lockedReason, agentWorktreeLockReason('agent-claude-1234'))
  assert.equal(created.data.agentLock, 'this-profile')

  // Profile B's sweep, which has never heard of this worktree.
  setAgentWorktreeLockProfile('/Users/dev/profile-b')
  assert.equal((await verdictOf(path))?.verdict, 'locked')
  const real = await cleanupAgentWorktrees({ repoRoot: repo, protectedPaths: [] }, quiet)
  assert.equal(real.entries.find((entry) => entry.path === path)?.verdict, 'locked')
  assert.ok(await exists(path), "another profile's lock keeps it")

  // Profile A, while its records still use it, keeps it too.
  setAgentWorktreeLockProfile('/Users/dev/profile-a')
  assert.equal((await verdictOf(path, quiet, [path]))?.verdict, 'in-use')

  // Once A's records let it go, A unlocks it and removes it.
  const released = await cleanupAgentWorktrees({ repoRoot: repo, protectedPaths: [] }, quiet)
  assert.equal(released.entries.find((entry) => entry.path === path)?.verdict, 'removed')
  assert.equal(await exists(path), false)
})

test('a removal git refuses puts the released lock back as it was', async () => {
  setAgentWorktreeLockProfile('/Users/dev/profile-a')
  const path = await addWorktree('refused')
  const reason = agentWorktreeLockReason('agent-codex-9')
  await git(repo, 'worktree', 'lock', '--reason', reason, path)
  const report = await cleanupAgentWorktrees(
    { repoRoot: repo, protectedPaths: [] },
    {
      ...quiet,
      runGit: async (cwd, args) =>
        args[0] === 'worktree' && args[1] === 'remove'
          ? { ok: false, stdout: '', stderr: 'fatal: contains modified files', message: 'contains modified files' }
          : runGitCommand(cwd, args),
    },
  )
  assert.equal(report.entries.find((entry) => entry.path === path)?.verdict, 'error')
  const listed = await listGitWorktrees(repo)
  const entry = listed.ok ? listed.data.worktrees.find((worktree) => worktree.path === path) : undefined
  assert.equal(entry?.locked, true)
  assert.equal(entry?.lockedReason, reason)
})

test('a worktree git used within the hour is kept', async () => {
  const young = await addWorktree('young')
  const entry = await verdictOf(young, { log: () => {} })
  assert.equal(entry?.verdict, 'recent')
  const real = await cleanupAgentWorktrees({ repoRoot: repo, protectedPaths: [] }, { log: () => {} })
  assert.equal(real.entries.find((candidate) => candidate.path === young)?.verdict, 'recent')
  assert.ok(await exists(young))
  // And an age that cannot be read is not taken as old.
  assert.equal((await verdictOf(young, { ...quiet, lastWrittenAt: async () => null }))?.verdict, 'error')
})

test('ignored files that may be work keep the worktree; rebuildable ones and unchanged copies do not', async () => {
  // Only rebuildable output and an untouched .worktreeinclude copy: removable.
  const disposable = await addWorktree('disposable')
  await mkdir(join(disposable, 'node_modules', 'left-pad'), { recursive: true })
  await writeFile(join(disposable, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1\n')
  await mkdir(join(disposable, 'dist'), { recursive: true })
  await writeFile(join(disposable, 'dist', 'app.js'), 'built\n')
  await writeFile(join(disposable, '.env'), 'TOKEN=source\n')
  assert.equal((await verdictOf(disposable))?.verdict, 'removed')

  // The copied .env, edited in the worktree.
  const editedEnv = await addWorktree('edited-env')
  await writeFile(join(editedEnv, '.env'), 'TOKEN=changed-in-the-worktree\n')
  const envEntry = await verdictOf(editedEnv)
  assert.equal(envEntry?.verdict, 'ignored-files')
  assert.match(envEntry?.detail ?? '', /\.env/)

  // Notes in an ignored folder, and an ignored scratch file.
  const notes = await addWorktree('notes')
  await mkdir(join(notes, 'scratch'), { recursive: true })
  await writeFile(join(notes, 'scratch', 'plan.md'), '# the plan\n')
  await writeFile(join(notes, 'todo.local'), 'call back\n')
  const notesEntry = await verdictOf(notes)
  assert.equal(notesEntry?.verdict, 'ignored-files')
  assert.equal(notesEntry?.changedPaths, 2)

  const real = await cleanupAgentWorktrees({ repoRoot: repo, protectedPaths: [] }, quiet)
  const byPath = new Map(real.entries.map((entry) => [entry.path, entry.verdict]))
  assert.equal(byPath.get(disposable), 'removed')
  assert.equal(await exists(disposable), false)
  for (const kept of [editedEnv, notes]) {
    assert.equal(byPath.get(kept), 'ignored-files')
    assert.ok(await exists(kept), `${kept} is kept`)
  }
  assert.equal(await exists(join(notes, 'scratch', 'plan.md')), true)
})

test('edits hidden by --skip-worktree or --assume-unchanged keep the worktree', async () => {
  const skipped = await addWorktree('skip-worktree')
  await git(skipped, 'update-index', '--skip-worktree', 'config.json')
  await writeFile(join(skipped, 'config.json'), '{"debug":true}\n')
  assert.equal(await git(skipped, 'status', '--porcelain'), '', 'status shows nothing')

  const assumed = await addWorktree('assume-unchanged')
  await git(assumed, 'update-index', '--assume-unchanged', 'README.md')
  await writeFile(join(assumed, 'README.md'), '# local edits\n')

  const real = await cleanupAgentWorktrees({ repoRoot: repo, protectedPaths: [] }, quiet)
  for (const kept of [skipped, assumed]) {
    const entry = real.entries.find((candidate) => candidate.path === kept)
    assert.equal(entry?.verdict, 'hidden-edits')
    assert.ok(await exists(kept))
  }
})

test('a sparse checkout leaving files out is not a hidden edit', async () => {
  const sparse = await addWorktree('sparse')
  await git(sparse, 'sparse-checkout', 'set', '--no-cone', '/README.md', '/.gitignore', '/.worktreeinclude')
  assert.equal(await exists(join(sparse, 'config.json')), false)
  assert.equal((await verdictOf(sparse))?.verdict, 'removed')
})

test('a protected path spelled through a symlink, or in another case, still protects', async () => {
  const linked = await addWorktree('linked')
  const alias = join(scratch, 'code-alias')
  await symlink(join(scratch, '.sprintengine-worktrees'), alias)
  const throughLink = join(alias, 'app', 'linked', 'src')
  assert.equal((await verdictOf(linked, quiet, [throughLink]))?.verdict, 'in-use')
  // The temp directory's own unresolved spelling (/var → /private/var on macOS).
  const unresolved = join(unresolvedScratch, '.sprintengine-worktrees', 'app', 'linked')
  assert.equal((await verdictOf(linked, quiet, [unresolved]))?.verdict, 'in-use')
  // A live terminal's path goes through the same comparison.
  assert.equal((await verdictOf(linked, { ...quiet, livePaths: () => [throughLink] }))?.verdict, 'in-use')
  if (process.platform === 'darwin' || process.platform === 'win32') {
    assert.equal((await verdictOf(linked, quiet, [linked.toUpperCase()]))?.verdict, 'in-use')
  }
  assert.equal((await verdictOf(linked))?.verdict, 'removed', 'unprotected, it would go')
})

test('removing or pruning in the Worktree manager releases this profile’s own lock, and no other', async () => {
  setAgentWorktreeLockProfile('/Users/dev/profile-a')
  const own = await addWorktree('manual-remove')
  await git(repo, 'worktree', 'lock', '--reason', agentWorktreeLockReason('agent-x'), own)
  const removed = await removeGitWorktree({ repoRoot: repo, path: own })
  assert.ok(removed.ok, removed.ok ? '' : removed.message)
  assert.equal(await exists(own), false)

  const theirs = await addWorktree('their-lock')
  setAgentWorktreeLockProfile('/Users/dev/profile-b')
  await git(repo, 'worktree', 'lock', '--reason', agentWorktreeLockReason('agent-y'), theirs)
  setAgentWorktreeLockProfile('/Users/dev/profile-a')
  const refused = await removeGitWorktree({ repoRoot: repo, path: theirs })
  assert.equal(refused.ok, false)
  assert.ok(await exists(theirs))

  // A folder deleted by hand under this profile's lock: Prune takes its metadata.
  const gone = await addWorktree('deleted-by-hand')
  await git(repo, 'worktree', 'lock', '--reason', agentWorktreeLockReason('agent-z'), gone)
  await rm(gone, { recursive: true, force: true })
  const pruned = await pruneGitWorktrees(repo)
  assert.ok(pruned.ok)
  const listed = await listGitWorktrees(repo)
  assert.ok(listed.ok)
  assert.equal(
    listed.data.worktrees.some((worktree) => worktree.path === gone),
    false,
  )
  assert.equal(
    listed.data.worktrees.some((worktree) => worktree.path === theirs),
    true,
  )
})
