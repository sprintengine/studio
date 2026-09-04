import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { captureCheckpoint, checkpointRefFor } from './checkpoint-store'
import { createCheckpointIndex } from './checkpoint-index'
import { getWorkspaceChangeSummary } from './workspace-change-summary'

// The row's honest number (the-diff-an-agent-made / workspace-scoped-row-diff):
// this workspace's agents' work, or an explicitly folder-scoped fallback.

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

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'multicode-change-summary-'))
  git(dir, 'init', '-b', 'main')
  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-m', 'seed')
  return dir
}

function indexIn(): { dir: string; index: ReturnType<typeof createCheckpointIndex> } {
  const dir = mkdtempSync(join(tmpdir(), 'multicode-change-summary-index-'))
  return { dir, index: createCheckpointIndex({ resolveUserDataDir: () => dir }) }
}

void main()

async function main(): Promise<void> {
  await run('a workspace with no checkpoints falls back, and SAYS it fell back', async () => {
    const dir = repo()
    const store = indexIn()
    try {
      // The user's own uncommitted work — nothing to do with any agent.
      writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\nfour\nfive\n')
      const summary = await getWorkspaceChangeSummary(
        { workspaceId: 'w1', folderPath: dir },
        { index: store.index }
      )
      assert.equal(summary.scope, 'folder')
      assert.equal(summary.branch, 'main')
      assert.equal(summary.additions, 2, 'the repo’s numbers, honestly labelled')
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(store.dir, { recursive: true, force: true })
    }
  })

  await run('a baseline alone still falls back — mid-first-turn is not "changed nothing"', async () => {
    const dir = repo()
    const store = indexIn()
    try {
      writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\nfour\n')
      const ref = checkpointRefFor('w1', 0)!
      await captureCheckpoint({ cwd: dir, ref })
      store.index.recordTurn({ workspaceId: 'w1', cwd: dir, turn: 0, ref, at: 1 })

      const summary = await getWorkspaceChangeSummary(
        { workspaceId: 'w1', folderPath: dir },
        { index: store.index }
      )
      // "We have not captured what the agent changed" and "the agent changed
      // nothing" are different claims; only one of them is true here.
      assert.equal(summary.scope, 'folder')
      assert.equal(summary.additions, 1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(store.dir, { recursive: true, force: true })
    }
  })

  await run('once a turn closes the number is the AGENT’s, with the user’s dirt cancelled', async () => {
    const dir = repo()
    const store = indexIn()
    try {
      // The user was already five lines deep in their own work.
      writeFileSync(join(dir, 'mine.txt'), 'a\nb\nc\nd\ne\n')
      const base = checkpointRefFor('w1', 0)!
      await captureCheckpoint({ cwd: dir, ref: base })
      store.index.recordTurn({ workspaceId: 'w1', cwd: dir, turn: 0, ref: base, at: 1 })

      // Then the agent took a turn.
      writeFileSync(join(dir, 'agent.txt'), 'x\ny\n')
      const first = checkpointRefFor('w1', 1)!
      await captureCheckpoint({ cwd: dir, ref: first })
      store.index.recordTurn({ workspaceId: 'w1', cwd: dir, turn: 1, ref: first, at: 2 })

      const summary = await getWorkspaceChangeSummary(
        { workspaceId: 'w1', folderPath: dir },
        { index: store.index }
      )
      assert.equal(summary.scope, 'workspace')
      assert.equal(summary.additions, 2, 'the agent’s two lines, not the user’s seven')
      assert.equal(summary.deletions, 0)
      assert.equal(summary.changedFiles, 1)
      assert.equal(summary.branch, 'main', 'branch stays a folder fact in both scopes')
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(store.dir, { recursive: true, force: true })
    }
  })

  await run('an agent that changed nothing says so, rather than borrowing the repo’s numbers', async () => {
    const dir = repo()
    const store = indexIn()
    try {
      writeFileSync(join(dir, 'mine.txt'), 'a\nb\nc\n')
      const base = checkpointRefFor('w1', 0)!
      await captureCheckpoint({ cwd: dir, ref: base })
      store.index.recordTurn({ workspaceId: 'w1', cwd: dir, turn: 0, ref: base, at: 1 })
      // A turn that touched nothing.
      const first = checkpointRefFor('w1', 1)!
      await captureCheckpoint({ cwd: dir, ref: first })
      store.index.recordTurn({ workspaceId: 'w1', cwd: dir, turn: 1, ref: first, at: 2 })

      const summary = await getWorkspaceChangeSummary(
        { workspaceId: 'w1', folderPath: dir },
        { index: store.index }
      )
      assert.equal(summary.scope, 'workspace', 'epic decision 6: no falling back here')
      assert.equal(summary.additions, 0)
      assert.equal(summary.deletions, 0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(store.dir, { recursive: true, force: true })
    }
  })

  await run('two workspaces on ONE folder no longer show the same numbers', async () => {
    // The bug the owner caught: ten chats on `multicode`, all reading +246 −94.
    const dir = repo()
    const store = indexIn()
    try {
      for (const [workspaceId, lines] of [
        ['w1', 'x\n'],
        ['w2', 'p\nq\nr\n'],
      ] as const) {
        const base = checkpointRefFor(workspaceId, 0)!
        await captureCheckpoint({ cwd: dir, ref: base })
        store.index.recordTurn({ workspaceId, cwd: dir, turn: 0, ref: base, at: 1 })
        writeFileSync(join(dir, `${workspaceId}.txt`), lines)
        const first = checkpointRefFor(workspaceId, 1)!
        await captureCheckpoint({ cwd: dir, ref: first })
        store.index.recordTurn({ workspaceId, cwd: dir, turn: 1, ref: first, at: 2 })
      }

      const one = await getWorkspaceChangeSummary(
        { workspaceId: 'w1', folderPath: dir },
        { index: store.index }
      )
      const two = await getWorkspaceChangeSummary(
        { workspaceId: 'w2', folderPath: dir },
        { index: store.index }
      )
      assert.equal(one.additions, 1)
      assert.equal(two.additions, 3)
      assert.notEqual(one.additions, two.additions, 'each row answers for itself')
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(store.dir, { recursive: true, force: true })
    }
  })

  await run('a checkpoint that no longer resolves falls back — it does NOT report zero', async () => {
    // Review finding: diffCheckpointStat is quiet by design, so a deleted ref,
    // a pruned worktree or a re-clone came back as zeros with scope
    // 'workspace'. The row draws no stat for zeros, so a workspace with real
    // work showed nothing, permanently, with no way back.
    const dir = repo()
    const store = indexIn()
    try {
      const base = checkpointRefFor('w1', 0)!
      await captureCheckpoint({ cwd: dir, ref: base })
      store.index.recordTurn({ workspaceId: 'w1', cwd: dir, turn: 0, ref: base, at: 1 })
      // Tracked, so the FOLDER reading has something to report: `diff` cannot
      // see untracked content, which is the whole reason the git button keeps a
      // file-count fallback.
      writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\nfour\n')
      const first = checkpointRefFor('w1', 1)!
      await captureCheckpoint({ cwd: dir, ref: first })
      store.index.recordTurn({ workspaceId: 'w1', cwd: dir, turn: 1, ref: first, at: 2 })

      // Someone (or a gc, or a re-clone) removed the ref behind our back.
      git(dir, 'update-ref', '-d', first)

      const summary = await getWorkspaceChangeSummary(
        { workspaceId: 'w1', folderPath: dir },
        { index: store.index }
      )
      assert.equal(summary.scope, 'folder', 'unreadable is not "changed nothing"')
      assert.equal(summary.additions, 1, 'and the folder reading is real, not a phantom zero')
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(store.dir, { recursive: true, force: true })
    }
  })

  await run('turns captured in a DIFFERENT working copy are never spanned', async () => {
    // Review finding: two agents in one workspace can run in different
    // checkouts. Spanning across them diffed unrelated trees and produced
    // confident nonsense — a reproduction showed +1 −100 over 11 files for a
    // one-line edit.
    const dir = repo()
    const store = indexIn()
    const other = mkdtempSync(join(tmpdir(), 'multicode-change-summary-other-'))
    try {
      const base = checkpointRefFor('w1', 0)!
      await captureCheckpoint({ cwd: dir, ref: base })
      store.index.recordTurn({ workspaceId: 'w1', cwd: dir, turn: 0, ref: base, at: 1 })

      // A turn recorded against a different working copy entirely.
      const stray = checkpointRefFor('w1', 1)!
      store.index.recordTurn({ workspaceId: 'w1', cwd: other, turn: 1, ref: stray, at: 2 })

      const summary = await getWorkspaceChangeSummary(
        { workspaceId: 'w1', folderPath: dir },
        { index: store.index }
      )
      assert.equal(summary.scope, 'folder', 'no span across two working copies')
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(other, { recursive: true, force: true })
      rmSync(store.dir, { recursive: true, force: true })
    }
  })

  await run('the branch comes from the checkout the NUMBERS came from', async () => {
    const dir = repo()
    const store = indexIn()
    try {
      git(dir, 'checkout', '-b', 'feat/side')
      const base = checkpointRefFor('w1', 0)!
      await captureCheckpoint({ cwd: dir, ref: base })
      store.index.recordTurn({ workspaceId: 'w1', cwd: dir, turn: 0, ref: base, at: 1 })
      writeFileSync(join(dir, 'agent.txt'), 'x\n')
      const first = checkpointRefFor('w1', 1)!
      await captureCheckpoint({ cwd: dir, ref: first })
      store.index.recordTurn({ workspaceId: 'w1', cwd: dir, turn: 1, ref: first, at: 2 })

      const summary = await getWorkspaceChangeSummary(
        { workspaceId: 'w1', folderPath: dir },
        { index: store.index }
      )
      assert.equal(summary.scope, 'workspace')
      assert.equal(summary.branch, 'feat/side')
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(store.dir, { recursive: true, force: true })
    }
  })

  await run('a folder that is not a repo is quiet in both scopes', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'multicode-change-summary-plain-'))
    const store = indexIn()
    try {
      const summary = await getWorkspaceChangeSummary(
        { workspaceId: 'w1', folderPath: plain },
        { index: store.index }
      )
      assert.deepEqual(summary, {
        branch: null,
        additions: 0,
        deletions: 0,
        changedFiles: 0,
        scope: 'folder',
      })
    } finally {
      rmSync(plain, { recursive: true, force: true })
      rmSync(store.dir, { recursive: true, force: true })
    }
  })

  if (failures > 0) {
    console.error(`workspace-change-summary.test.ts: ${failures} failing`)
    process.exit(1)
  }
  console.log('workspace-change-summary.test.ts: ok')
}
