import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { getGitRowSummary } from './git-status'

// The sidebar row's git summary (remote-sessions-ux / two-line-session-rows),
// against real repos: branch naming, ±line counting across staged and
// unstaged edits, and the quiet shape for everything unreadable.

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

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], {
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.invalid',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.invalid',
    },
  })
}

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'multicode-git-row-'))
  git(dir, 'init', '-b', 'main')
  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-m', 'seed')
  return dir
}

async function main(): Promise<void> {
  await run('a clean repo reports its branch and zero lines', async () => {
    const dir = tempRepo()
    try {
      assert.deepEqual(await getGitRowSummary(dir), { branch: 'main', additions: 0, deletions: 0 })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await run('staged and unstaged edits both count against HEAD', async () => {
    const dir = tempRepo()
    try {
      // Staged: rewrite one line. Unstaged on top: add two more.
      writeFileSync(join(dir, 'a.txt'), 'one\nTWO\nthree\n')
      git(dir, 'add', '.')
      writeFileSync(join(dir, 'a.txt'), 'one\nTWO\nthree\nfour\nfive\n')
      const summary = await getGitRowSummary(dir)
      assert.equal(summary.branch, 'main')
      assert.equal(summary.additions, 3, 'one rewrite + two new lines')
      assert.equal(summary.deletions, 1, 'the rewritten line')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await run('a detached HEAD reports no branch name rather than the literal HEAD', async () => {
    const dir = tempRepo()
    try {
      git(dir, 'checkout', '--detach')
      const summary = await getGitRowSummary(dir)
      assert.equal(summary.branch, null)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await run('a non-repo answers the quiet shape, never a throw', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'multicode-git-row-none-'))
    try {
      assert.deepEqual(await getGitRowSummary(dir), { branch: null, additions: 0, deletions: 0 })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await run('an unborn HEAD (fresh init) keeps the branch and zero lines', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'multicode-git-row-unborn-'))
    try {
      git(dir, 'init', '-b', 'main')
      const summary = await getGitRowSummary(dir)
      assert.equal(summary.branch, 'main')
      assert.deepEqual([summary.additions, summary.deletions], [0, 0])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  if (failures > 0) {
    console.error(`git-row-summary.test.ts: ${failures} failing`)
    process.exit(1)
  }
  console.log('git-row-summary.test.ts: ok')
}

void main()
