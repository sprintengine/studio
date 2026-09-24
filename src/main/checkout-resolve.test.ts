import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import {
  MISSING_DIRECTORY,
  NOT_A_CHECKOUT,
  branchFromHeadFile,
  clearCheckoutResolveMemo,
  hostCwdForResolution,
  parseCommonGitDir,
  resolveCheckoutForCwd,
} from './checkout-resolve'
import { gitSpawnCounter } from './git-run'
import { test } from 'vitest'

test('the branch is read from the HEAD file, and anything unfamiliar goes back to git', () => {
  assert.equal(branchFromHeadFile('ref: refs/heads/main\n'), 'main')
  assert.equal(branchFromHeadFile('ref: refs/heads/agent/fix-x\n'), 'agent/fix-x')
  assert.equal(branchFromHeadFile('0123456789abcdef0123456789abcdef01234567\n'), null, 'detached')
  assert.equal(branchFromHeadFile('ref: refs/heads/.invalid\n'), undefined, 'a reftable placeholder asks git')
  assert.equal(branchFromHeadFile('ref: refs/remotes/origin/main\n'), undefined)
  assert.equal(branchFromHeadFile(null), undefined, 'an unreadable file asks git')
})

test('checkout-resolve', async () => {
  const execFileAsync = promisify(execFile)

  // The resolver's job is to turn a hook-reported cwd into "which checkout is
  // this?" — primary, linked worktree, or none — on a REAL git layout, since the
  // facts it reads (common dir vs own git dir, toplevel realpath) are exactly
  // the ones a mocked git would have to fake.

  async function git(cwd: string, ...args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'test',
        GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'test',
        GIT_COMMITTER_EMAIL: 'test@example.com',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
      },
    })
    return stdout.trim()
  }

  function assertHostPathTranslation(): void {
    // Windows main, WSL-launched CLI: the mounted drive translates back; a path
    // inside the WSL filesystem cannot be answered from the Windows side.
    assert.equal(hostCwdForResolution('/mnt/c/Users/me/proj', 'win32'), 'C:/Users/me/proj')
    assert.equal(hostCwdForResolution('/mnt/d', 'win32'), 'D:/')
    assert.equal(
      hostCwdForResolution('/home/me/proj', 'win32'),
      null,
      'a WSL-internal path is unresolvable from Windows',
    )
    assert.equal(hostCwdForResolution('C:\\Users\\me\\proj', 'win32'), 'C:\\Users\\me\\proj')
    assert.equal(hostCwdForResolution('\\\\server\\share\\proj', 'win32'), '\\\\server\\share\\proj')
    // POSIX main: POSIX paths pass through; a Windows-form path is unanswerable.
    assert.equal(hostCwdForResolution('/Users/me/proj', 'darwin'), '/Users/me/proj')
    assert.equal(
      hostCwdForResolution('/mnt/c/Users/me', 'linux'),
      '/mnt/c/Users/me',
      'on Linux /mnt/c is just a directory',
    )
    assert.equal(hostCwdForResolution('C:/Users/me', 'linux'), null)
    assert.equal(hostCwdForResolution('C:\\Users\\me', 'darwin'), null)
  }

  function assertCommonGitDirParsing(): void {
    // git ≥ 2.31 answers absolute; older git ECHOES the unknown --path-format
    // flag with exit 0, which must read as "unsupported", never as a path.
    assert.equal(parseCommonGitDir('/repo/.git\n', '/repo/src'), '/repo/.git')
    assert.equal(parseCommonGitDir('--path-format=absolute\n.git\n', '/repo'), null, 'an echoed flag is not a path')
    assert.equal(
      parseCommonGitDir('.git\n', '/repo'),
      '/repo/.git',
      'relative answers resolve against the cwd git ran in',
    )
    assert.equal(parseCommonGitDir('../.git\n', '/repo/src'), '/repo/.git')
    assert.equal(parseCommonGitDir('', '/repo'), null)
  }

  async function run(): Promise<void> {
    assertHostPathTranslation()
    assertCommonGitDirParsing()
    const scratch = await mkdtemp(join(tmpdir(), 'sprintengine-checkout-resolve-'))
    try {
      // --- a primary checkout ---------------------------------------------
      const repo = join(scratch, 'repo')
      await mkdir(repo, { recursive: true })
      await git(repo, 'init', '-q', '-b', 'main')
      await writeFile(join(repo, 'README.md'), '# repo\n')
      await git(repo, 'add', 'README.md')
      await git(repo, 'commit', '-q', '-m', 'init')
      // macOS `/tmp` is a symlink to `/private/tmp`; git reports realpaths, and
      // so must the facts (the renderer matches on gitRoot, never the raw cwd).
      const realRepo = await realpath(repo)

      const primary = await resolveCheckoutForCwd(repo)
      assert.ok(primary, 'a primary checkout resolves')
      assert.equal(primary.gitRoot, realRepo, 'gitRoot is the realpath toplevel')
      assert.equal(primary.repoRoot, realRepo, 'a primary checkout is its own repo root')
      assert.equal(primary.branch, 'main')
      assert.equal(primary.isLinkedWorktree, false)

      // A subdirectory of the checkout resolves to the same facts: the agent's
      // cwd drifting into `src/` is still the same checkout.
      const sub = join(repo, 'src', 'deep')
      await mkdir(sub, { recursive: true })
      const fromSub = await resolveCheckoutForCwd(sub)
      assert.deepEqual(fromSub, primary, 'a subdirectory resolves to the checkout that contains it')

      // --- a linked worktree ------------------------------------------------
      const worktree = join(scratch, 'wt', 'feature-x')
      await mkdir(join(scratch, 'wt'), { recursive: true })
      await git(repo, 'worktree', 'add', '-q', '-b', 'feature/x', worktree)
      const realWorktree = await realpath(worktree)

      const linked = await resolveCheckoutForCwd(worktree)
      assert.ok(linked)
      assert.equal(linked.gitRoot, realWorktree, 'the worktree is its own toplevel')
      assert.equal(linked.isLinkedWorktree, true, 'git worktree add makes a linked worktree')
      assert.equal(linked.repoRoot, realRepo, 'a linked worktree points back at the primary checkout')
      assert.equal(linked.branch, 'feature/x')

      // Detached HEAD inside the worktree: still the same worktree, no branch.
      await git(worktree, 'checkout', '-q', '--detach')
      const detached = await resolveCheckoutForCwd(worktree)
      assert.equal(detached?.branch, null, 'a detached HEAD has no branch')
      assert.equal(detached?.isLinkedWorktree, true)

      // A branch change in place is visible to a re-resolution — this is why
      // the runtime re-resolves on every turn end, not only on a cwd change.
      await git(worktree, 'checkout', '-q', 'feature/x')
      assert.equal((await resolveCheckoutForCwd(worktree))?.branch, 'feature/x')

      // A turn end with no branch move is answered from HEAD's stat alone:
      // no git process at all.
      const spawnsBefore = gitSpawnCounter.read + gitSpawnCounter.write + gitSpawnCounter.network
      assert.equal((await resolveCheckoutForCwd(worktree))?.branch, 'feature/x')
      assert.deepEqual(await resolveCheckoutForCwd(repo), primary)
      assert.equal(
        gitSpawnCounter.read + gitSpawnCounter.write + gitSpawnCounter.network,
        spawnsBefore,
        'an unchanged HEAD costs no git',
      )
      // ...and a switch made by someone else is still seen, because it moves HEAD.
      await git(repo, 'switch', '-q', '-c', 'side')
      assert.equal((await resolveCheckoutForCwd(repo))?.branch, 'side')
      await git(repo, 'switch', '-q', 'main')
      assert.equal((await resolveCheckoutForCwd(repo))?.branch, 'main')

      // --- not a checkout ---------------------------------------------------
      const plain = join(scratch, 'plain')
      await mkdir(plain, { recursive: true })
      assert.deepEqual(
        await resolveCheckoutForCwd(plain),
        NOT_A_CHECKOUT,
        'a directory outside every repository is a plain folder, not "unknown"',
      )

      // A removed worktree (pruned out from under the agent) is a folder that
      // no longer exists — reported as not a checkout, never as a git failure.
      await rm(worktree, { recursive: true, force: true })
      assert.deepEqual(
        await resolveCheckoutForCwd(worktree),
        MISSING_DIRECTORY,
        'a vanished cwd is reported missing, not as a folder',
      )

      // Inside the `.git` directory itself there is no work tree.
      assert.deepEqual(
        await resolveCheckoutForCwd(join(repo, '.git')),
        NOT_A_CHECKOUT,
        'the .git directory is not a work tree',
      )

      // --- GIT_DIR leaking from the app's environment ------------------------
      // With GIT_DIR exported, git answers for THAT repo from any directory; the
      // resolver clears it so a plain folder stays a plain folder.
      const originalGitDir = process.env.GIT_DIR
      process.env.GIT_DIR = join(repo, '.git')
      try {
        assert.deepEqual(
          await resolveCheckoutForCwd(plain),
          NOT_A_CHECKOUT,
          'an inherited GIT_DIR must not make a folder a checkout',
        )
      } finally {
        if (originalGitDir === undefined) delete process.env.GIT_DIR
        else process.env.GIT_DIR = originalGitDir
      }

      // A cwd that is a regular file is not a checkout either.
      assert.deepEqual(
        await resolveCheckoutForCwd(join(repo, 'README.md')),
        NOT_A_CHECKOUT,
        'a file cwd is not a checkout',
      )

      // --- git cannot answer ------------------------------------------------
      // A git that fails for a reason other than "no repository here" must
      // surface as null (unresolved) so the caller keeps launch intent instead
      // of showing a folder. Simulated by pointing PATH at an empty directory
      // so the `git` binary is not found.
      const emptyBin = join(scratch, 'empty-bin')
      await mkdir(emptyBin, { recursive: true })
      const originalPath = process.env.PATH
      process.env.PATH = emptyBin
      // The repo was answered above and its HEAD has not moved, so without
      // this the memo would (correctly) answer without asking git at all.
      clearCheckoutResolveMemo()
      try {
        assert.equal(await resolveCheckoutForCwd(repo), null, 'a missing git binary leaves the checkout unresolved')
      } finally {
        process.env.PATH = originalPath
      }
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }

    console.log('checkout-resolve.test.ts: all assertions passed')
  }

  const suiteRun = run().catch((error) => {
    console.error(error)
    process.exit(1)
  })

  await suiteRun
})
