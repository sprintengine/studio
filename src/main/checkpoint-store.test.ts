import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CHECKPOINT_REFS_PREFIX,
  captureCheckpoint,
  checkpointRefFor,
  deleteCheckpointRefs,
  diffCheckpointPatch,
  diffCheckpointStat,
  hasCheckpointRef,
  listCheckpointRefs,
  parseNumstatZ,
  turnOfRef,
} from './checkpoint-store'

// The checkpoint store against real repos (the-diff-an-agent-made / 1).
// The invariant under test above all others: a capture must leave the user's
// index and worktree exactly as it found them.

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

const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.invalid',
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...GIT_IDENTITY },
  })
}

function emptyRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'multicode-checkpoint-'))
  git(dir, 'init', '-b', 'main')
  return dir
}

function seededRepo(): string {
  const dir = emptyRepo()
  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-m', 'seed')
  return dir
}

const REF_A = checkpointRefFor('workspace_a', 0)!
const REF_B = checkpointRefFor('workspace_a', 1)!

void main()

async function main(): Promise<void> {
  await run('a capture leaves the user index and worktree byte-identical', async () => {
    const dir = seededRepo()
    try {
      // A staged change and an unstaged one, the state most at risk from a
      // capture that used the real index.
      writeFileSync(join(dir, 'staged.txt'), 'staged\n')
      git(dir, 'add', 'staged.txt')
      writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\nfour\n')

      const statusBefore = git(dir, 'status', '--porcelain=v1')
      const headBefore = git(dir, 'rev-parse', 'HEAD').trim()
      const branchBefore = git(dir, 'symbolic-ref', '--short', 'HEAD').trim()
      // The real index file, not a summary of it: "byte-identical" is the
      // claim, so bytes are what the test compares.
      const indexBefore = readFileSync(join(dir, '.git', 'index'))
      const indexMtimeBefore = statSync(join(dir, '.git', 'index')).mtimeMs

      assert.equal(await captureCheckpoint({ cwd: dir, ref: REF_A }), true)

      assert.ok(
        readFileSync(join(dir, '.git', 'index')).equals(indexBefore),
        'the user index is byte-identical after a capture'
      )
      assert.equal(statSync(join(dir, '.git', 'index')).mtimeMs, indexMtimeBefore, 'and untouched')
      assert.equal(git(dir, 'status', '--porcelain=v1'), statusBefore, 'staging survives capture')
      assert.equal(git(dir, 'rev-parse', 'HEAD').trim(), headBefore, 'HEAD is untouched')
      assert.equal(git(dir, 'symbolic-ref', '--short', 'HEAD').trim(), branchBefore)
      assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'one\ntwo\nthree\nfour\n')

      // ...and the snapshot really did record BOTH pending changes.
      const tree = git(dir, 'ls-tree', '-r', '--name-only', REF_A)
      assert.match(tree, /staged\.txt/, 'the staged file is in the checkpoint')
      const blob = git(dir, 'show', `${REF_A}:a.txt`)
      assert.equal(blob, 'one\ntwo\nthree\nfour\n', 'the unstaged edit is in the checkpoint')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await run('untracked files are captured; ignored files are not', async () => {
    const dir = seededRepo()
    try {
      writeFileSync(join(dir, '.gitignore'), 'ignored.txt\n')
      writeFileSync(join(dir, 'untracked.txt'), 'new\n')
      writeFileSync(join(dir, 'ignored.txt'), 'noise\n')

      assert.equal(await captureCheckpoint({ cwd: dir, ref: REF_A }), true)

      const tree = git(dir, 'ls-tree', '-r', '--name-only', REF_A)
      assert.match(tree, /untracked\.txt/, "an agent's new file is its most visible work")
      assert.doesNotMatch(tree, /ignored\.txt/, 'gitignore still applies')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await run('a repo with no commits yet captures successfully', async () => {
    const dir = emptyRepo()
    try {
      writeFileSync(join(dir, 'first.txt'), 'hello\n')
      assert.equal(await captureCheckpoint({ cwd: dir, ref: REF_A }), true)
      assert.equal(await hasCheckpointRef({ cwd: dir, ref: REF_A }), true)
      assert.match(git(dir, 'ls-tree', '-r', '--name-only', REF_A), /first\.txt/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await run('the diff spans only what changed BETWEEN two captures', async () => {
    const dir = seededRepo()
    try {
      // Dirt the user already had, before either capture. It must cancel.
      writeFileSync(join(dir, 'preexisting.txt'), 'a\nb\nc\nd\ne\n')
      assert.equal(await captureCheckpoint({ cwd: dir, ref: REF_A }), true)

      // Now "the agent" works.
      writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\nfour\n')
      writeFileSync(join(dir, 'agent.txt'), 'x\ny\n')
      assert.equal(await captureCheckpoint({ cwd: dir, ref: REF_B }), true)

      const stat = await diffCheckpointStat({ cwd: dir, fromRef: REF_A, toRef: REF_B })
      assert.equal(stat.additions, 3, 'one line into a.txt plus two into agent.txt')
      assert.equal(stat.deletions, 0)
      assert.equal(stat.changedFiles, 2)
      const paths = stat.files.map((file) => file.path).sort()
      assert.deepEqual(paths, ['a.txt', 'agent.txt'])
      assert.ok(
        !paths.includes('preexisting.txt'),
        'the user’s own dirt sits on both sides and cancels'
      )

      const patch = await diffCheckpointPatch({ cwd: dir, fromRef: REF_A, toRef: REF_B })
      assert.equal(patch.ok, true)
      assert.match(patch.ok ? patch.patch : '', /agent\.txt/)
      assert.doesNotMatch(patch.ok ? patch.patch : '', /preexisting\.txt/)
      // Standard prefixes, whatever the user's diff.noprefix says.
      assert.match(patch.ok ? patch.patch : '', /diff --git a\/agent\.txt b\/agent\.txt/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await run('checkpoints stay out of history, out of branches, and off the remote', async () => {
    const dir = seededRepo()
    const remote = mkdtempSync(join(tmpdir(), 'multicode-checkpoint-remote-'))
    try {
      writeFileSync(join(dir, 'a.txt'), 'changed\n')
      assert.equal(await captureCheckpoint({ cwd: dir, ref: REF_A }), true)

      const commit = git(dir, 'rev-parse', REF_A).trim()

      // The views a person actually reads are clean.
      assert.ok(
        !git(dir, 'log', '--format=%H').includes(commit),
        'the snapshot is not in the branch’s history'
      )
      assert.equal(git(dir, 'branch', '--contains', commit).trim(), '', 'no branch contains it')
      assert.equal(git(dir, 'branch', '--format=%(refname:short)').trim(), 'main')
      assert.equal(git(dir, 'status', '--porcelain=v1').trim(), 'M a.txt')
      // Parentless: never a candidate to merge onto or rebase from.
      assert.equal(git(dir, 'rev-list', '--count', commit).trim(), '1')

      // NOT claimed: invisibility from `git log --all`. `--all` is every ref
      // under refs/, ours included, so a `--all` walk or `gitk --all` DOES list
      // checkpoints. Asserted here so the fact stays known rather than being
      // rediscovered as a surprise.
      assert.ok(
        git(dir, 'log', '--all', '--format=%H').includes(commit),
        '--all really does see them; the epic records this'
      )

      // The one that would actually embarrass us: a default push must not
      // carry snapshots of someone's uncommitted work to a shared remote.
      git(remote, 'init', '--bare')
      git(dir, 'remote', 'add', 'origin', remote)
      git(dir, 'push', '-u', 'origin', 'main')
      const pushedRefs = git(remote, 'for-each-ref', '--format=%(refname)')
      assert.ok(!pushedRefs.includes('multicode'), 'no checkpoint ref reaches the remote')
      assert.ok(pushedRefs.includes('refs/heads/main'), 'the branch itself did push')
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(remote, { recursive: true, force: true })
    }
  })

  await run('no temp index file survives a capture', async () => {
    const dir = seededRepo()
    try {
      writeFileSync(join(dir, 'a.txt'), 'changed\n')
      assert.equal(await captureCheckpoint({ cwd: dir, ref: REF_A }), true)
      const leftovers = readdirSync(join(dir, '.git')).filter((name) =>
        name.startsWith('multicode-checkpoint-index-')
      )
      assert.deepEqual(leftovers, [], 'the temp index is removed in the finally')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await run('listing and deleting a workspace’s refs', async () => {
    const dir = seededRepo()
    try {
      await captureCheckpoint({ cwd: dir, ref: REF_A })
      writeFileSync(join(dir, 'a.txt'), 'changed\n')
      await captureCheckpoint({ cwd: dir, ref: REF_B })
      // A second workspace's ref must not be swept by the first's cleanup.
      const otherRef = checkpointRefFor('workspace_b', 0)
      await captureCheckpoint({ cwd: dir, ref: otherRef })

      const refs = await listCheckpointRefs({ cwd: dir, workspaceId: 'workspace_a' })
      assert.deepEqual(refs.sort(), [REF_A, REF_B].sort())

      await deleteCheckpointRefs({ cwd: dir, refs })
      assert.deepEqual(await listCheckpointRefs({ cwd: dir, workspaceId: 'workspace_a' }), [])
      assert.equal(await hasCheckpointRef({ cwd: dir, ref: otherRef }), true, 'the other workspace survives')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await run('deleteCheckpointRefs refuses anything outside our namespace', async () => {
    const dir = seededRepo()
    try {
      await deleteCheckpointRefs({ cwd: dir, refs: ['refs/heads/main'] })
      assert.equal(
        git(dir, 'branch', '--format=%(refname:short)').trim(),
        'main',
        'a branch is never deletable through the checkpoint cleanup path'
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await run('everything unreadable is a quiet negative, never a throw', async () => {
    const notARepo = mkdtempSync(join(tmpdir(), 'multicode-checkpoint-plain-'))
    try {
      assert.equal(await captureCheckpoint({ cwd: notARepo, ref: REF_A }), false)
      assert.equal(await hasCheckpointRef({ cwd: notARepo, ref: REF_A }), false)
      assert.deepEqual(await diffCheckpointStat({ cwd: notARepo, fromRef: REF_A, toRef: REF_B }), {
        additions: 0,
        deletions: 0,
        changedFiles: 0,
        files: [],
      })
      const unreadable = await diffCheckpointPatch({ cwd: notARepo, fromRef: REF_A, toRef: REF_B })
      assert.equal(unreadable.ok, false)
      assert.equal(unreadable.ok === false ? unreadable.reason : '', 'unreadable')
      assert.deepEqual(await listCheckpointRefs({ cwd: notARepo, workspaceId: 'w' }), [])
    } finally {
      rmSync(notARepo, { recursive: true, force: true })
    }

    const missing = join(tmpdir(), 'multicode-checkpoint-does-not-exist-12345')
    assert.equal(await captureCheckpoint({ cwd: missing, ref: REF_A }), false)

    // A ref that was never written diffs to nothing rather than erroring.
    const dir = seededRepo()
    try {
      assert.deepEqual(await diffCheckpointStat({ cwd: dir, fromRef: REF_A, toRef: REF_B }), {
        additions: 0,
        deletions: 0,
        changedFiles: 0,
        files: [],
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await run('a rename really is captured at its new path', async () => {
    const dir = seededRepo()
    try {
      assert.equal(await captureCheckpoint({ cwd: dir, ref: REF_A }), true)
      git(dir, 'mv', 'a.txt', 'renamed.txt')
      assert.equal(await captureCheckpoint({ cwd: dir, ref: REF_B }), true)

      const stat = await diffCheckpointStat({ cwd: dir, fromRef: REF_A, toRef: REF_B })
      // Exactly the NEW path. The old assertion accepted either, so an
      // implementation reading `oldPath || newPath` would have passed it while
      // contradicting the docstring — and every "open this file" would 404.
      assert.deepEqual(
        stat.files.map((file) => file.path),
        ['renamed.txt']
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await run('the temp index is cleaned up when a LATER step fails, not just on success', async () => {
    const dir = seededRepo()
    try {
      // The whole reason the removal sits in a `finally`. An invalid refname
      // gets through staging, write-tree and commit-tree, then fails at
      // update-ref — the deepest failure the sequence can reach.
      const captured = await captureCheckpoint({ cwd: dir, ref: 'refs/multicode/checkpoints/bad..name' })
      assert.equal(captured, false, 'an invalid refname fails the capture')
      const leftovers = readdirSync(join(dir, '.git')).filter((name) =>
        name.startsWith('multicode-checkpoint-index-')
      )
      assert.deepEqual(leftovers, [], 'and still leaves no temp index behind')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await run('an empty workspace id can never address another workspace’s refs', async () => {
    const dir = seededRepo()
    try {
      await captureCheckpoint({ cwd: dir, ref: REF_A })
      // Without the guard this encodes to the BARE prefix, which for-each-ref
      // reads as "everything under here" — so listing returns every
      // workspace's refs and the delete that follows takes them all.
      assert.deepEqual(await listCheckpointRefs({ cwd: dir, workspaceId: '' }), [])
      await deleteCheckpointRefs({ cwd: dir, refs: [CHECKPOINT_REFS_PREFIX] })
      assert.equal(await hasCheckpointRef({ cwd: dir, ref: REF_A }), true, 'the real ref survives')
      assert.equal(checkpointRefFor('', 0), null)
      // And a non-string id from an untyped caller returns null rather than
      // throwing (or, for an array, coercing into a colliding ref).
      assert.equal(checkpointRefFor(undefined as unknown as string, 0), null)
      assert.equal(checkpointRefFor(['a'] as unknown as string, 0), null)
      assert.equal(checkpointRefFor('w', -1), null)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await run('refs list in TURN order, not git’s lexical order', async () => {
    const dir = seededRepo()
    try {
      // Twelve turns is where lexical and numeric disagree: git returns
      // 0 1 10 11 2 3 …, and the step-through walks this list.
      for (let turn = 0; turn <= 11; turn += 1) {
        writeFileSync(join(dir, 'a.txt'), `turn ${turn}\n`)
        await captureCheckpoint({ cwd: dir, ref: checkpointRefFor('ordered', turn)! })
      }
      const refs = await listCheckpointRefs({ cwd: dir, workspaceId: 'ordered' })
      assert.deepEqual(refs.map(turnOfRef), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
      assert.equal(turnOfRef('refs/multicode/checkpoints/x/turn/7'), 7)
      assert.equal(turnOfRef('not-a-checkpoint-ref'), -1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await run('a linked worktree captures into the shared git dir', async () => {
    // The entire reason capture resolves `--git-common-dir` rather than
    // `--git-dir`: a linked worktree's own dir holds no refs.
    const dir = seededRepo()
    const treePath = join(dir, '..', `multicode-checkpoint-linked-${Date.now()}`)
    try {
      git(dir, 'worktree', 'add', '-b', 'side', treePath)
      writeFileSync(join(treePath, 'a.txt'), 'from the worktree\n')
      assert.equal(await captureCheckpoint({ cwd: treePath, ref: REF_A }), true)
      // Written once, into the shared refs — visible from the main checkout.
      assert.equal(await hasCheckpointRef({ cwd: dir, ref: REF_A }), true)
      assert.match(git(dir, 'show', `${REF_A}:a.txt`), /from the worktree/)
      const leftovers = readdirSync(join(dir, '.git')).filter((name) =>
        name.startsWith('multicode-checkpoint-index-')
      )
      assert.deepEqual(leftovers, [], 'the temp index landed in the common dir and was cleaned')
    } finally {
      git(dir, 'worktree', 'remove', '--force', treePath)
      rmSync(dir, { recursive: true, force: true })
      rmSync(treePath, { recursive: true, force: true })
    }
  })

  await run('a detached HEAD captures like any other checkout', async () => {
    const dir = seededRepo()
    try {
      git(dir, 'checkout', '--detach')
      writeFileSync(join(dir, 'a.txt'), 'detached work\n')
      assert.equal(await captureCheckpoint({ cwd: dir, ref: REF_A }), true)
      assert.match(git(dir, 'show', `${REF_A}:a.txt`), /detached work/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await run('the user’s git hooks do not fire during a capture', async () => {
    const dir = seededRepo()
    const hooks = mkdtempSync(join(tmpdir(), 'multicode-checkpoint-hooks-'))
    try {
      // A reference-transaction hook that mirrored refs would carry snapshots
      // of someone's uncommitted work off-machine — the one thing this module
      // promises cannot happen.
      const marker = join(hooks, 'fired.log')
      for (const hook of ['post-index-change', 'reference-transaction']) {
        const file = join(hooks, hook)
        writeFileSync(file, `#!/bin/sh\necho ${hook} >> ${JSON.stringify(marker)}\n`, 'utf8')
        chmodSync(file, 0o755)
      }
      git(dir, 'config', 'core.hooksPath', hooks)

      writeFileSync(join(dir, 'a.txt'), 'changed\n')
      assert.equal(await captureCheckpoint({ cwd: dir, ref: REF_A }), true)

      const fired = readdirSync(hooks).includes('fired.log')
      assert.equal(fired, false, 'no hook ran during the capture')
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(hooks, { recursive: true, force: true })
    }
  })

  run_parseNumstatZ()

  if (failures > 0) {
    console.error(`checkpoint-store.test.ts: ${failures} failing`)
    process.exit(1)
  }
  console.log('checkpoint-store.test.ts: ok')
}

// The parser's own shapes, spelled directly: the rename form emits three
// NUL-terminated fields rather than two, and binary files report `-`.
function run_parseNumstatZ(): void {
  try {
    const plain = parseNumstatZ('3\t1\tsrc/a.ts\u00002\t0\tsrc/b.ts\u0000')
    assert.deepEqual(plain, {
      additions: 5,
      deletions: 1,
      changedFiles: 2,
      files: [
        { path: 'src/a.ts', additions: 3, deletions: 1 },
        { path: 'src/b.ts', additions: 2, deletions: 0 },
      ],
    })

    // Rename: stats record ends after the trailing tab, then old path, new path.
    const renamed = parseNumstatZ('1\t1\t\u0000old/name.ts\u0000new/name.ts\u00004\t0\tsrc/c.ts\u0000')
    assert.deepEqual(renamed.files, [
      { path: 'new/name.ts', additions: 1, deletions: 1 },
      { path: 'src/c.ts', additions: 4, deletions: 0 },
    ])
    assert.equal(renamed.additions, 5)

    // A binary file changed, but contributed no lines.
    const binary = parseNumstatZ('-\t-\tassets/logo.png\u0000')
    assert.deepEqual(binary, {
      additions: 0,
      deletions: 0,
      changedFiles: 1,
      files: [{ path: 'assets/logo.png', additions: 0, deletions: 0 }],
    })

    assert.deepEqual(parseNumstatZ(''), {
      additions: 0,
      deletions: 0,
      changedFiles: 0,
      files: [],
    })

    // A path containing a newline survives, which is the whole reason for -z.
    const newline = parseNumstatZ('1\t0\tweird\nname.ts\u0000')
    assert.deepEqual(newline.files, [{ path: 'weird\nname.ts', additions: 1, deletions: 0 }])

    assert.equal(checkpointRefFor('w1', 0).startsWith(`${CHECKPOINT_REFS_PREFIX}/`), true)
    assert.doesNotMatch(checkpointRefFor('a/b..c', 3), /\.\./, 'ids are encoded, never interpolated raw')

    console.log('ok - parseNumstatZ handles plain, rename, binary, empty and newline paths')
  } catch (error) {
    failures += 1
    console.error('not ok - parseNumstatZ handles plain, rename, binary, empty and newline paths')
    console.error(error)
  }
}
