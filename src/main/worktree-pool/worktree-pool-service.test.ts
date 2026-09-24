import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, realpath, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, beforeEach, test } from 'vitest'

import { cleanupAgentWorktrees } from '../agent-worktree-cleanup'
import type { ToolRunner } from './deps'
import { acquireInstanceLock, createPoolStore, filesystemHostOf, poolIdFor, type PoolRecord } from './pool-store'
import { parseSlotStatus } from './slot-git'
import { createWorktreePoolService, worktreePoolOwnerIndex, type OwnerIndex } from './worktree-pool-service'

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

type Harness = ReturnType<typeof makeService>

function makeService(
  options: {
    live?: string[]
    owners?: OwnerIndex | null
    install?: ToolRunner
    now?: () => number
    instanceId?: string
  } = {},
) {
  const installs: Array<{ cwd: string; command: string }> = []
  const live = options.live ?? []
  const state = { owners: options.owners ?? null }
  const service = createWorktreePoolService({
    store: createPoolStore(userData),
    depsEnv: { env: async () => process.env, version: async (binary) => `${binary}-1.0.0` },
    toolRunner:
      options.install ??
      (async ({ cwd, command }) => {
        installs.push({ cwd, command })
        await mkdir(join(cwd, 'node_modules', 'left-pad'), { recursive: true })
        await writeFile(join(cwd, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1\n')
        return { code: 0, output: 'added 1 package', timedOut: false }
      }),
    livePaths: () => live,
    ownerIndex: () => state.owners,
    log: process.env.POOL_TEST_LOG ? (line) => console.log(line) : () => {},
    timers: false,
    fetchFreshMs: 0,
    now: options.now,
    instanceId: options.instanceId,
  })
  const settle = async (): Promise<void> => {
    for (let round = 0; round < 4; round += 1) await service.tendAll()
  }
  return { service, installs, live, state, settle }
}

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
  await writeFile(join(seed, 'package-lock.json'), '{"lockfileVersion":3}\n')
  await git(seed, 'add', '.')
  await git(seed, 'commit', '-q', '-m', 'init')
  await git(caseDir, 'clone', '-q', '--bare', seed, origin)
  repo = join(caseDir, 'app')
  await git(caseDir, 'clone', '-q', origin, repo)
  container = join(caseDir, '.sprintengine-worktrees', 'app')
  userData = join(caseDir, 'user-data')
})

async function warmPool(harness: Harness, count = 2): Promise<void> {
  await harness.service.updateSettings({ warmTarget: count })
  const warmed = await harness.service.action({ kind: 'warm-up', repoRoot: repo })
  assert.equal(warmed.ok, true, warmed.ok ? '' : warmed.message)
  await harness.settle()
  const warm = (await snapshot(harness)).slots.filter((slot) => slot.state === 'warm')
  assert.equal(warm.length, count, `${count} warm slots`)
}

test('a pool warms to its target, installs once, and leases two slots to two agents at once', async () => {
  const harness = makeService()
  await warmPool(harness, 2)
  const pool = await snapshot(harness)
  const originMain = await git(repo, 'rev-parse', 'origin/main')
  for (const slot of pool.slots) {
    assert.equal(slot.baseSha, originMain)
    assert.equal(slot.depsState, 'ok')
    assert.equal(slot.installCommand, 'npm ci')
    assert.match(slot.path, /\.sprintengine-worktrees[\\/]app[\\/]pool-0[12]$/)
  }
  assert.equal(harness.installs.length, 2, 'one install per new slot')

  const [a, b] = await Promise.all([
    harness.service.lease({
      repoRoot: repo,
      name: 'alpha',
      owner: { agentId: 'agent-a', workspaceId: 'ws' },
      runtime: 'native',
    }),
    harness.service.lease({
      repoRoot: repo,
      name: 'beta',
      owner: { agentId: 'agent-b', workspaceId: 'ws' },
      runtime: 'native',
    }),
  ])
  assert.ok(a.ok && b.ok)
  assert.notEqual(a.path, b.path, 'two concurrent leases never share a slot')
  assert.equal(await git(a.path, 'rev-parse', '--abbrev-ref', 'HEAD'), 'agent/alpha')
  const list = await git(repo, 'worktree', 'list', '--porcelain')
  assert.match(list, /locked leased: agent-a/)
  assert.match(list, /locked leased: agent-b/)

  // A third lease while nothing is warm is declined, and the caller creates a
  // worktree the old way.
  const third = await harness.service.lease({
    repoRoot: repo,
    name: 'gamma',
    owner: { agentId: 'agent-c', workspaceId: 'ws' },
    runtime: 'native',
  })
  assert.equal(third.ok, false)
  assert.equal(!third.ok && third.reason, 'no-warm-slot')

  // WSL agents never get a native slot.
  const wsl = await harness.service.lease({
    repoRoot: repo,
    name: 'delta',
    owner: { agentId: 'agent-d', workspaceId: 'ws' },
    runtime: 'wsl',
  })
  assert.equal(!wsl.ok && wsl.reason, 'unsupported')
})

test('a clean return keeps the agent branch, detaches, unlocks and refreshes to the new origin', async () => {
  const harness = makeService()
  await warmPool(harness, 1)
  const leased = await harness.service.lease({
    repoRoot: repo,
    name: 'feature',
    owner: { agentId: 'agent-1', workspaceId: 'ws' },
    runtime: 'native',
  })
  assert.ok(leased.ok)
  await writeFile(join(leased.path, 'feature.txt'), 'done\n')
  await git(leased.path, 'add', '.')
  await git(leased.path, 'commit', '-q', '-m', 'feature')
  const agentCommit = await git(leased.path, 'rev-parse', 'HEAD')
  const moved = await pushToOrigin('upstream.txt', 'new upstream\n')

  assert.equal(await harness.service.release(leased.leaseId), true)
  await harness.settle()
  const slot = await slotAt(harness, leased.slotId)
  assert.equal(slot.state, 'warm')
  assert.equal(slot.lease, null)
  assert.equal(slot.baseSha, moved, 'refreshed to the fetched origin/main')
  assert.equal(await git(repo, 'rev-parse', 'agent/feature'), agentCommit, 'the agent branch keeps its commit')
  assert.equal(await git(leased.path, 'rev-parse', 'HEAD'), moved)
  assert.equal(await git(leased.path, 'status', '--porcelain'), '')
  assert.equal(
    await exists(join(leased.path, 'feature.txt')),
    false,
    'the agent work is on its branch, not in the slot',
  )
  assert.equal(await exists(join(leased.path, 'upstream.txt')), true)
  assert.equal(
    await readFile(join(leased.path, 'node_modules', 'left-pad', 'index.js'), 'utf8'),
    'module.exports = 1\n',
    'ignored dependencies survive the reset',
  )
  assert.doesNotMatch(await git(repo, 'worktree', 'list', '--porcelain'), /locked/)
  assert.equal(
    harness.installs.filter((install) => install.cwd === leased.path).length,
    1,
    'the lockfile did not change, so the returned slot was not reinstalled',
  )
})

test('a dirty return is held, locked and untouched; only an explicit action moves it', async () => {
  const harness = makeService()
  await warmPool(harness, 1)
  const leased = await harness.service.lease({
    repoRoot: repo,
    name: 'dirty',
    owner: { agentId: 'agent-1', workspaceId: 'ws' },
    runtime: 'native',
  })
  assert.ok(leased.ok)
  await writeFile(join(leased.path, 'notes.md'), 'not committed\n')
  await writeFile(join(leased.path, 'README.md'), '# changed\n')

  await harness.service.release(leased.leaseId)
  await harness.settle()
  let slot = await slotAt(harness, leased.slotId)
  assert.equal(slot.state, 'held')
  assert.equal(slot.held?.reason, 'dirty')
  assert.equal(slot.held?.changedPaths, 2)
  assert.equal(slot.held?.branch, 'agent/dirty')
  assert.equal(await readFile(join(leased.path, 'notes.md'), 'utf8'), 'not committed\n')
  assert.equal(await readFile(join(leased.path, 'README.md'), 'utf8'), '# changed\n')
  assert.match(await git(repo, 'worktree', 'list', '--porcelain'), /locked held: dirty/)

  // Maintenance and a manual re-check never reset it.
  await harness.service.action({ kind: 'refresh', repoRoot: repo, slotId: leased.slotId })
  await harness.settle()
  slot = await slotAt(harness, leased.slotId)
  assert.equal(slot.state, 'held')
  assert.equal(await readFile(join(leased.path, 'notes.md'), 'utf8'), 'not committed\n')

  // Commit keeps the work on the agent branch and returns the slot.
  const committed = await harness.service.action({
    kind: 'held',
    repoRoot: repo,
    slotId: leased.slotId,
    action: 'commit',
    message: 'keep my notes',
  })
  assert.equal(committed.ok, true)
  await harness.settle()
  slot = await slotAt(harness, leased.slotId)
  assert.equal(slot.state, 'warm')
  assert.equal(await git(repo, 'log', '-1', '--format=%s', 'agent/dirty'), 'keep my notes')
  assert.equal(await git(repo, 'show', 'agent/dirty:notes.md'), 'not committed')
})

test('stash and discard are the only ways a held tree loses its changes, and keep leaves the pool', async () => {
  const harness = makeService()
  await warmPool(harness, 3)
  const lease = (name: string) =>
    harness.service.lease({
      repoRoot: repo,
      name,
      owner: { agentId: `agent-${name}`, workspaceId: 'ws' },
      runtime: 'native',
    })
  const stashMe = await lease('stash-me')
  const discardMe = await lease('discard-me')
  const keepMe = await lease('keep-me')
  assert.ok(stashMe.ok && discardMe.ok && keepMe.ok)
  for (const leased of [stashMe, discardMe, keepMe]) {
    await writeFile(join(leased.path, 'wip.txt'), `${leased.branch}\n`)
    await harness.service.release(leased.leaseId)
  }
  await harness.settle()

  const stashed = await harness.service.action({
    kind: 'held',
    repoRoot: repo,
    slotId: stashMe.slotId,
    action: 'stash',
  })
  assert.equal(stashed.ok, true)
  assert.match(await git(repo, 'stash', 'list'), /worktree pool .*agent\/stash-me/)
  assert.equal(await git(repo, 'show', 'stash@{0}^3:wip.txt'), 'agent/stash-me')

  const discarded = await harness.service.action({
    kind: 'held',
    repoRoot: repo,
    slotId: discardMe.slotId,
    action: 'discard',
  })
  assert.equal(discarded.ok, true)
  assert.equal(await exists(join(discardMe.path, 'wip.txt')), false)

  const kept = await harness.service.action({ kind: 'held', repoRoot: repo, slotId: keepMe.slotId, action: 'keep' })
  assert.equal(kept.ok, true)
  await harness.settle()
  const pool = await snapshot(harness)
  assert.equal(
    pool.slots.some((slot) => slot.id === keepMe.slotId),
    false,
    'kept slots leave the pool',
  )
  assert.equal(await readFile(join(keepMe.path, 'wip.txt'), 'utf8'), 'agent/keep-me\n')
  assert.equal(harness.service.ownsPath(keepMe.path), false)
  // The pool warms a replacement under a new name rather than reusing the kept path.
  assert.ok(pool.slots.every((slot) => slot.path !== keepMe.path))

  // A restart does not adopt the kept worktree back.
  const restarted = makeService()
  await restarted.service.start()
  assert.equal(restarted.service.ownsPath(keepMe.path), false)
})

test('returns are postponed while anything runs in the slot, or a merge is in progress', async () => {
  const harness = makeService()
  await warmPool(harness, 2)
  const busy = await harness.service.lease({
    repoRoot: repo,
    name: 'busy',
    owner: { agentId: 'agent-1', workspaceId: 'ws' },
    runtime: 'native',
  })
  assert.ok(busy.ok)
  harness.live.push(join(busy.path, 'src'))
  await harness.service.release(busy.leaseId)
  assert.equal((await slotAt(harness, busy.slotId)).state, 'leased', 'a live terminal inside keeps it leased')
  harness.live.length = 0
  await harness.service.action({ kind: 'release', repoRoot: repo, slotId: busy.slotId })
  await harness.settle()
  assert.equal((await slotAt(harness, busy.slotId)).state, 'warm')

  const merging = await harness.service.lease({
    repoRoot: repo,
    name: 'merging',
    owner: { agentId: 'agent-2', workspaceId: 'ws' },
    runtime: 'native',
  })
  assert.ok(merging.ok)
  const gitDir = await git(merging.path, 'rev-parse', '--absolute-git-dir')
  await writeFile(join(gitDir, 'MERGE_HEAD'), `${await git(merging.path, 'rev-parse', 'HEAD')}\n`)
  await harness.service.release(merging.leaseId)
  const slot = await slotAt(harness, merging.slotId)
  assert.equal(slot.state, 'held')
  assert.equal(slot.held?.reason, 'operation')
})

test('a detached HEAD holding commits no ref reaches gets a branch before the slot is recycled', async () => {
  const harness = makeService()
  await warmPool(harness, 1)
  const leased = await harness.service.lease({
    repoRoot: repo,
    name: 'wander',
    owner: { agentId: 'agent-1', workspaceId: 'ws' },
    runtime: 'native',
  })
  assert.ok(leased.ok)
  await git(leased.path, 'switch', '-q', '--detach')
  await writeFile(join(leased.path, 'orphan.txt'), 'only here\n')
  await git(leased.path, 'add', '.')
  await git(leased.path, 'commit', '-q', '-m', 'orphan')
  const orphan = await git(leased.path, 'rev-parse', 'HEAD')
  await harness.service.release(leased.leaseId)
  await harness.settle()
  assert.equal((await slotAt(harness, leased.slotId)).state, 'warm')
  const branches = await git(repo, 'branch', '--list', 'agent/wander-rescued-*', '--format=%(objectname)')
  assert.equal(branches, orphan)
})

test('a stale index.lock is cleared on return; a fresh one postpones it', async () => {
  let clock = Date.now()
  const harness = makeService({ now: () => clock })
  await warmPool(harness, 1)
  const leased = await harness.service.lease({
    repoRoot: repo,
    name: 'locked',
    owner: { agentId: 'agent-1', workspaceId: 'ws' },
    runtime: 'native',
  })
  assert.ok(leased.ok)
  const gitDir = await git(leased.path, 'rev-parse', '--absolute-git-dir')
  await writeFile(join(gitDir, 'index.lock'), '')
  await harness.service.release(leased.leaseId)
  assert.equal((await slotAt(harness, leased.slotId)).state, 'leased', 'a fresh lock may belong to a running git')
  assert.equal(await exists(join(gitDir, 'index.lock')), true)

  const old = new Date(Date.now() - 20 * 60_000)
  await utimes(join(gitDir, 'index.lock'), old, old)
  clock += 60_000
  await harness.service.release(leased.leaseId)
  await harness.settle()
  assert.equal(await exists(join(gitDir, 'index.lock')), false)
  // Returned clean: warm again, or (one slot over the warm target) evicted.
  const after = (await snapshot(harness)).slots.find((slot) => slot.id === leased.slotId)
  assert.ok(!after || after.state === 'warm', `returned, not ${after?.state}`)
})

test('an idle slot someone edited is held, never reset, and never leased', async () => {
  const harness = makeService()
  await warmPool(harness, 2)
  const [first] = (await snapshot(harness)).slots
  await writeFile(join(first.path, 'scratch.txt'), 'mine\n')
  const moved = await pushToOrigin('upstream.txt', 'v2\n')
  // Maintenance: origin moved, so warm slots refresh. The edited one must not.
  await harness.settle()
  const pool = await snapshot(harness)
  const edited = pool.slots.find((slot) => slot.id === first.id)
  assert.equal(edited?.state, 'held')
  assert.equal(edited?.held?.reason, 'dirty')
  assert.equal(await readFile(join(first.path, 'scratch.txt'), 'utf8'), 'mine\n')
  assert.ok(pool.slots.some((slot) => slot.state === 'warm' && slot.baseSha === moved))

  const leased = await harness.service.lease({
    repoRoot: repo,
    name: 'next',
    owner: { agentId: 'agent-1', workspaceId: 'ws' },
    runtime: 'native',
  })
  assert.ok(leased.ok)
  assert.notEqual(leased.slotId, first.id)
})

test('a lease during a refresh never gets the refreshing slot', async () => {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let installing = 0
  let gated = ''
  const harness = makeService({
    install: async ({ cwd }) => {
      await mkdir(join(cwd, 'node_modules'), { recursive: true })
      if (cwd === gated) {
        installing += 1
        await gate
      }
      return { code: 0, output: '', timedOut: false }
    },
  })
  await warmPool(harness, 1)
  // The lockfile changes upstream, so the refresh after the next return
  // reinstalls, and the install is held open by the gate.
  await pushToOrigin('package-lock.json', '{"lockfileVersion":3,"packages":{}}\n')
  const leased = await harness.service.lease({
    repoRoot: repo,
    name: 'one',
    owner: { agentId: 'agent-1', workspaceId: 'ws' },
    runtime: 'native',
  })
  assert.ok(leased.ok)
  await harness.settle()
  // The replacement slot is warm; lease it too, so no warm slot is left.
  const other = await harness.service.lease({
    repoRoot: repo,
    name: 'other',
    owner: { agentId: 'agent-0', workspaceId: 'ws' },
    runtime: 'native',
  })
  assert.ok(other.ok)
  await harness.service.updateSettings({ warmTarget: 1 })
  gated = leased.path
  await harness.service.release(leased.leaseId)
  const pending = harness.settle()
  for (let tries = 0; tries < 200 && installing < 1; tries += 1) await new Promise((r) => setTimeout(r, 20))
  assert.equal((await slotAt(harness, leased.slotId)).state, 'installing')
  const during = await harness.service.lease({
    repoRoot: repo,
    name: 'two',
    owner: { agentId: 'agent-2', workspaceId: 'ws' },
    runtime: 'native',
  })
  // It may get a freshly created replacement, never the slot being installed.
  if (during.ok) assert.notEqual(during.slotId, leased.slotId)
  else assert.equal(during.reason, 'no-warm-slot')
  assert.equal((await slotAt(harness, leased.slotId)).state, 'installing')
  release()
  await pending
  assert.equal((await slotAt(harness, leased.slotId)).state, 'warm')
})

test('dependencies reinstall only when the fingerprint moves, and a failed install still leases', async () => {
  let fail = false
  const runs: string[] = []
  const harness = makeService({
    install: async ({ cwd }) => {
      runs.push(cwd)
      await mkdir(join(cwd, 'node_modules'), { recursive: true })
      return fail ? { code: 1, output: 'npm ERR! boom', timedOut: false } : { code: 0, output: '', timedOut: false }
    },
  })
  await warmPool(harness, 1)
  assert.equal(runs.length, 1)
  const [slot] = (await snapshot(harness)).slots

  // Same lockfile upstream, different README: no install.
  await pushToOrigin('README.md', '# v2\n')
  await harness.settle()
  assert.equal(runs.length, 1)

  // A changed lockfile that fails to install.
  fail = true
  await pushToOrigin('package-lock.json', '{"lockfileVersion":3,"v":2}\n')
  await harness.settle()
  assert.equal(runs.length, 2)
  let after = await slotAt(harness, slot.id)
  assert.equal(after.state, 'warm')
  assert.equal(after.depsState, 'failed')
  assert.match(after.error ?? '', /boom/)

  // An unattended pass does not repeat a failure; a person's refresh does.
  await harness.settle()
  assert.equal(runs.length, 2)
  fail = false
  await harness.service.action({ kind: 'refresh', repoRoot: repo, slotId: slot.id })
  await harness.settle()
  assert.equal(runs.length, 3)
  after = await slotAt(harness, slot.id)
  assert.equal(after.depsState, 'ok')

  fail = true
  await pushToOrigin('package-lock.json', '{"lockfileVersion":3,"v":3}\n')
  await harness.settle()
  const leased = await harness.service.lease({
    repoRoot: repo,
    name: 'anyway',
    owner: { agentId: 'agent-1', workspaceId: 'ws' },
    runtime: 'native',
  })
  assert.ok(leased.ok)
  assert.equal(leased.depsState, 'failed', 'the caller shows a banner and the agent still gets the slot')
})

test('the owner sweep returns a lease only once its owner is confirmed gone', async () => {
  let clock = Date.now()
  const harness = makeService({
    now: () => clock,
    owners: { agents: new Set(['agent-1']), workspaces: new Set(['ws']), paths: [] },
  })
  await warmPool(harness, 2)
  const agentLease = await harness.service.lease({
    repoRoot: repo,
    name: 'swept',
    owner: { agentId: 'agent-1', workspaceId: 'ws' },
    runtime: 'native',
  })
  const pendingLease = await harness.service.lease({
    repoRoot: repo,
    name: 'pending',
    owner: { agentId: null, workspaceId: null },
    runtime: 'native',
  })
  assert.ok(agentLease.ok && pendingLease.ok)
  await harness.service.sweepOwners()

  // The agent is removed. One sweep is not enough; a second one 20 s later is.
  harness.state.owners = { agents: new Set(), workspaces: new Set(['ws']), paths: [] }
  await harness.service.sweepOwners()
  assert.equal((await slotAt(harness, agentLease.slotId)).state, 'leased')
  clock += 25_000
  await harness.service.sweepOwners()
  await harness.settle()
  assert.equal((await slotAt(harness, agentLease.slotId)).state, 'warm')

  // A lease nobody claimed yet is left alone for its grace period, and a
  // record pointing into the slot keeps it however long it takes.
  assert.equal((await slotAt(harness, pendingLease.slotId)).state, 'leased')
  harness.state.owners = { agents: new Set(), workspaces: new Set(), paths: [pendingLease.path] }
  clock += 60 * 60_000
  await harness.service.sweepOwners()
  clock += 25_000
  await harness.service.sweepOwners()
  assert.equal((await slotAt(harness, pendingLease.slotId)).state, 'leased')
  await harness.service.bind(pendingLease.leaseId, { agentId: 'agent-late', workspaceId: 'ws' })
  harness.state.owners = { agents: new Set(['agent-late']), workspaces: new Set(['ws']), paths: [] }
  await harness.service.sweepOwners()
  assert.equal((await slotAt(harness, pendingLease.slotId)).lease?.owner.agentId, 'agent-late')

  // With no registry to read, nothing is returned at all.
  harness.state.owners = null
  clock += 60 * 60_000
  await harness.service.sweepOwners()
  assert.equal((await slotAt(harness, pendingLease.slotId)).state, 'leased')
})

test('crash recovery finishes what it can prove is its own and holds the rest', async () => {
  const harness = makeService()
  await warmPool(harness, 3)
  const [halfReset, midLease, unknown] = (await snapshot(harness)).slots
  const store = createPoolStore(userData)
  const [{ record }] = await store.readAll()
  assert.ok(record)
  const moved = await pushToOrigin('upstream.txt', 'v2\n')
  await git(repo, 'fetch', '-q')

  // 1. The app died mid-refresh: HEAD was moved, the tree was not.
  const from = await git(halfReset.path, 'rev-parse', 'HEAD')
  await git(halfReset.path, 'update-ref', '--no-deref', 'HEAD', moved)
  const gitDir = await git(halfReset.path, 'rev-parse', '--absolute-git-dir')
  await writeFile(join(gitDir, 'index.lock'), '')
  // 2. The app died mid-lease, after the branch was made.
  await git(midLease.path, 'switch', '-q', '-c', 'agent/interrupted')
  // 3. A slot the record lost track of, with work in it.
  await writeFile(join(unknown.path, 'mine.txt'), 'keep\n')
  const edited: PoolRecord = {
    ...record,
    slots: record.slots
      .filter((slot) => slot.id !== unknown.id)
      .map((slot) =>
        slot.id === halfReset.id
          ? { ...slot, state: 'refreshing', op: { kind: 'refresh', startedAt: 1, pid: 1, fromSha: from, toSha: moved } }
          : slot.id === midLease.id
            ? { ...slot, state: 'leasing', op: { kind: 'lease', startedAt: 1, pid: 1 } }
            : slot,
      ),
  }
  await harness.service.shutdown()
  await store.write(edited)

  const restarted = makeService()
  await restarted.service.start()
  await restarted.settle()
  const pool = await snapshot(restarted)
  const resumed = pool.slots.find((slot) => slot.id === halfReset.id)
  assert.equal(resumed?.state, 'warm')
  assert.equal(resumed?.baseSha, moved)
  assert.equal(await git(halfReset.path, 'status', '--porcelain'), '')
  assert.equal(await exists(join(halfReset.path, 'upstream.txt')), true)

  const returned = pool.slots.find((slot) => slot.id === midLease.id)
  assert.equal(returned?.state, 'warm')
  assert.equal(await git(repo, 'rev-parse', '--verify', '--quiet', 'agent/interrupted').then(Boolean), true)

  const adopted = pool.slots.find((slot) => slot.id === unknown.id)
  assert.equal(adopted?.state, 'held')
  assert.equal(adopted?.held?.reason, 'recovery')
  assert.equal(await readFile(join(unknown.path, 'mine.txt'), 'utf8'), 'keep\n')
})

test('a refresh interrupted over a tree someone then edited is held, not re-run', async () => {
  const harness = makeService()
  await warmPool(harness, 1)
  const [slot] = (await snapshot(harness)).slots
  const store = createPoolStore(userData)
  const [{ record }] = await store.readAll()
  assert.ok(record)
  // HEAD is at neither end of the recorded reset: someone committed there.
  await writeFile(join(slot.path, 'theirs.txt'), 'theirs\n')
  await git(slot.path, 'add', '.')
  await git(slot.path, 'commit', '-q', '-m', 'someone')
  await writeFile(join(slot.path, 'more.txt'), 'uncommitted\n')
  await harness.service.shutdown()
  await store.write({
    ...record,
    slots: record.slots.map((candidate) => ({
      ...candidate,
      state: 'refreshing' as const,
      op: { kind: 'refresh' as const, startedAt: 1, pid: 1, fromSha: 'a'.repeat(40), toSha: 'b'.repeat(40) },
    })),
  })
  const restarted = makeService()
  await restarted.service.start()
  await restarted.settle()
  const after = await slotAt(restarted, slot.id)
  assert.equal(after.state, 'held')
  assert.equal(await readFile(join(slot.path, 'more.txt'), 'utf8'), 'uncommitted\n')
})

test('a second Studio holding the container gets no slots; a dead holder is taken over', async () => {
  await mkdir(container, { recursive: true })
  const other = await acquireInstanceLock(container, 'other-instance', { pidAlive: () => true, host: 'build-box' })
  assert.equal(other.ok, true)
  const harness = makeService({ instanceId: 'this-instance' })
  const refused = await harness.service.lease({
    repoRoot: repo,
    name: 'x',
    owner: { agentId: 'agent-1', workspaceId: 'ws' },
    runtime: 'native',
  })
  assert.equal(!refused.ok && refused.reason, 'other-instance')

  const takeover = await acquireInstanceLock(container, 'third', { pidAlive: () => false, host: 'build-box' })
  assert.equal(takeover.ok, true, 'a holder whose process is gone on its own host is stale')
})

test('the agent worktree cleanup never removes a pool slot, leased or not', async () => {
  const harness = makeService()
  await warmPool(harness, 1)
  const leased = await harness.service.lease({
    repoRoot: repo,
    name: 'merged-already',
    owner: { agentId: 'agent-1', workspaceId: 'ws' },
    runtime: 'native',
  })
  assert.ok(leased.ok)
  // Unlock by hand: even then, the cleanup asks the pool.
  await git(repo, 'worktree', 'unlock', leased.path)
  const report = await cleanupAgentWorktrees(
    { repoRoot: repo, protectedPaths: [] },
    { log: () => {}, poolOwns: (path) => harness.service.ownsPath(path) },
  )
  const entry = report.entries.find((candidate) => candidate.path === leased.path)
  assert.equal(entry?.verdict, 'in-use')
  assert.equal(await exists(leased.path), true)
})

test('evicting and idle rules never touch leased or held slots', async () => {
  let clock = Date.now()
  const harness = makeService({ now: () => clock })
  await warmPool(harness, 3)
  const leased = await harness.service.lease({
    repoRoot: repo,
    name: 'stay',
    owner: { agentId: 'agent-1', workspaceId: 'ws' },
    runtime: 'native',
  })
  assert.ok(leased.ok)
  const [, , third] = (await snapshot(harness)).slots.filter((slot) => slot.id !== leased.slotId)
  const held = (await snapshot(harness)).slots.find((slot) => slot.state === 'warm' && slot.id !== third?.id)
  assert.ok(held)
  await writeFile(join(held.path, 'x.txt'), 'x\n')
  // Idle for longer than the eviction window: warm slots go, the rest stay.
  clock += 8 * 24 * 60 * 60_000
  await harness.settle()
  const pool = await snapshot(harness)
  assert.ok(pool.slots.every((slot) => slot.state !== 'warm'))
  assert.equal(pool.slots.find((slot) => slot.id === leased.slotId)?.state, 'leased')
  assert.equal(pool.slots.find((slot) => slot.id === held.id)?.state, 'held')
  assert.equal(await readFile(join(held.path, 'x.txt'), 'utf8'), 'x\n')
})

test('pool keys and slot status parsing', () => {
  assert.equal(filesystemHostOf('\\\\wsl.localhost\\Ubuntu\\home\\dev\\app'), 'wsl:ubuntu')
  assert.equal(filesystemHostOf('//wsl$/Debian/home/dev/app'), 'wsl:debian')
  assert.equal(filesystemHostOf('\\\\build-box\\share\\app'), 'unc:build-box')
  assert.equal(filesystemHostOf('C:\\Users\\dev\\app'), 'local')
  assert.equal(filesystemHostOf('/Users/dev/app'), 'local')
  const common = 'C:/Users/dev/app/.git'
  assert.notEqual(poolIdFor(common, 'local', 'win32'), poolIdFor(common, 'local', 'linux'))
  assert.notEqual(poolIdFor(common, 'local', 'win32'), poolIdFor(common, 'wsl:ubuntu', 'win32'))
  // One repository spelled two ways on Windows is one pool.
  assert.equal(poolIdFor('C:\\Users\\dev\\app\\.git', 'local', 'win32'), poolIdFor(common, 'local', 'win32'))

  const oid = 'a'.repeat(40)
  const detachedClean = `# branch.oid ${oid}\0# branch.head (detached)\0`
  assert.deepEqual(parseSlotStatus(detachedClean), { oid, branch: null, changedPaths: 0 })
  const busy = [
    `# branch.oid ${oid}`,
    '# branch.head agent/x',
    '1 .M N... 100644 100644 100644 abc abc src/a.ts',
    '2 R. N... 100644 100644 100644 abc abc R100 src/new.ts',
    'src/old.ts',
    '? notes.md',
    '',
  ].join('\0')
  assert.deepEqual(parseSlotStatus(busy), { oid, branch: 'agent/x', changedPaths: 3 })
})

test('an interrupted create is removed, a postponed return retries, and recovery waits for the lock', async () => {
  const harness = makeService()
  await warmPool(harness, 2)
  const [first] = (await snapshot(harness)).slots

  // A return postponed by a live terminal is retried by the next pass alone.
  const leased = await harness.service.lease({
    repoRoot: repo,
    name: 'later',
    owner: { agentId: 'agent-1', workspaceId: 'ws' },
    runtime: 'native',
  })
  assert.ok(leased.ok)
  harness.live.push(leased.path)
  await harness.service.release(leased.leaseId)
  assert.equal((await slotAt(harness, leased.slotId)).state, 'leased')
  harness.live.length = 0
  await harness.settle()
  const returned = (await snapshot(harness)).slots.find((slot) => slot.id === leased.slotId)
  assert.ok(!returned || returned.state === 'warm', `returned, not ${returned?.state}`)

  // The app died during `worktree add`: the half-made slot is removed.
  const store = createPoolStore(userData)
  const [{ record }] = await store.readAll()
  assert.ok(record)
  const victim = record.slots.find((slot) => slot.state === 'warm' && slot.id !== first.id) ?? record.slots[0]
  await rm(join(victim.path, 'README.md'))
  await harness.service.shutdown()
  await store.write({
    ...record,
    slots: record.slots.map((slot) =>
      slot.id === victim.id
        ? { ...slot, state: 'creating' as const, op: { kind: 'create' as const, startedAt: 1, pid: 1 } }
        : slot,
    ),
  })

  // While another live Studio holds the container, nothing is recovered.
  await acquireInstanceLock(container, 'someone-else', { pidAlive: () => true })
  const blocked = makeService({ instanceId: 'blocked' })
  await blocked.service.start()
  await blocked.settle()
  assert.equal(await exists(victim.path), true, 'a pool another Studio holds is left alone')
  await rm(join(container, '.pool.lock'))

  const restarted = makeService()
  await restarted.service.start()
  assert.equal(await exists(victim.path), false)
  assert.equal((await git(repo, 'worktree', 'list')).includes(victim.path), false)
})

test('the owner index names every agent, workspace and path the registry points at', () => {
  const index = worktreePoolOwnerIndex([
    {
      id: 'ws-1',
      folderPath: '/Users/dev/app',
      agents: {
        'agent-1': { execution: { cwd: '/Users/dev/.sprintengine-worktrees/app/pool-01' } },
        'agent-2': { execution: null },
      },
    },
    { id: 'ws-chat', folderPath: '/Users/dev/.sprintengine-worktrees/app/pool-02', agents: {} },
  ])
  assert.deepEqual([...index.agents].sort(), ['agent-1', 'agent-2'])
  assert.deepEqual([...index.workspaces].sort(), ['ws-1', 'ws-chat'])
  assert.deepEqual(index.paths, [
    '/Users/dev/app',
    '/Users/dev/.sprintengine-worktrees/app/pool-01',
    '/Users/dev/.sprintengine-worktrees/app/pool-02',
  ])
})
