// Hunk staging and the ignore check hand git its input on stdin. For a
// repository on a WSL machine that git is the distribution's, which owns the
// index, so both go through the app's one git runner and the machine's
// `runGit` like every other git command. Here the "machine" is this one's own
// git behind a WSL-kind host, so the real index proves the bytes arrived.

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'

import { checkIgnoredPaths } from './git-ignore'
import { readFileHunks, stageGitHunk, unstageGitHunk } from './git-hunks'
import { installGitHostResolver } from './git-run'
import { createPosixLocalHost } from './hosts/posix-local-host'
import type { GitFileHunks } from '../shared/git/hunks'

type Call = { cwd: string; args: readonly string[]; stdin?: string; timeoutMs: number | null }

afterEach(() => installGitHostResolver(null))

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
}

function makeRepo(): { root: string; repo: string } {
  const root = mkdtempSync(join(tmpdir(), 'se-git-host-stdin-'))
  const repo = join(root, 'repo')
  execFileSync('git', ['init', '--quiet', '--initial-branch=main', repo])
  git(repo, ['config', 'user.email', 'dev@example.com'])
  git(repo, ['config', 'user.name', 'Dev'])
  git(repo, ['config', 'commit.gpgsign', 'false'])
  return { root, repo }
}

// Every git for `repo` goes to a WSL-kind host, which records what it was
// asked and runs it with this machine's git.
function claim(repo: string): Call[] {
  const calls: Call[] = []
  const local = createPosixLocalHost()
  installGitHostResolver((cwd) =>
    cwd.startsWith(repo)
      ? {
          kind: 'wsl',
          runGit: (at, args, options) => {
            calls.push({
              cwd: at,
              args,
              timeoutMs: options.timeoutMs,
              ...(options.stdin ? { stdin: options.stdin } : {}),
            })
            return local.runGit(at, args, options)
          },
        }
      : null,
  )
  return calls
}

test("a hunk on a WSL machine is staged and unstaged by that machine's git, patch on stdin", async () => {
  const { root, repo } = makeRepo()
  try {
    writeFileSync(join(repo, 'a.txt'), 'one\r\ntwo\r\n')
    git(repo, ['add', '.'])
    git(repo, ['commit', '--quiet', '-m', 'init'])
    writeFileSync(join(repo, 'a.txt'), 'one\r\ntwo\r\nthree\r\n')
    const calls = claim(repo)

    const unstaged = (await readFileHunks(repo, join(repo, 'a.txt'), 'unstaged')) as GitFileHunks
    assert.equal(unstaged.ok, true)
    const hunk = unstaged.hunks[0]
    const staged = await stageGitHunk({
      repoRoot: repo,
      filePath: join(repo, 'a.txt'),
      scope: hunk.scope,
      index: hunk.index,
      fingerprint: hunk.fingerprint,
    })
    assert.equal(staged.ok, true, staged.message ?? '')
    assert.equal(git(repo, ['show', ':a.txt']), 'one\r\ntwo\r\nthree\r\n', 'the CRLF patch landed intact')
    const apply = calls.find((call) => call.args[0] === 'apply')
    assert.ok(apply, 'the apply went to the machine')
    assert.deepEqual(apply.args, ['apply', '--cached', '--unidiff-zero', '-'])
    assert.match(apply.stdin ?? '', /^diff --git/u, 'with the patch on stdin')
    assert.equal(apply.timeoutMs, null, 'a write keeps no deadline')

    const inIndex = (await readFileHunks(repo, join(repo, 'a.txt'), 'staged')) as GitFileHunks
    const back = inIndex.hunks.find((entry) => entry.scope === 'staged')
    assert.ok(back)
    const unstagedAgain = await unstageGitHunk({
      repoRoot: repo,
      filePath: join(repo, 'a.txt'),
      scope: back.scope,
      index: back.index,
      fingerprint: back.fingerprint,
    })
    assert.equal(unstagedAgain.ok, true, unstagedAgain.message ?? '')
    assert.equal(git(repo, ['show', ':a.txt']), 'one\r\ntwo\r\n')
    assert.deepEqual(
      calls.filter((call) => call.args[0] === 'apply').map((call) => call.args),
      [
        ['apply', '--cached', '--unidiff-zero', '-'],
        ['apply', '--cached', '--reverse', '--unidiff-zero', '-'],
      ],
    )
    assert.ok(
      calls.every((call) => call.cwd === repo),
      'nothing ran against the repository behind the machine',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a hunk that moved under the diff is refused with a reason, the diff re-read through the machine', async () => {
  const { root, repo } = makeRepo()
  try {
    writeFileSync(join(repo, 'a.txt'), 'one\n')
    git(repo, ['add', '.'])
    git(repo, ['commit', '--quiet', '-m', 'init'])
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n')
    const unstaged = (await readFileHunks(repo, join(repo, 'a.txt'), 'unstaged')) as GitFileHunks
    const hunk = unstaged.hunks[0]
    const calls = claim(repo)
    // The index moves under the diff after it was read.
    git(repo, ['add', 'a.txt'])
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n')
    const result = await stageGitHunk({
      repoRoot: repo,
      filePath: join(repo, 'a.txt'),
      scope: hunk.scope,
      index: hunk.index,
      fingerprint: hunk.fingerprint,
    })
    assert.equal(result.ok, false)
    assert.ok(result.message, 'a reason is given')
    assert.ok(
      calls.some((call) => call.args.includes('diff')),
      'the diff was re-read by the machine',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("the ignore check on a WSL machine asks that machine's git, paths on stdin, NUL for NUL", async () => {
  const { root, repo } = makeRepo()
  try {
    writeFileSync(join(repo, '.gitignore'), 'out/\n*.log\n')
    mkdirSync(join(repo, 'out'))
    const calls = claim(repo)
    const ignored = await checkIgnoredPaths(repo, ['out', 'src/a.ts', 'debug.log', 'we\nird.log'])
    assert.deepEqual([...ignored].sort(), ['debug.log', 'out', 'we\nird.log'])
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0].args, ['check-ignore', '-z', '--stdin'])
    assert.equal(calls[0].stdin, 'out\0src/a.ts\0debug.log\0we\nird.log\0')
    assert.ok(calls[0].timeoutMs !== null && calls[0].timeoutMs > 0, 'a read keeps its deadline')
    // Nothing matched is exit 1, which is an answer, not a failure.
    assert.deepEqual([...(await checkIgnoredPaths(repo, ['src/a.ts']))], [])
    assert.deepEqual([...(await checkIgnoredPaths(repo, []))], [])
    assert.equal(calls.length, 2, 'an empty list asks nothing')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
  // Not a repository: nothing is ignored, and nothing throws.
  const plain = mkdtempSync(join(tmpdir(), 'se-git-host-plain-'))
  try {
    assert.deepEqual([...(await checkIgnoredPaths(plain, ['a']))], [])
  } finally {
    rmSync(plain, { recursive: true, force: true })
  }
})
