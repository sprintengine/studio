import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readFileHunks, stageGitHunk, unstageGitHunk } from './git-hunks'
import type { GitFileHunks, GitHunkRef } from '../shared/git/hunks'
import { test } from 'vitest'

test('git-hunks', async () => {
  // Per-hunk staging against a real repository (git-commit-window T7). Everything
  // asserted here is a claim about the INDEX after the call — `git diff --cached`
  // and `git show :path` — because "no throw" is not evidence that the right
  // lines went in.

  const suiteRun = main()

  async function main(): Promise<void> {
    await assertTwoHunksStageIndependently()
    await assertOffsetsAreRecomputedEveryTime()
    await assertNewFileAndDeletion()
    await assertCrlfSurvives()
    await assertBinaryAndUntrackedRefuse()
    await assertRefusals()
    await assertPersonalDiffConfigCannotBreakIt()
    await assertAwkwardNames()
    console.log('git-hunks.test.ts: ok')
  }

  /* ── harness ──────────────────────────────────────────────────────────────── */

  function git(cwd: string, args: string[]): string {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
  }

  function makeRepo(name: string): { root: string; repo: string } {
    const root = mkdtempSync(join(tmpdir(), `sprintengine-git-hunks-${name}-`))
    const repo = join(root, 'repo')
    execFileSync('git', ['init', '--quiet', '--initial-branch=main', repo], { encoding: 'utf8' })
    git(repo, ['config', 'user.email', 'test@example.com'])
    git(repo, ['config', 'user.name', 'Test'])
    git(repo, ['config', 'commit.gpgsign', 'false'])
    return { root, repo }
  }

  function status(repo: string, path: string): string {
    return git(repo, ['status', '--porcelain=v1', '--', path]).trimEnd()
  }

  async function hunksOf(repo: string, path: string, scope: 'staged' | 'unstaged'): Promise<GitFileHunks> {
    const result = await readFileHunks(repo, join(repo, path), scope)
    assert.equal(result.ok, true, !result.ok ? result.message : '')
    return result as GitFileHunks
  }

  function refFor(repo: string, path: string, file: GitFileHunks, index: number): GitHunkRef {
    const hunk = file.hunks[index]
    assert.ok(hunk, `hunk ${index} exists`)
    return {
      repoRoot: repo,
      filePath: join(repo, path),
      // The hunk's OWN diff, not the one the viewer asked for: the result is the
      // UNION of both, and a toggle is defined by the side the hunk is on.
      scope: hunk.scope,
      index: hunk.index,
      fingerprint: hunk.fingerprint,
    }
  }

  /** The one hunk on the given side of the index. */
  function only(file: GitFileHunks, included: boolean): number {
    const matches = file.hunks.map((hunk, at) => ({ hunk, at })).filter((entry) => entry.hunk.included === included)
    assert.equal(matches.length, 1, `exactly one ${included ? 'included' : 'excluded'} hunk`)
    return matches[0].at
  }

  /* ── the acceptance case ──────────────────────────────────────────────────── */

  async function assertTwoHunksStageIndependently(): Promise<void> {
    const { root, repo } = makeRepo('two')
    try {
      writeFileSync(join(repo, 'f.txt'), 'a\nb\nc\nd\ne\n')
      git(repo, ['add', 'f.txt'])
      git(repo, ['commit', '--quiet', '-m', 'base'])
      // Line 1 rewritten, line 3 removed: two hunks, and they are not adjacent.
      writeFileSync(join(repo, 'f.txt'), 'A\nb\nd\ne\n')

      const before = await hunksOf(repo, 'f.txt', 'unstaged')
      assert.equal(before.unsupported, null)
      assert.equal(before.hunks.length, 2)
      assert.deepEqual(before.summary, { total: 2, included: 0 })
      assert.equal(
        before.hunks.every((hunk) => hunk.included === false),
        true,
      )
      // The deletion's box is drawn above the gap, on the last surviving line.
      assert.deepEqual(
        { newStart: before.hunks[1].newStart, newLines: before.hunks[1].newLines },
        { newStart: 2, newLines: 0 },
      )

      // Include the SECOND hunk only.
      const staged = await stageGitHunk(refFor(repo, 'f.txt', before, 1))
      assert.equal(staged.ok, true, staged.message ?? staged.stderr)

      // The index has exactly that change and nothing else.
      assert.equal(git(repo, ['show', ':f.txt']), 'a\nb\nd\ne\n')
      // `MM` is the whole of T7's fourth part. `git status` now reports the file
      // as both staged and unstaged, which is what `entryCheckedState` in the Git
      // panel's model already turns into `'mixed'` and `includeBoxState` in the
      // diff window's already turns into the dash — so both checkboxes go
      // indeterminate on their own, with no wiring from here to either of them.
      assert.equal(status(repo, 'f.txt'), 'MM f.txt')

      // And the counter now says one of two, from both sides of the file — while
      // BOTH boxes stay on screen, whichever text the viewer is showing. This is
      // the whole of the union: a box that vanished when it was ticked left the
      // person no way to take that hunk back out again.
      const afterUnstaged = await hunksOf(repo, 'f.txt', 'unstaged')
      assert.deepEqual(afterUnstaged.summary, { total: 2, included: 1 })
      assert.equal(afterUnstaged.hunks.length, 2)
      // In file order by their new-side line: the line-1 rewrite is still in the
      // working tree, the line-3 deletion is now in the index.
      assert.deepEqual(
        afterUnstaged.hunks.map((hunk) => hunk.included),
        [false, true],
      )
      assert.deepEqual(
        afterUnstaged.hunks.map((hunk) => hunk.scope),
        ['unstaged', 'staged'],
      )
      const afterStaged = await hunksOf(repo, 'f.txt', 'staged')
      assert.deepEqual(afterStaged.summary, { total: 2, included: 1 })
      assert.equal(afterStaged.hunks.length, 2, 'the same two boxes, from the other text')
      assert.deepEqual(
        afterStaged.hunks.map((hunk) => hunk.fingerprint),
        afterUnstaged.hunks.map((hunk) => hunk.fingerprint),
        'and they are the same two hunks either way',
      )

      // Toggling it back restores the index exactly — from the UNSTAGED view,
      // which is where the person is standing and where the old code offered no
      // box for this hunk at all.
      const undone = await unstageGitHunk(refFor(repo, 'f.txt', afterUnstaged, only(afterUnstaged, true)))
      assert.equal(undone.ok, true, undone.message ?? undone.stderr)
      assert.equal(git(repo, ['show', ':f.txt']), 'a\nb\nc\nd\ne\n')
      assert.equal(status(repo, 'f.txt'), ' M f.txt')
      const restored = await hunksOf(repo, 'f.txt', 'unstaged')
      assert.deepEqual(restored.summary, { total: 2, included: 0 })
      assert.equal(restored.hunks.length, 2)
      assert.equal(
        restored.hunks.every((hunk) => hunk.included === false),
        true,
      )
      console.log('ok - one hunk of two goes into the index, and comes back out')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }

  async function assertOffsetsAreRecomputedEveryTime(): Promise<void> {
    const { root, repo } = makeRepo('offsets')
    try {
      writeFileSync(join(repo, 'f.txt'), '1\n2\n3\n4\n5\n6\n7\n8\n')
      git(repo, ['add', 'f.txt'])
      git(repo, ['commit', '--quiet', '-m', 'base'])
      // Two removals near the top, so staging the first moves the second's line
      // numbers on BOTH sides of the remaining diff.
      writeFileSync(join(repo, 'f.txt'), '2\n3\n5\n6\n7\n8\n')

      const before = await hunksOf(repo, 'f.txt', 'unstaged')
      assert.equal(before.hunks.length, 2)
      const secondFingerprint = before.hunks[1].fingerprint
      const secondOldStart = before.hunks[1].oldStart

      assert.equal((await stageGitHunk(refFor(repo, 'f.txt', before, 0))).ok, true)
      const after = await hunksOf(repo, 'f.txt', 'unstaged')
      assert.equal(after.hunks.length, 2, 'both sides of the index are drawn')
      const survivor = after.hunks[only(after, false)]
      assert.notEqual(
        survivor.oldStart,
        secondOldStart,
        'the surviving hunk must have moved, or this test is not testing anything',
      )
      assert.equal(survivor.fingerprint, secondFingerprint, 'and its identity must not have')

      // A caller holding the ORIGINAL ref — stale index, stale offsets, right
      // body — still stages the right lines, because the body is the identity.
      const stale: GitHunkRef = {
        repoRoot: repo,
        filePath: join(repo, 'f.txt'),
        scope: 'unstaged',
        index: 1,
        fingerprint: secondFingerprint,
      }
      const staged = await stageGitHunk(stale)
      assert.equal(staged.ok, true, staged.message ?? staged.stderr)
      assert.equal(git(repo, ['show', ':f.txt']), '2\n3\n5\n6\n7\n8\n')
      assert.equal(status(repo, 'f.txt'), 'M  f.txt')
      console.log('ok - a hunk whose line numbers moved is still the hunk that was asked for')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }

  async function assertNewFileAndDeletion(): Promise<void> {
    const { root, repo } = makeRepo('lifecycle')
    try {
      writeFileSync(join(repo, 'keep.txt'), 'k\n')
      writeFileSync(join(repo, 'gone.txt'), 'g1\ng2\n')
      git(repo, ['add', '.'])
      git(repo, ['commit', '--quiet', '-m', 'base'])

      // A file staged for creation: one hunk, no `a/` side, and taking it out
      // takes the whole file out of the index.
      writeFileSync(join(repo, 'new.txt'), 'n1\nn2\n')
      git(repo, ['add', 'new.txt'])
      const created = await hunksOf(repo, 'new.txt', 'staged')
      assert.equal(created.unsupported, null)
      assert.equal(created.hunks.length, 1)
      assert.deepEqual(created.summary, { total: 1, included: 1 })
      const removed = await unstageGitHunk(refFor(repo, 'new.txt', created, 0))
      assert.equal(removed.ok, true, removed.message ?? removed.stderr)
      assert.equal(status(repo, 'new.txt'), '?? new.txt')

      // A deletion in the working tree: one hunk, `+++ /dev/null`, and including
      // it stages the removal.
      unlinkSync(join(repo, 'gone.txt'))
      const deleted = await hunksOf(repo, 'gone.txt', 'unstaged')
      assert.equal(deleted.hunks.length, 1)
      assert.deepEqual(deleted.summary, { total: 1, included: 0 })
      const stagedDeletion = await stageGitHunk(refFor(repo, 'gone.txt', deleted, 0))
      assert.equal(stagedDeletion.ok, true, stagedDeletion.message ?? stagedDeletion.stderr)
      assert.equal(git(repo, ['diff', '--cached', '--name-status']).trim(), 'D\tgone.txt')
      console.log('ok - a created file and a deleted one both toggle whole')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }

  async function assertCrlfSurvives(): Promise<void> {
    const { root, repo } = makeRepo('crlf')
    try {
      writeFileSync(join(repo, 'c.txt'), 'x\r\ny\r\nz\r\n')
      git(repo, ['add', 'c.txt'])
      git(repo, ['commit', '--quiet', '-m', 'base'])
      writeFileSync(join(repo, 'c.txt'), 'x\r\nY\r\nz\r\n')

      const file = await hunksOf(repo, 'c.txt', 'unstaged')
      assert.equal(file.hunks.length, 1)
      // The `\r` is content: a patch that dropped it would not match the index,
      // and one that kept it as a line ending would rewrite the whole file.
      assert.equal(file.hunks[0].fingerprint, '-y\r\n+Y\r')
      const staged = await stageGitHunk(refFor(repo, 'c.txt', file, 0))
      assert.equal(staged.ok, true, staged.message ?? staged.stderr)
      assert.equal(git(repo, ['show', ':c.txt']), 'x\r\nY\r\nz\r\n')
      console.log('ok - a CRLF file goes into the index byte for byte')

      // A file whose last line has no newline: the `\ No newline` marker must
      // travel with the hunk or the index gains a newline nobody typed.
      writeFileSync(join(repo, 'n.txt'), 'p\nq')
      git(repo, ['add', 'n.txt'])
      git(repo, ['commit', '--quiet', '-m', 'no-eol'])
      writeFileSync(join(repo, 'n.txt'), 'p\nQ')
      const noEol = await hunksOf(repo, 'n.txt', 'unstaged')
      const stagedNoEol = await stageGitHunk(refFor(repo, 'n.txt', noEol, 0))
      assert.equal(stagedNoEol.ok, true, stagedNoEol.message ?? stagedNoEol.stderr)
      assert.equal(git(repo, ['show', ':n.txt']), 'p\nQ')
      console.log('ok - a file with no trailing newline does not gain one')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }

  async function assertBinaryAndUntrackedRefuse(): Promise<void> {
    const { root, repo } = makeRepo('refuse')
    try {
      writeFileSync(join(repo, 'b.bin'), Buffer.from([0x61, 0x00, 0x62, 0x0a]))
      git(repo, ['add', 'b.bin'])
      git(repo, ['commit', '--quiet', '-m', 'base'])
      writeFileSync(join(repo, 'b.bin'), Buffer.from([0x61, 0x00, 0x63, 0x0a]))

      const binary = await hunksOf(repo, 'b.bin', 'unstaged')
      assert.equal(binary.unsupported, 'binary')
      assert.equal(binary.hunks.length, 0)
      // Null, not `{ total: 0 }`: a binary file HAS a difference, and a counter
      // that said "No differences" beside a changed file would be lying.
      assert.equal(binary.summary, null)
      const refused = await stageGitHunk({
        repoRoot: repo,
        filePath: join(repo, 'b.bin'),
        scope: 'unstaged',
        index: 0,
        fingerprint: '',
      })
      assert.equal(refused.ok, false)
      assert.match(refused.message ?? '', /binary/i)

      writeFileSync(join(repo, 'u.txt'), 'u\n')
      const untracked = await hunksOf(repo, 'u.txt', 'unstaged')
      assert.equal(untracked.unsupported, 'untracked')
      assert.equal(untracked.summary, null)
      console.log("ok - a binary file refuses with git's reason; an untracked one has no hunks to offer")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }

  async function assertRefusals(): Promise<void> {
    const { root, repo } = makeRepo('guards')
    try {
      writeFileSync(join(repo, 'f.txt'), 'a\nb\n')
      git(repo, ['add', 'f.txt'])
      git(repo, ['commit', '--quiet', '-m', 'base'])
      writeFileSync(join(repo, 'f.txt'), 'A\nb\n')
      const file = await hunksOf(repo, 'f.txt', 'unstaged')
      const ref = refFor(repo, 'f.txt', file, 0)

      // A hunk that is no longer in the diff — someone else staged it, or the
      // file was reverted — is refused, not applied at the position it used to be.
      const gone = await stageGitHunk({ ...ref, fingerprint: '-nothing\n+like it' })
      assert.equal(gone.ok, false)
      assert.match(gone.message ?? '', /no longer there/)

      // The two directions are not interchangeable: each is defined by which diff
      // named the hunk, so a scope that does not match the verb is a bug upstream.
      assert.equal((await stageGitHunk({ ...ref, scope: 'staged' })).ok, false)
      assert.equal((await unstageGitHunk({ ...ref, scope: 'unstaged' })).ok, false)

      // A path that climbs out of the repository is refused before git sees it.
      const outside = await readFileHunks(repo, join(root, 'elsewhere.txt'), 'unstaged')
      assert.equal(outside.ok, false)
      assert.match((outside as { message: string }).message, /not in this repository/)
      const outsideWrite = await stageGitHunk({ ...ref, filePath: join(root, 'elsewhere.txt') })
      assert.equal(outsideWrite.ok, false)
      console.log('ok - a stale hunk, a mismatched scope and a path outside the repo are all refused')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }

  async function assertAwkwardNames(): Promise<void> {
    const { root, repo } = makeRepo('names')
    try {
      // A path IS a pathspec to git, and `[id]` is a character class. Without
      // `:(literal)` this file's diff is whatever else happens to match.
      execFileSync('mkdir', ['-p', join(repo, 'pages')])
      writeFileSync(join(repo, 'pages', '[id].tsx'), 'a\nb\nc\n')
      writeFileSync(join(repo, 'pages', 'xid.tsx'), 'other\n')
      writeFileSync(join(repo, 'old.txt'), 'r1\nr2\nr3\nr4\nr5\nr6\n')
      git(repo, ['add', '.'])
      git(repo, ['commit', '--quiet', '-m', 'base'])

      writeFileSync(join(repo, 'pages', '[id].tsx'), 'A\nb\nC\n')
      const bracketed = await hunksOf(repo, 'pages/[id].tsx', 'unstaged')
      assert.equal(bracketed.hunks.length, 2)
      const staged = await stageGitHunk(refFor(repo, 'pages/[id].tsx', bracketed, 0))
      assert.equal(staged.ok, true, staged.message ?? staged.stderr)
      assert.equal(git(repo, ['show', ':pages/[id].tsx']), 'A\nb\nc\n')

      // A rename WITH a content change. Rename detection is off, so this is a new
      // file at the new path — and every one of its hunks can go in without the
      // first one carrying a rename the rest would then trip over.
      execFileSync('mv', [join(repo, 'old.txt'), join(repo, 'new.txt')])
      writeFileSync(join(repo, 'new.txt'), 'R1\nr2\nr3\nr4\nr5\nR6\n')
      git(repo, ['add', '--', 'new.txt', 'old.txt'])
      const renamed = await hunksOf(repo, 'new.txt', 'staged')
      assert.equal(renamed.hunks.length, 1, 'without rename detection the new path is one whole addition')
      const back = await unstageGitHunk(refFor(repo, 'new.txt', renamed, 0))
      assert.equal(back.ok, true, back.message ?? back.stderr)
      assert.equal(status(repo, 'new.txt'), '?? new.txt')
      console.log('ok - a bracketed path is a path, and a rename is two files that each behave')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }

  async function assertPersonalDiffConfigCannotBreakIt(): Promise<void> {
    const { root, repo } = makeRepo('config')
    try {
      writeFileSync(join(repo, 'f.txt'), 'a\nb\n')
      git(repo, ['add', 'f.txt'])
      git(repo, ['commit', '--quiet', '-m', 'base'])
      // Two settings a person may well have, both of which change the header
      // `git apply -p1` reads. If the diff were not pinned, the patch built from
      // it would be applied to a file called `f.txt` with no prefix to strip.
      git(repo, ['config', 'diff.noprefix', 'true'])
      git(repo, ['config', 'diff.mnemonicPrefix', 'true'])
      git(repo, ['config', 'color.ui', 'always'])
      writeFileSync(join(repo, 'f.txt'), 'A\nb\n')

      const file = await hunksOf(repo, 'f.txt', 'unstaged')
      assert.equal(file.hunks.length, 1)
      const staged = await stageGitHunk(refFor(repo, 'f.txt', file, 0))
      assert.equal(staged.ok, true, staged.message ?? staged.stderr)
      assert.equal(git(repo, ['show', ':f.txt']), 'A\nb\n')
      console.log("ok - the person's own diff settings cannot break the patch")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }

  await suiteRun
})
