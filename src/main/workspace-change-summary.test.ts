import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readBranchSpan } from './git-branch-span'
import {
  createCheckoutSpanShare,
  getWorkspaceChangeSummary,
  summaryFromSpan,
} from './workspace-change-summary'
import type { BranchSpan } from './git-branch-span'

// The row's honest number (the-diff-an-agent-made / branch-scoped-row-diff):
// what this checkout's branch has produced, and a scope that says how much the
// UI may claim about it.

let failures = 0
async function run(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    console.log(`ok - ${name}`)
  } catch (error) {
    failures += 1
    console.error(`not ok - ${name}`)
    console.error(error)
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.invalid',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.invalid',
    },
  })
}

const created: string[] = []
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'multicode-change-summary-'))
  created.push(dir)
  git(dir, 'init', '-b', 'main')
  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-m', 'seed')
  return dir
}

function span(name: string, patch: Partial<BranchSpan> = {}): BranchSpan {
  return {
    branch: name,
    baseOid: 'base',
    isLinkedWorktree: false,
    aheadOfBase: false,
    stat: { additions: 0, deletions: 0, changedFiles: 0, files: [] },
    ...patch,
  }
}

void (async () => {
  // ---- the scope rule, without a repo ------------------------------------

  await run('a linked worktree claims this chat’s work whatever its branch does', async () => {
    assert.equal(summaryFromSpan(span('feat', { isLinkedWorktree: true })).scope, 'worktree')
    assert.equal(
      summaryFromSpan(span('feat', { isLinkedWorktree: true, aheadOfBase: true })).scope,
      'worktree'
    )
  })

  await run('a shared checkout claims the branch only when it is ahead', async () => {
    assert.equal(summaryFromSpan(span('feat', { aheadOfBase: true })).scope, 'branch')
    assert.equal(summaryFromSpan(span('main', { aheadOfBase: false })).scope, 'folder')
  })

  await run('an unreadable checkout is folder-scoped zeros, never a throw', async () => {
    assert.deepEqual(summaryFromSpan(null), {
      branch: null,
      additions: 0,
      deletions: 0,
      changedFiles: 0,
      scope: 'folder',
    })
  })

  // ---- the reading, against real repos -----------------------------------

  await run('on the default branch the reading is the uncommitted state', async () => {
    const dir = repo()
    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\nfour\n')
    const summary = await getWorkspaceChangeSummary({ checkoutPath: dir })
    assert.equal(summary.scope, 'folder')
    assert.equal(summary.branch, 'main')
    assert.equal(summary.additions, 1)
    assert.equal(summary.deletions, 0)
  })

  await run('a branch reports its commits AND its uncommitted tail', async () => {
    const dir = repo()
    git(dir, 'checkout', '-b', 'feat')
    writeFileSync(join(dir, 'b.txt'), 'x\ny\n')
    git(dir, 'add', '.')
    git(dir, 'commit', '-m', 'committed work')
    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\nfour\n')
    const summary = await getWorkspaceChangeSummary({ checkoutPath: dir })
    assert.equal(summary.scope, 'branch')
    assert.equal(summary.branch, 'feat')
    // 2 committed + 1 uncommitted
    assert.equal(summary.additions, 3)
    assert.equal(summary.changedFiles, 2)
  })

  await run('committing does not change the total — it only moves the tail', async () => {
    const dir = repo()
    git(dir, 'checkout', '-b', 'feat')
    writeFileSync(join(dir, 'b.txt'), 'x\ny\n')
    git(dir, 'add', '.')
    const before = await getWorkspaceChangeSummary({ checkoutPath: dir })
    git(dir, 'commit', '-m', 'now committed')
    const after = await getWorkspaceChangeSummary({ checkoutPath: dir })
    assert.equal(before.additions, after.additions)
    assert.equal(before.deletions, after.deletions)
    assert.equal(before.changedFiles, after.changedFiles)
  })

  // THE regression this epic exists for: the failure that retired the
  // checkpoint model. HEAD moving must not inflate the agent's number.
  await run('HEAD moving under the agent does NOT inflate the reading', async () => {
    const dir = repo()
    git(dir, 'checkout', '-b', 'feat')
    writeFileSync(join(dir, 'b.txt'), 'x\ny\n')
    git(dir, 'add', '.')
    git(dir, 'commit', '-m', 'the agent’s work')
    const before = await getWorkspaceChangeSummary({ checkoutPath: dir })

    // Somebody lands a large change on main and it is merged in — exactly the
    // shape that made the checkpoint span read +14,604 on this repo.
    git(dir, 'checkout', 'main')
    writeFileSync(join(dir, 'big.txt'), Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n'))
    git(dir, 'add', '.')
    git(dir, 'commit', '-m', 'someone else’s 500 lines')
    git(dir, 'checkout', 'feat')
    git(dir, 'merge', '--no-edit', 'main')

    const after = await getWorkspaceChangeSummary({ checkoutPath: dir })
    assert.equal(after.scope, 'branch')
    assert.equal(
      after.additions,
      before.additions,
      'a merge from the default branch moves HEAD and the base together'
    )
  })

  await run('a detached HEAD reports no branch and the folder reading', async () => {
    const dir = repo()
    writeFileSync(join(dir, 'b.txt'), 'x\n')
    git(dir, 'add', '.')
    git(dir, 'commit', '-m', 'second')
    git(dir, 'checkout', '--detach', 'HEAD')
    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\nfour\n')
    const summary = await getWorkspaceChangeSummary({ checkoutPath: dir })
    assert.equal(summary.branch, null)
    assert.equal(summary.scope, 'folder')
    assert.equal(summary.additions, 1, 'still reports the working tree against HEAD')
  })

  await run('a linked worktree is detected and scoped to itself', async () => {
    const dir = repo()
    const tree = join(dir, '..', `wt-${Date.now()}`)
    created.push(tree)
    git(dir, 'worktree', 'add', '-b', 'wt-feat', tree)
    writeFileSync(join(tree, 'c.txt'), 'z\n')
    git(tree, 'add', '.')
    git(tree, 'commit', '-m', 'in the worktree')
    const summary = await getWorkspaceChangeSummary({ checkoutPath: tree })
    assert.equal(summary.scope, 'worktree')
    assert.equal(summary.branch, 'wt-feat')
    assert.equal(summary.additions, 1)
  })

  await run('a repo with no default branch to compare against degrades to folder', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'multicode-change-summary-odd-'))
    created.push(dir)
    git(dir, 'init', '-b', 'solo')
    writeFileSync(join(dir, 'a.txt'), 'one\n')
    git(dir, 'add', '.')
    git(dir, 'commit', '-m', 'seed')
    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n')
    const summary = await getWorkspaceChangeSummary({ checkoutPath: dir })
    assert.equal(summary.scope, 'folder', 'no main/master/origin — nothing to be ahead of')
    assert.equal(summary.branch, 'solo')
    assert.equal(summary.additions, 1)
  })

  await run('an unborn HEAD and a non-repo both degrade quietly', async () => {
    const fresh = mkdtempSync(join(tmpdir(), 'multicode-change-summary-unborn-'))
    created.push(fresh)
    git(fresh, 'init', '-b', 'main')
    writeFileSync(join(fresh, 'a.txt'), 'x\n')
    const unborn = await getWorkspaceChangeSummary({ checkoutPath: fresh })
    assert.equal(unborn.additions, 0)
    assert.equal(unborn.scope, 'folder')

    const plain = mkdtempSync(join(tmpdir(), 'multicode-change-summary-plain-'))
    created.push(plain)
    const notRepo = await getWorkspaceChangeSummary({ checkoutPath: plain })
    assert.deepEqual(notRepo, {
      branch: null,
      additions: 0,
      deletions: 0,
      changedFiles: 0,
      scope: 'folder',
    })

    const gone = await getWorkspaceChangeSummary({ checkoutPath: join(plain, 'nope', 'nowhere') })
    assert.equal(gone.scope, 'folder')
  })

  await run('a repo whose reading fails never reports a confident number', async () => {
    const dir = repo()
    // A ref that cannot resolve is what a pruned worktree or a re-clone leaves.
    const summary = await getWorkspaceChangeSummary({ checkoutPath: join(dir, 'not-a-subdir') })
    assert.equal(summary.scope, 'folder')
    assert.equal(summary.changedFiles, 0)
  })

  // ---- the per-checkout share --------------------------------------------

  await run('rows sharing a checkout share ONE read', async () => {
    let reads = 0
    const share = createCheckoutSpanShare(async () => {
      reads += 1
      return span('feat', { aheadOfBase: true })
    })
    const results = await Promise.all([
      getWorkspaceChangeSummary({ checkoutPath: '/repo' }, { spans: share }),
      getWorkspaceChangeSummary({ checkoutPath: '/repo/' }, { spans: share }),
      getWorkspaceChangeSummary({ checkoutPath: '/repo' }, { spans: share }),
    ])
    assert.equal(reads, 1, 'a trailing slash must not split the share')
    assert.equal(results[0].scope, 'branch')
    assert.equal(results[2].scope, 'branch')
  })

  await run('different checkouts never share, and the hold expires', async () => {
    let reads = 0
    let clock = 0
    const share = createCheckoutSpanShare(
      async () => {
        reads += 1
        return span('feat')
      },
      { holdMs: 100, now: () => clock }
    )
    await share.read('/a')
    await share.read('/b')
    assert.equal(reads, 2, 'two checkouts are two answers')
    await share.read('/a')
    assert.equal(reads, 2, 'still inside the hold')
    clock = 1000
    await share.read('/a')
    assert.equal(reads, 3, 'the next sweep gets a fresh read')
  })

  await run('a rejected read is forgotten immediately, not pinned for the hold', async () => {
    let reads = 0
    const share = createCheckoutSpanShare(async () => {
      reads += 1
      if (reads === 1) throw new Error('spun-down volume')
      return span('feat')
    })
    await assert.rejects(share.read('/a'))
    const second = await share.read('/a')
    assert.equal(reads, 2, 'the failure did not stick to the checkout')
    assert.equal(second?.branch, 'feat')
  })

  await run('readBranchSpan is what the default share reads', async () => {
    const dir = repo()
    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\nfour\n')
    const direct = await readBranchSpan(dir)
    const summary = await getWorkspaceChangeSummary({ checkoutPath: dir })
    assert.equal(direct?.stat.additions, summary.additions)
  })

  for (const dir of created) rmSync(dir, { recursive: true, force: true })

  if (failures > 0) {
    console.error(`workspace-change-summary.test.ts: ${failures} failing`)
    process.exit(1)
  }
  console.log('workspace-change-summary.test.ts: ok')
})()
