import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, beforeEach, test } from 'vitest'

import { cleanupAgentWorktrees } from '../agent-worktree-cleanup'
import { setAgentWorktreeLockProfile } from '../agent-worktree-lock'
import { createGitWorktree, restoreGitWorktree } from '../git'
import { installWorktreePool } from './active-pool'
import { acquireInstanceLock, createPoolStore, POOL_RECORD_VERSION, poolIdFor, type PoolRecord } from './pool-store'
import { parseSlotStatus } from './slot-git'
import { createWorktreePoolService } from './worktree-pool-service'
import { createWorktreePoolTools } from './worktree-pool-tools'

const execFileAsync = promisify(execFile)
const identity = {
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'dev@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'dev@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
}
const saved: Record<string, string | undefined> = {}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...identity },
  })
  return stdout.trim()
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  )
}

let scratch = ''
let caseDir = ''
let origin = ''
let repo = ''
let container = ''
let userData = ''
let caseNumber = 0

const HOUR = 60 * 60_000

function makeService(options: { live?: string[]; now?: () => number; instanceId?: string } = {}) {
  const live = options.live ?? []
  const clock = { offset: 0 }
  const service = createWorktreePoolService({
    store: createPoolStore(userData),
    livePaths: () => live,
    log: process.env.POOL_TEST_LOG ? (line) => console.log(line) : () => {},
    timers: false,
    fetchFreshMs: 0,
    now: options.now ?? (() => Date.now() + clock.offset),
    instanceId: options.instanceId,
  })
  return { service, live, clock }
}

type Harness = ReturnType<typeof makeService>

async function snapshot(harness: Harness) {
  const value = await harness.service.snapshot(repo)
  assert.ok(value, 'the repository has a pool')
  return value
}

async function slotAt(harness: Harness, slotId: string) {
  const found = (await snapshot(harness)).slots.find((slot) => slot.id === slotId)
  assert.ok(found, `slot ${slotId} exists`)
  return found
}

async function lease(harness: Harness, name: string, extra: { agentId?: string } = {}) {
  const result = await harness.service.lease({ repoRoot: repo, name, owner: `agent-${name}`, ...extra })
  assert.equal(result.ok, true, result.ok ? '' : `${result.reason}: ${result.message}`)
  return result as Extract<typeof result, { ok: true }>
}

/** Return every slot nothing protects, with the clock past the unclaimed-lease window. */
async function returnAll(harness: Harness, protectedPaths: string[] = []) {
  harness.clock.offset += 2 * HOUR
  return harness.service.returnUnused({ repoRoot: repo, protectedPaths, agentIds: new Set() })
}

async function pushToOrigin(file: string, content: string): Promise<string> {
  const seed = join(caseDir, 'pusher')
  if (!(await exists(seed))) await git(caseDir, 'clone', '-q', origin, seed)
  await git(seed, 'pull', '-q', 'origin', 'main')
  await writeFile(join(seed, file), content)
  await git(seed, 'add', '.')
  await git(seed, 'commit', '-q', '-m', `edit ${file}`)
  await git(seed, 'push', '-q', 'origin', 'HEAD:main')
  return git(seed, 'rev-parse', 'HEAD')
}

async function lockReason(path: string): Promise<string | null> {
  const listed = await git(repo, 'worktree', 'list', '--porcelain')
  let current: string | null = null
  for (const line of listed.split('\n')) {
    if (line.startsWith('worktree ')) current = line.slice('worktree '.length)
    else if (current && (await realpath(current).catch(() => current)) === (await realpath(path).catch(() => path))) {
      if (line === 'locked' || line.startsWith('locked ')) return line.slice('locked'.length).trim()
    }
  }
  return null
}

beforeAll(async () => {
  for (const [key, value] of Object.entries(identity)) {
    saved[key] = process.env[key]
    process.env[key] = value
  }
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'sprintengine-worktree-pool-')))
})

afterAll(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  installWorktreePool(null)
  setAgentWorktreeLockProfile(null)
  if (scratch) await rm(scratch, { recursive: true, force: true })
})

// Every case gets its own repository, origin and profile, so no case can lean
// on another's slots.
beforeEach(async () => {
  caseNumber += 1
  caseDir = join(scratch, `case-${caseNumber}`)
  await mkdir(caseDir, { recursive: true })
  origin = join(caseDir, 'origin.git')
  const seed = join(caseDir, 'seed')
  await mkdir(seed, { recursive: true })
  await git(seed, 'init', '-q', '-b', 'main')
  await writeFile(join(seed, 'README.md'), '# app\n')
  await writeFile(join(seed, '.gitignore'), 'node_modules/\n.env\n')
  await git(seed, 'add', '.')
  await git(seed, 'commit', '-q', '-m', 'init')
  await git(caseDir, 'clone', '-q', '--bare', seed, origin)
  repo = join(caseDir, 'app')
  await git(caseDir, 'clone', '-q', origin, repo)
  container = join(caseDir, '.sprintengine-worktrees', 'app')
  userData = join(caseDir, 'user-data')
  setAgentWorktreeLockProfile(userData)
  installWorktreePool(null)
})

test('a first lease makes a slot on the freshly fetched default branch, whatever the checkout is on', async () => {
  // The person's checkout is on a feature branch with a commit of its own.
  await git(repo, 'switch', '-q', '-c', 'feature/local')
  await writeFile(join(repo, 'local.txt'), 'local\n')
  await git(repo, 'add', '.')
  await git(repo, 'commit', '-q', '-m', 'local work')
  // Origin moved since the clone; only a fetch at lease time sees it.
  const pushed = await pushToOrigin('upstream.txt', 'new\n')

  const harness = makeService()
  const leased = await lease(harness, 'fix-login')
  assert.equal(leased.created, true)
  assert.equal(leased.branch, 'agent/fix-login')
  assert.equal(leased.baseRef, 'origin/main')
  assert.equal(leased.baseSha, pushed)
  assert.match(leased.path, /\.sprintengine-worktrees[\\/]app[\\/]pool-01$/)
  assert.equal(await git(leased.path, 'rev-parse', 'HEAD'), pushed)
  assert.equal(await git(leased.path, 'branch', '--show-current'), 'agent/fix-login')
  assert.equal(await exists(join(leased.path, 'local.txt')), false, 'nothing of the checkout’s branch')
  assert.match((await lockReason(leased.path)) ?? '', /^agent agent-fix-login \(SprintEngine Studio profile /)
  assert.equal((await slotAt(harness, 'pool-01')).state, 'leased')
})

test('two leases at once get two different slots', async () => {
  const harness = makeService()
  const [a, b] = await Promise.all([lease(harness, 'one'), lease(harness, 'two')])
  assert.notEqual(a.path, b.path)
  assert.deepEqual(
    (await snapshot(harness)).slots.map((slot) => slot.state),
    ['leased', 'leased'],
  )
})

test('a clean return detaches and unlocks, keeps the branch and the ignored files, and the next lease reuses it', async () => {
  const harness = makeService()
  const first = await lease(harness, 'first')
  // The agent installs, commits, and the launch writes its MCP config in.
  await mkdir(join(first.path, 'node_modules', 'left-pad'), { recursive: true })
  await writeFile(join(first.path, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1\n')
  await writeFile(join(first.path, 'work.txt'), 'done\n')
  await git(first.path, 'add', 'work.txt')
  await git(first.path, 'commit', '-q', '-m', 'work')
  await writeFile(join(first.path, '.mcp.json'), '{"mcpServers":{}}\n')

  const swept = await returnAll(harness)
  assert.deepEqual(
    swept.map((entry) => entry.verdict),
    ['returned'],
  )
  const slot = await slotAt(harness, 'pool-01')
  assert.equal(slot.state, 'idle')
  assert.equal(await git(first.path, 'branch', '--show-current'), '', 'detached')
  assert.equal(await lockReason(first.path), null, 'unlocked')
  assert.ok(await git(repo, 'rev-parse', '--verify', 'agent/first'), 'the agent’s branch is kept')
  assert.equal(await exists(join(first.path, '.mcp.json')), false, 'the last agent’s MCP config is gone')

  const moved = await pushToOrigin('later.txt', 'later\n')
  const second = await lease(harness, 'second')
  assert.equal(second.created, false, 'reused')
  assert.equal(second.path, first.path)
  assert.equal(await git(second.path, 'rev-parse', 'HEAD'), moved, 'reset to the new origin/main')
  assert.equal(await exists(join(second.path, 'work.txt')), false, 'the last agent’s tracked work is not here')
  assert.equal(
    await readFile(join(second.path, 'node_modules', 'left-pad', 'index.js'), 'utf8'),
    'module.exports = 1\n',
    'installed dependencies survive',
  )
})

test('a lease nobody has been seen using is left alone for an hour; one seen in use is returned once it is not', async () => {
  const harness = makeService()
  const leased = await lease(harness, 'chat')
  // Not recorded yet (a new chat makes its worktree before its workspace).
  let swept = await harness.service.returnUnused({ repoRoot: repo, protectedPaths: [], agentIds: new Set() })
  assert.deepEqual(
    swept.map((entry) => entry.verdict),
    ['unclaimed'],
  )
  // Recorded: the chat's folder is the slot.
  swept = await harness.service.returnUnused({ repoRoot: repo, protectedPaths: [leased.path], agentIds: new Set() })
  assert.deepEqual(
    swept.map((entry) => entry.verdict),
    ['in-use'],
  )
  // The chat is deleted: returned at once, no hour to wait.
  swept = await harness.service.returnUnused({ repoRoot: repo, protectedPaths: [], agentIds: new Set() })
  assert.deepEqual(
    swept.map((entry) => entry.verdict),
    ['returned'],
  )
})

test('a dirty return is held and locked, untouched until a person stashes', async () => {
  const harness = makeService()
  const leased = await lease(harness, 'dirty')
  await writeFile(join(leased.path, 'README.md'), '# edited\n')
  await writeFile(join(leased.path, 'notes.txt'), 'untracked\n')

  const swept = await returnAll(harness)
  assert.equal(swept[0]?.verdict, 'held')
  const held = await slotAt(harness, 'pool-01')
  assert.equal(held.state, 'held')
  assert.equal(held.held?.reason, 'dirty')
  assert.equal(held.held?.branch, 'agent/dirty')
  assert.equal(await lockReason(leased.path), 'held: dirty')
  assert.equal(await readFile(join(leased.path, 'README.md'), 'utf8'), '# edited\n')

  // A held slot is never leased.
  const next = await lease(harness, 'next')
  assert.notEqual(next.path, leased.path)

  const stashed = await harness.service.action({ kind: 'held', repoRoot: repo, slotId: 'pool-01', action: 'stash' })
  assert.equal(stashed.ok, true)
  assert.equal((await slotAt(harness, 'pool-01')).state, 'idle')
  assert.match(await git(repo, 'stash', 'list'), /worktree pool pool-01/)
})

test('discard aborts and cleans a held slot; keep takes it out of the pool for good', async () => {
  const harness = makeService()
  const a = await lease(harness, 'a')
  const b = await lease(harness, 'b')
  await writeFile(join(a.path, 'README.md'), '# a\n')
  await writeFile(join(b.path, 'README.md'), '# b\n')
  await returnAll(harness)

  const discarded = await harness.service.action({ kind: 'held', repoRoot: repo, slotId: 'pool-01', action: 'discard' })
  assert.equal(discarded.ok, true)
  assert.equal((await slotAt(harness, 'pool-01')).state, 'idle')
  assert.equal(await readFile(join(a.path, 'README.md'), 'utf8'), '# app\n')

  const kept = await harness.service.action({ kind: 'held', repoRoot: repo, slotId: 'pool-02', action: 'keep' })
  assert.equal(kept.ok, true)
  assert.equal(
    (await snapshot(harness)).slots.some((slot) => slot.id === 'pool-02'),
    false,
  )
  assert.equal(await readFile(join(b.path, 'README.md'), 'utf8'), '# b\n', 'kept as it is')
  // A new pool over the same records never adopts it back.
  await harness.service.shutdown()
  const restarted = makeService()
  const third = await lease(restarted, 'c')
  assert.notEqual(third.path, b.path)
})

test('a return waits while a terminal is inside, and a merge in progress holds the slot', async () => {
  const live: string[] = []
  const harness = makeService({ live })
  const leased = await lease(harness, 'busy')
  live.push(join(leased.path, 'src'))
  let swept = await returnAll(harness)
  assert.equal(swept[0]?.verdict, 'in-use')
  assert.equal((await slotAt(harness, 'pool-01')).state, 'leased')
  // A terminal that opens in it between the sweep's look and the return itself.
  live.push(leased.path)
  assert.equal(await harness.service.release(leased.leaseId), 'postponed')
  assert.equal((await slotAt(harness, 'pool-01')).state, 'leased')

  live.length = 0
  await writeFile(join(leased.path, '.git-merge-marker'), '')
  const gitDir = await git(leased.path, 'rev-parse', '--absolute-git-dir')
  await writeFile(join(gitDir, 'MERGE_HEAD'), `${await git(leased.path, 'rev-parse', 'HEAD')}\n`)
  await rm(join(leased.path, '.git-merge-marker'))
  swept = await returnAll(harness)
  assert.equal(swept[0]?.verdict, 'held')
  assert.equal((await slotAt(harness, 'pool-01')).held?.reason, 'operation')
})

test('a detached HEAD holding commits no ref reaches gets a branch before the slot is reused', async () => {
  const harness = makeService()
  const leased = await lease(harness, 'detach')
  await git(leased.path, 'switch', '-q', '--detach')
  await writeFile(join(leased.path, 'orphan.txt'), 'orphan\n')
  await git(leased.path, 'add', '.')
  await git(leased.path, 'commit', '-q', '-m', 'orphan')
  const orphan = await git(leased.path, 'rev-parse', 'HEAD')
  await returnAll(harness)
  const rescued = await git(repo, 'branch', '--list', 'agent/detach-rescued-*', '--format=%(objectname)')
  assert.equal(rescued, orphan)
})

test('an idle slot someone edited is held at the next lease, which gets a new slot', async () => {
  const harness = makeService()
  const first = await lease(harness, 'first')
  await returnAll(harness)
  await writeFile(join(first.path, 'README.md'), '# someone was here\n')
  const second = await lease(harness, 'second')
  assert.notEqual(second.path, first.path)
  const slot = await slotAt(harness, 'pool-01')
  assert.equal(slot.state, 'held')
  assert.equal(slot.held?.reason, 'dirty')
  assert.equal(await readFile(join(first.path, 'README.md'), 'utf8'), '# someone was here\n')
})

test('an ignored file where the new base adds a tracked one holds the slot rather than being overwritten', async () => {
  const harness = makeService()
  const first = await lease(harness, 'first')
  await returnAll(harness)
  await writeFile(join(first.path, '.env'), 'SECRET=mine\n')
  // The default branch now tracks `.env` (and stops ignoring it).
  const seed = join(caseDir, 'pusher')
  await git(caseDir, 'clone', '-q', origin, seed)
  await writeFile(join(seed, '.gitignore'), 'node_modules/\n')
  await writeFile(join(seed, '.env'), 'SECRET=example\n')
  await git(seed, 'add', '.')
  await git(seed, 'commit', '-q', '-m', 'track .env')
  await git(seed, 'push', '-q', 'origin', 'HEAD:main')

  const second = await lease(harness, 'second')
  assert.notEqual(second.path, first.path)
  assert.equal((await slotAt(harness, 'pool-01')).state, 'held')
  assert.equal(await readFile(join(first.path, '.env'), 'utf8'), 'SECRET=mine\n')
})

test('returns beyond the idle limit remove the least recently used idle slot', async () => {
  const harness = makeService()
  await harness.service.updateSettings({ keepIdle: 1 })
  const a = await lease(harness, 'a')
  const b = await lease(harness, 'b')
  await returnAll(harness)
  const slots = (await snapshot(harness)).slots
  assert.equal(slots.length, 1)
  assert.equal(slots[0].state, 'idle')
  const gone = [a.path, b.path].filter((path) => path !== slots[0].path)
  assert.equal(await exists(gone[0]), false)
  assert.ok(await git(repo, 'rev-parse', '--verify', 'agent/a'))
  assert.ok(await git(repo, 'rev-parse', '--verify', 'agent/b'))
})

test('a branch that exists is the caller’s error; a bad name is too', async () => {
  const harness = makeService()
  await git(repo, 'branch', 'agent/taken')
  const taken = await harness.service.lease({ repoRoot: repo, name: 'taken' })
  assert.equal(taken.ok, false)
  assert.equal(taken.ok ? null : taken.reason, 'branch-exists')
  const bad = await harness.service.lease({ repoRoot: repo, name: '///' })
  assert.equal(bad.ok ? null : bad.reason, 'invalid-name')
  // Neither left a slot behind.
  assert.equal((await harness.service.snapshot(repo))?.slots.length ?? 0, 0)
})

test('a slot an agent leased for itself is kept while that agent exists, wherever it works', async () => {
  const harness = makeService()
  await lease(harness, 'mcp', { agentId: 'agent-7' })
  harness.clock.offset += 2 * HOUR
  let swept = await harness.service.returnUnused({ repoRoot: repo, protectedPaths: [], agentIds: new Set(['agent-7']) })
  assert.equal(swept[0]?.verdict, 'in-use')
  swept = await harness.service.returnUnused({ repoRoot: repo, protectedPaths: [], agentIds: null })
  assert.equal(swept[0]?.verdict, 'in-use', 'agents unknown: kept')
  swept = await harness.service.returnUnused({ repoRoot: repo, protectedPaths: [], agentIds: new Set() })
  assert.equal(swept[0]?.verdict, 'returned')
})

test('a second Studio holding the container gets no slot; a dead holder is taken over', async () => {
  await mkdir(container, { recursive: true })
  const held = await acquireInstanceLock(container, 'other-instance', { pidAlive: () => true, host: 'build-box' })
  assert.equal(held.ok, true)
  // Another machine's holder with a fresh heartbeat keeps it.
  const blocked = await makeService().service.lease({ repoRoot: repo, name: 'blocked' })
  assert.equal(blocked.ok ? null : blocked.reason, 'other-instance')

  // A holder on this machine whose process is gone is stale.
  await rm(join(container, '.pool.lock'))
  const { hostname } = await import('node:os')
  await writeFile(
    join(container, '.pool.lock'),
    JSON.stringify({ pid: 999_999_999, host: hostname(), instanceId: 'dead', startedAt: 0 }),
  )
  const taken = await makeService().service.lease({ repoRoot: repo, name: 'taken-over' })
  assert.equal(taken.ok, true)
})

test('a slot deleted from outside is forgotten and pruned, never leased', async () => {
  const harness = makeService()
  const first = await lease(harness, 'first')
  await returnAll(harness)
  await rm(first.path, { recursive: true, force: true })
  const second = await lease(harness, 'second')
  assert.equal(second.created, true)
  assert.equal((await snapshot(harness)).slots.length, 1)
  assert.doesNotMatch(await git(repo, 'worktree', 'list', '--porcelain'), /prunable/)
})

test('recovery removes a half-made slot, returns an interrupted lease, and resumes its own reset', async () => {
  const harness = makeService()
  const a = await lease(harness, 'a')
  const b = await lease(harness, 'b')
  const c = await lease(harness, 'c')
  await returnAll(harness, [a.path])
  // b and c are idle; a is still leased. Now forge what a crash leaves.
  const poolId = poolIdFor(join(repo, '.git'), 'local')
  const recordPath = join(userData, 'worktree-pool', `pool-${poolId}.json`)
  const record = JSON.parse(await readFile(recordPath, 'utf8')) as PoolRecord
  assert.equal(record.version, POOL_RECORD_VERSION)
  const base = await git(repo, 'rev-parse', 'origin/main')
  const moved = await pushToOrigin('moved.txt', 'moved\n')
  await git(repo, 'fetch', '-q', 'origin')
  // c: a reset cut short after `update-ref`, before the tree caught up.
  await git(c.path, 'update-ref', '--no-deref', 'HEAD', moved, base)
  for (const slot of record.slots) {
    if (slot.path === a.path) slot.op = { kind: 'lease', startedAt: 0, pid: 1 }
    if (slot.path === b.path) {
      slot.state = 'creating'
      slot.op = { kind: 'create', startedAt: 0, pid: 1 }
    }
    if (slot.path === c.path) slot.op = { kind: 'reset', startedAt: 0, pid: 1, fromSha: base, toSha: moved }
  }
  await writeFile(recordPath, JSON.stringify(record))
  await harness.service.shutdown()

  const restarted = makeService()
  restarted.clock.offset = 2 * HOUR
  // The first use recovers: b is removed, a's interrupted lease is finished as
  // a return (in the background), and c is left for the next lease to resume.
  const first = await lease(restarted, 'next')
  assert.equal(await exists(b.path), false, 'the interrupted create is removed')
  for (let tries = 0; tries < 100; tries += 1) {
    const states = (await snapshot(restarted)).slots.map((slot) => slot.state)
    if (!states.includes('returning')) break
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20))
  }
  const second = first.path === c.path ? null : await lease(restarted, 'after')
  assert.ok(first.path === c.path || second?.path === c.path, 'the half-reset slot is resumed and reused')
  assert.equal(await git(c.path, 'rev-parse', 'HEAD'), moved)
  assert.equal(await exists(join(c.path, 'moved.txt')), true)
  assert.equal(await git(c.path, 'status', '--porcelain'), '')
  assert.equal(
    (await snapshot(restarted)).slots.some((slot) => slot.path === a.path && slot.state !== 'held'),
    true,
    'the interrupted lease came back as a return, not a hold',
  )
})

test('a reset interrupted over a tree someone then edited is held, not re-run', async () => {
  const harness = makeService()
  const first = await lease(harness, 'first')
  await returnAll(harness)
  const poolId = poolIdFor(join(repo, '.git'), 'local')
  const recordPath = join(userData, 'worktree-pool', `pool-${poolId}.json`)
  const record = JSON.parse(await readFile(recordPath, 'utf8')) as PoolRecord
  const base = await git(repo, 'rev-parse', 'origin/main')
  const moved = await pushToOrigin('moved.txt', 'moved\n')
  await git(repo, 'fetch', '-q', 'origin')
  await git(first.path, 'update-ref', '--no-deref', 'HEAD', moved, base)
  await writeFile(join(first.path, 'theirs.txt'), 'written while the app was down\n')
  record.slots[0].op = { kind: 'reset', startedAt: 0, pid: 1, fromSha: base, toSha: moved }
  await writeFile(recordPath, JSON.stringify(record))
  await harness.service.shutdown()

  const restarted = makeService()
  const next = await lease(restarted, 'next')
  assert.notEqual(next.path, first.path)
  assert.equal((await slotAt(restarted, 'pool-01')).state, 'held')
  assert.equal(await readFile(join(first.path, 'theirs.txt'), 'utf8'), 'written while the app was down\n')
})

test('a worktree merely named like a slot is never adopted', async () => {
  await mkdir(container, { recursive: true })
  await git(repo, 'worktree', 'add', '-q', '-b', 'mine', join(container, 'pool-01'))
  const harness = makeService()
  const leased = await lease(harness, 'agent')
  assert.notEqual(leased.path, join(container, 'pool-01'))
  assert.equal(
    (await snapshot(harness)).slots.some((slot) => slot.path.endsWith('pool-01')),
    false,
  )
})

test('a repository on a WSL machine gets no pool', async () => {
  const harness = makeService()
  const result = await harness.service.lease({ repoRoot: repo, name: 'wsl', hostId: 'wsl:Ubuntu' })
  assert.equal(result.ok ? null : result.reason, 'unsupported')
})

test('the agent worktree cleanup hands pool slots back instead of removing them, and deletes merged agent branches', async () => {
  const harness = makeService()
  const pooled = await lease(harness, 'pooled')
  harness.clock.offset += 2 * HOUR
  // A plain agent branch whose work was squash-merged, one merged by ancestry,
  // and one with work the default branch lacks.
  await git(repo, 'switch', '-q', '-c', 'agent/squashed', 'origin/main')
  await writeFile(join(repo, 'squashed.txt'), 'squashed\n')
  await git(repo, 'add', '.')
  await git(repo, 'commit', '-q', '-m', 'squashed work')
  await git(repo, 'switch', '-q', 'main')
  await git(repo, 'merge', '-q', '--squash', 'agent/squashed')
  await git(repo, 'commit', '-q', '-m', 'squash merge')
  await git(repo, 'push', '-q', 'origin', 'main')
  await git(repo, 'fetch', '-q', 'origin')
  await git(repo, 'branch', 'agent/merged', 'origin/main')
  await git(repo, 'branch', 'agent/merged-chat', 'origin/main')
  await git(repo, 'switch', '-q', '-c', 'agent/unmerged')
  await writeFile(join(repo, 'unmerged.txt'), 'unmerged\n')
  await git(repo, 'add', '.')
  await git(repo, 'commit', '-q', '-m', 'unmerged work')
  await git(repo, 'switch', '-q', 'main')

  const report = await cleanupAgentWorktrees(
    // A chat still records `agent/squashed-chat`: restored from it, so kept.
    { repoRoot: repo, protectedPaths: [], agentIds: [], keepBranches: ['agent/merged-chat'], ownedOnly: true },
    { pool: harness.service, now: () => Date.now() + 2 * HOUR, log: () => {} },
  )
  assert.deepEqual(
    report.entries.map((entry) => [entry.verdict, entry.branch]),
    [['returned', 'agent/pooled']],
  )
  assert.equal(await exists(pooled.path), true, 'the slot stays on disk')
  assert.deepEqual(report.deletedBranches?.sort(), ['agent/merged', 'agent/pooled', 'agent/squashed'])
  assert.ok(await git(repo, 'rev-parse', '--verify', 'agent/unmerged'), 'unmerged work keeps its branch')
  assert.ok(await git(repo, 'rev-parse', '--verify', 'agent/merged-chat'), 'a branch a chat records is kept')

  // A caller that names no records deletes nothing.
  await git(repo, 'branch', 'agent/unknown', 'origin/main')
  const blind = await cleanupAgentWorktrees({ repoRoot: repo, protectedPaths: [] }, { log: () => {} })
  assert.deepEqual(blind.deletedBranches, [])
})

test('the cleanup never deletes a branch a worktree has checked out', async () => {
  const harness = makeService()
  await lease(harness, 'live')
  const report = await cleanupAgentWorktrees(
    { repoRoot: repo, protectedPaths: [], agentIds: [], keepBranches: [] },
    { pool: harness.service, log: () => {} },
  )
  assert.deepEqual(report.deletedBranches, [])
  assert.ok(await git(repo, 'rev-parse', '--verify', 'agent/live'))
})

test('createGitWorktree with fromPool leases from the installed pool, and without one forks the default branch', async () => {
  await git(repo, 'switch', '-q', '-c', 'feature/local')
  await writeFile(join(repo, 'local.txt'), 'local\n')
  await git(repo, 'add', '.')
  await git(repo, 'commit', '-q', '-m', 'local work')
  const originMain = await git(repo, 'rev-parse', 'origin/main')
  const input = (name: string) => ({
    repoRoot: repo,
    containerPath: container,
    destinationPath: join(container, name),
    branchName: `agent/${name}`,
    baseRef: 'HEAD',
    agentLockOwner: `agent/${name}`,
    fromPool: true,
  })

  // No pool in this process (the out-of-process server): fresh, at origin/main.
  const fresh = await createGitWorktree(input('fresh'))
  assert.equal(fresh.ok, true, fresh.ok ? '' : fresh.message)
  if (!fresh.ok) return
  assert.equal(fresh.data.path.endsWith('fresh'), true)
  assert.equal(fresh.data.baseRef, 'origin/main')
  assert.equal(fresh.data.leaseId, null)
  assert.equal(await git(fresh.data.path, 'rev-parse', 'HEAD'), originMain)

  const harness = makeService()
  installWorktreePool(harness.service)
  const pooled = await createGitWorktree(input('pooled'))
  assert.equal(pooled.ok, true, pooled.ok ? '' : pooled.message)
  if (!pooled.ok) return
  assert.match(pooled.data.path, /pool-01$/)
  assert.equal(pooled.data.branch, 'agent/pooled')
  assert.equal(pooled.data.baseRef, 'origin/main')
  assert.ok(pooled.data.leaseId)

  const taken = await createGitWorktree(input('pooled'))
  assert.equal(taken.ok, false, 'an existing branch is reported, not papered over with a fresh worktree')
})

test('worktree.lease serves only an agent Studio started, and only that agent can release it', async () => {
  const harness = makeService()
  const tools = createWorktreePoolTools({
    pool: harness.service,
    findWorkspace: (workspaceId) => (workspaceId === 'ws-1' ? { folderPath: repo } : null),
  })
  const [leaseTool, releaseTool] = tools
  const agent = { metadata: { kind: 'studio-agent' as const, workspaceId: 'ws-1', agentId: 'agent-1' } }

  const refused = await leaseTool.handler({ name: 'x' }, { metadata: { kind: 'external-local' } })
  assert.equal(refused.isError, true)

  const leased = await leaseTool.handler({ name: 'by-tool' }, agent)
  assert.equal(leased.isError ?? false, false)
  const path = (leased.structuredContent as { path: string }).path
  assert.match(path, /pool-01$/)

  const stranger = await releaseTool.handler(
    { path },
    { metadata: { kind: 'studio-agent', workspaceId: 'ws-1', agentId: 'agent-2' } },
  )
  assert.equal(stranger.isError, true)

  const released = await releaseTool.handler({ path }, agent)
  assert.equal((released.structuredContent as { released: boolean }).released, true)
  assert.equal((await slotAt(harness, 'pool-01')).state, 'idle')
})

test('slot status parsing reads branch, commit and every kind of change', () => {
  const oid = 'a'.repeat(40)
  const status = parseSlotStatus(
    [
      `# branch.oid ${oid}`,
      '# branch.head agent/x',
      `1 .M N... 100644 100644 100644 ${oid} ${oid} README.md`,
      `2 R. N... 100644 100644 100644 ${oid} ${oid} R100 new.txt`,
      'old.txt',
      '? untracked.txt',
      '',
    ].join('\0'),
  )
  assert.equal(status.oid, oid)
  assert.equal(status.branch, 'agent/x')
  assert.equal(status.changedPaths, 3)
  assert.deepEqual(status.trackedPaths, ['README.md', 'new.txt', 'old.txt'])
  assert.deepEqual(status.untrackedPaths, ['untracked.txt'])
  assert.equal(parseSlotStatus('# branch.oid (initial)\0# branch.head (detached)\0').branch, null)
})

test('leases reuse the least recently returned slot, keeping a just-settled chat’s worktree free longest', async () => {
  const harness = makeService()
  const older = await lease(harness, 'older')
  const newer = await lease(harness, 'newer')
  await returnAll(harness, [newer.path])
  await returnAll(harness)
  const next = await lease(harness, 'next')
  assert.equal(next.path, older.path)
})

test('a settled chat’s returned slot is given back to it on its branch when the chat is restored', async () => {
  const harness = makeService()
  installWorktreePool(harness.service)
  const chat = await lease(harness, 'chat')
  await mkdir(join(chat.path, 'node_modules', 'dep'), { recursive: true })
  await writeFile(join(chat.path, 'node_modules', 'dep', 'index.js'), 'module.exports = 1\n')
  await writeFile(join(chat.path, 'feature.txt'), 'feature\n')
  await git(chat.path, 'add', 'feature.txt')
  await git(chat.path, 'commit', '-q', '-m', 'feature')
  await returnAll(harness)
  assert.equal((await slotAt(harness, 'pool-01')).state, 'idle')

  const restored = await restoreGitWorktree({ repoRoot: repo, path: chat.path, branchName: 'agent/chat' })
  assert.equal(restored.ok, true, restored.ok ? '' : restored.message)
  assert.equal(await git(chat.path, 'branch', '--show-current'), 'agent/chat')
  assert.equal(await readFile(join(chat.path, 'feature.txt'), 'utf8'), 'feature\n')
  assert.equal(await exists(join(chat.path, 'node_modules', 'dep', 'index.js')), true)
  assert.equal((await slotAt(harness, 'pool-01')).state, 'leased')
  // Asking again (a second window) is answered as done.
  const again = await restoreGitWorktree({ repoRoot: repo, path: chat.path, branchName: 'agent/chat' })
  assert.equal(again.ok, true)
})

test('a returned slot given to another agent since is refused to its old chat, with the reason', async () => {
  const harness = makeService()
  installWorktreePool(harness.service)
  const chat = await lease(harness, 'chat')
  await returnAll(harness)
  const other = await lease(harness, 'other')
  assert.equal(other.path, chat.path)
  const restored = await restoreGitWorktree({ repoRoot: repo, path: chat.path, branchName: 'agent/chat' })
  assert.equal(restored.ok, false)
  assert.match(restored.ok ? '' : restored.message, /given to another agent/)
  assert.equal(await git(chat.path, 'branch', '--show-current'), 'agent/other', 'the other agent is untouched')

  // The branch deleted meanwhile is a refusal for good.
  await returnAll(harness)
  await git(repo, 'branch', '-D', 'agent/chat')
  const gone = await restoreGitWorktree({ repoRoot: repo, path: chat.path, branchName: 'agent/chat' })
  assert.equal(gone.ok, false)
  assert.equal('definitive' in gone && gone.definitive, true)
})
