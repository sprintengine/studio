/**
 * The agent changelist feed: which checkout a claim lands in, what it refuses to
 * claim, how many store writes a burst of edits costs, and the order the three
 * events come out in when they arrive out of order.
 *
 * The store is STUBBED here — its own behaviour against a real repository is
 * proved in `git-changelists.test.ts`. What is proved here is the wire.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Changelist, ChangelistEdit, ChangelistOwner } from '../shared/git/changelists'
import { createAgentChangelistFeed, type AgentChangelistFeedStore } from './agent-changelist-feed'
import { test } from 'vitest'

test('agent-changelist-feed', async () => {
  const suiteRun = main()

  type StoreCall =
    | { kind: 'ensure'; repoRoot: string; agentId: string; activate: boolean }
    | { kind: 'record'; repoRoot: string; agentId: string; paths: string[]; edits: Array<ChangelistEdit[] | null> }
    | { kind: 'exit'; repoRoot: string; agentId: string }

  function createStubStore(): { store: AgentChangelistFeedStore; calls: StoreCall[]; fail: Set<string> } {
    const calls: StoreCall[] = []
    const fail = new Set<string>()
    const answer = Promise.resolve([] as Changelist[])
    const store: AgentChangelistFeedStore = {
      ensureOwnedChangelist: (_userData, repoRoot, owner: ChangelistOwner, options) => {
        calls.push({ kind: 'ensure', repoRoot, agentId: owner.agentId, activate: options?.activate === true })
        return fail.has('ensure') ? Promise.reject(new Error('no disk')) : answer
      },
      recordAgentEdits: (_userData, repoRoot, owner: ChangelistOwner, batch) => {
        calls.push({
          kind: 'record',
          repoRoot,
          agentId: owner.agentId,
          paths: batch.map((item) => item.path),
          edits: batch.map((item) => item.edits ?? null),
        })
        return fail.has('record') ? Promise.reject(new Error('no disk')) : answer
      },
      markOwnerExited: (_userData, repoRoot, agentId) => {
        calls.push({ kind: 'exit', repoRoot, agentId })
        return fail.has('exit') ? Promise.reject(new Error('no disk')) : answer
      },
    }
    return { store, calls, fail }
  }

  async function main(): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), 'sprintengine-agent-changelist-feed-'))
    const userData = join(root, 'user-data')
    const repo = join(root, 'repo')
    const worktree = join(root, 'worktrees', 'feature')

    try {
      await assertCoalescingAndGuards(userData, repo, worktree, root)
      await assertLinkedWorktreeWins(userData, repo, worktree)
      await assertLaunchAndExitOrder(userData, repo)
      await assertNothingEscapes(userData, repo)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }

    console.log('agent changelist feed ok')
  }

  async function assertCoalescingAndGuards(
    userData: string,
    repo: string,
    worktree: string,
    root: string,
  ): Promise<void> {
    const { store, calls } = createStubStore()
    const broadcasts: string[] = []
    const feed = createAgentChangelistFeed({
      userDataDir: userData,
      store,
      broadcast: (repoRoot) => broadcasts.push(repoRoot),
      resolveRepoRoot: async (directory) => (directory === repo ? repo : null),
      coalesceMs: 5,
    })
    const session = { agentId: 'agent-a', agentName: 'Nadia', workspaceId: 'ws', cwd: repo }
    const edit = (path: string, edits?: ChangelistEdit[]): void =>
      feed.onAgentFileEdit({ session, path, ...(edits ? { edits } : {}), ts: Date.now() })

    // A burst of tool calls is ONE store write and ONE broadcast: an edit frame
    // per tool call would otherwise be a read-modify-write plus a `git status`
    // each, and a renderer refresh each.
    edit(join(repo, 'src/a.ts'), [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2 }])
    edit(join(repo, 'src/b.ts'), [{ oldStart: 4, oldLines: 0, newStart: 5, newLines: 3 }])
    edit(join(repo, 'src/a.ts'))
    await feed.flush()
    const records = calls.filter((call) => call.kind === 'record')
    assert.equal(records.length, 1, 'a burst of edits is one store write')
    assert.deepEqual(
      records[0].kind === 'record' ? records[0].paths : [],
      ['src/a.ts', 'src/b.ts', 'src/a.ts'],
      'in arrival order, repo-relative, and a file edited twice is recorded twice',
    )
    assert.deepEqual(
      records[0].kind === 'record' ? records[0].edits[2] : 'nope',
      null,
      'an edit whose patch the reporter could not read arrives as a file-level claim',
    )
    assert.deepEqual(broadcasts, [repo], 'one write, one broadcast')

    // Not inside the checkout: a subagent's own worktree, or a path outside the
    // repository entirely. Dropped, never guessed at.
    calls.length = 0
    broadcasts.length = 0
    edit(join(worktree, 'src/other.ts'))
    edit(join(root, 'outside.ts'))
    edit('/etc/passwd')
    await feed.flush()
    assert.equal(calls.length, 0, 'a path outside the checkout is not this checkout’s to claim')
    assert.equal(broadcasts.length, 0, 'and nothing is broadcast for a write that never happened')

    // A session with no agent has no list to write into.
    calls.length = 0
    feed.onAgentFileEdit({ session: { cwd: repo }, path: join(repo, 'src/a.ts'), ts: Date.now() })
    feed.onAgentLaunched({ cwd: repo, agentName: 'a plain terminal' })
    feed.onAgentSessionExit({ cwd: repo })
    await feed.flush()
    assert.equal(calls.length, 0, 'a plain terminal never gets an owned changelist')

    // A directory git does not answer for is not a checkout.
    calls.length = 0
    feed.onAgentFileEdit({
      session: { agentId: 'agent-a', cwd: join(root, 'not-a-repo') },
      path: join(root, 'not-a-repo/a.ts'),
      ts: Date.now(),
    })
    await feed.flush()
    assert.equal(calls.length, 0, 'no repository, no claim')

    // Two agents inside one coalescing window keep their order, one store call
    // each, because ownership is last-writer-wins per line.
    calls.length = 0
    const other = { agentId: 'agent-b', agentName: 'Ivo', workspaceId: 'ws', cwd: repo }
    edit(join(repo, 'src/shared.ts'), [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 }])
    feed.onAgentFileEdit({
      session: other,
      path: join(repo, 'src/shared.ts'),
      edits: [{ oldStart: 5, oldLines: 1, newStart: 5, newLines: 1 }],
      ts: Date.now(),
    })
    edit(join(repo, 'src/shared.ts'), [{ oldStart: 9, oldLines: 1, newStart: 9, newLines: 1 }])
    await feed.flush()
    assert.deepEqual(
      calls.map((call) => call.agentId),
      ['agent-a', 'agent-b', 'agent-a'],
      'two agents alternating in one file are applied in the order they arrived',
    )
    feed.dispose()
  }

  /**
   * The checkout an agent's work belongs to is the WORKING TREE its hooks report
   * from — `observedCheckout.gitRoot` — and never `repoRoot`, which for a linked
   * worktree is the primary checkout that owns the common git dir. Filing the
   * claim there would put an agent's lines in a repository whose root the edited
   * paths are not even inside, so the inside-checkout guard would then drop every
   * one of them.
   */
  async function assertLinkedWorktreeWins(userData: string, repo: string, worktree: string): Promise<void> {
    const { store, calls } = createStubStore()
    const feed = createAgentChangelistFeed({
      userDataDir: userData,
      store,
      resolveRepoRoot: async () => repo,
      coalesceMs: 5,
    })
    const session = {
      agentId: 'agent-wt',
      agentName: 'Ivo',
      // Launch intent says the workspace folder; the hooks say the worktree.
      cwd: repo,
      observedCheckout: { resolved: true, gitRoot: worktree, repoRoot: repo },
    }
    feed.onAgentLaunched(session)
    feed.onAgentFileEdit({ session, path: join(worktree, 'src/a.ts'), ts: Date.now() })
    await feed.flush()
    assert.deepEqual(
      calls.map((call) => call.repoRoot),
      [worktree, worktree],
      'the claim lands in the worktree the agent is in, not the repository that owns it',
    )
    assert.deepEqual(
      calls.find((call) => call.kind === 'record')?.kind === 'record'
        ? (calls.find((call) => call.kind === 'record') as { paths: string[] }).paths
        : [],
      ['src/a.ts'],
    )

    // An observation git has not answered for yet is not an answer: launch intent
    // stands until it resolves.
    calls.length = 0
    const unresolved = {
      agentId: 'agent-wt',
      cwd: repo,
      observedCheckout: { resolved: false, gitRoot: null },
    }
    feed.onAgentFileEdit({ session: unresolved, path: join(repo, 'src/b.ts'), ts: Date.now() })
    await feed.flush()
    assert.deepEqual(
      calls.map((call) => call.repoRoot),
      [repo],
      'an unresolved observation falls back to intent',
    )
    feed.dispose()
  }

  /**
   * Launch creates and ACTIVATES; exit marks exited — and an exit that arrives
   * while edits are still behind a coalescing timer must not overtake them. It
   * would mark the list exited, watch reconcile delete it for being empty, and
   * then let the edits rebuild it as a live list belonging to a dead agent.
   */
  async function assertLaunchAndExitOrder(userData: string, repo: string): Promise<void> {
    const { store, calls } = createStubStore()
    const broadcasts: string[] = []
    const feed = createAgentChangelistFeed({
      userDataDir: userData,
      store,
      broadcast: (repoRoot) => broadcasts.push(repoRoot),
      resolveRepoRoot: async () => repo,
      // Long enough that the exit below is genuinely racing a pending timer.
      coalesceMs: 10_000,
    })
    const session = { agentId: 'agent-x', agentName: 'Nadia', workspaceId: 'ws', cwd: repo }

    feed.onAgentLaunched(session)
    feed.onAgentFileEdit({ session, path: join(repo, 'src/a.ts'), ts: Date.now() })
    feed.onAgentSessionExit(session)
    await feed.flush()

    assert.deepEqual(
      calls.map((call) => call.kind),
      ['ensure', 'record', 'exit'],
      'the exit flushes what the agent wrote before it says the agent is gone',
    )
    assert.equal(calls[0].kind === 'ensure' && calls[0].activate, true, 'launching an agent activates its list')
    assert.deepEqual(broadcasts, [repo, repo, repo], 'every write tells the windows once')

    // The exit reaches EVERY checkout the agent wrote into: an agent that made
    // itself a worktree mid-run owns a list in each.
    const second = join(repo, '..', 'second')
    calls.length = 0
    const roaming = { agentId: 'agent-roam', agentName: 'Ivo', cwd: repo }
    feed.onAgentFileEdit({ session: roaming, path: join(repo, 'src/a.ts'), ts: Date.now() })
    feed.onAgentFileEdit({
      session: { ...roaming, observedCheckout: { resolved: true, gitRoot: second } },
      path: join(second, 'src/b.ts'),
      ts: Date.now(),
    })
    feed.onAgentSessionExit({ ...roaming, observedCheckout: { resolved: true, gitRoot: second } })
    await feed.flush()
    assert.deepEqual(
      calls
        .filter((call) => call.kind === 'exit')
        .map((call) => call.repoRoot)
        .sort(),
      [repo, second].sort(),
      'both checkouts hear that the agent has gone',
    )
    feed.dispose()
  }

  /** The runtime calls this feed from inside a pty exit handler and an ingest
   *  path. Nothing it does may throw, and nothing may be written after quit. */
  async function assertNothingEscapes(userData: string, repo: string): Promise<void> {
    const { store, calls, fail } = createStubStore()
    const warnings: string[] = []
    const feed = createAgentChangelistFeed({
      userDataDir: userData,
      store,
      broadcast: () => {
        throw new Error('a window went away mid-broadcast')
      },
      resolveRepoRoot: async () => repo,
      coalesceMs: 5,
      logWarning: (message) => warnings.push(message),
    })
    const session = { agentId: 'agent-fail', agentName: 'Nadia', cwd: repo }

    fail.add('ensure')
    fail.add('record')
    fail.add('exit')
    feed.onAgentLaunched(session)
    feed.onAgentFileEdit({ session, path: join(repo, 'src/a.ts'), ts: Date.now() })
    feed.onAgentSessionExit(session)
    await feed.flush()
    assert.equal(calls.length, 3, 'every call was still attempted')
    assert.equal(warnings.length >= 3, true, 'and every failure was logged rather than thrown')

    // A resolver that rejects is a failure like any other.
    const rejecting = createAgentChangelistFeed({
      userDataDir: userData,
      store,
      resolveRepoRoot: async () => {
        throw new Error('git is gone')
      },
      coalesceMs: 5,
      logWarning: (message) => warnings.push(message),
    })
    rejecting.onAgentFileEdit({ session, path: join(repo, 'src/a.ts'), ts: Date.now() })
    await rejecting.flush()
    rejecting.dispose()

    // App quit: whatever was coalescing is dropped, and nothing new is taken.
    const { store: quitStore, calls: quitCalls } = createStubStore()
    const quitting = createAgentChangelistFeed({
      userDataDir: userData,
      store: quitStore,
      resolveRepoRoot: async () => repo,
      coalesceMs: 10_000,
    })
    quitting.onAgentFileEdit({ session, path: join(repo, 'src/a.ts'), ts: Date.now() })
    await new Promise((resolve) => setTimeout(resolve, 5))
    quitting.dispose()
    quitting.onAgentLaunched(session)
    quitting.onAgentFileEdit({ session, path: join(repo, 'src/b.ts'), ts: Date.now() })
    quitting.onAgentSessionExit(session)
    await quitting.flush()
    assert.equal(quitCalls.length, 0, 'a disposed feed writes nothing, before or after')

    feed.dispose()
  }

  await suiteRun
})
