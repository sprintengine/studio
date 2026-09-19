import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { revertGitPaths, stageGitPaths, unstageGitPaths } from './git-file-actions'

// Everything after `--` is a pathspec, so a file really named `src/[id].tsx` is
// a character class that also matches `src/i.tsx`. Staging the wrong file is
// annoying; DISCARDING or REVERTING the wrong file destroys work, so each of
// the three actions is asserted against a repo that contains both names.

async function main(): Promise<void> {
  await assertStageTouchesOnlyTheNamedFile()
  await assertUnstageTouchesOnlyTheNamedFile()
  await assertRevertTouchesOnlyTheNamedFile()
  await assertRevertCleansOnlyTheNamedUntrackedFile()
  console.log('git-file-actions.test.ts: ok')
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
}

const BRACKETED = join('src', '[id].tsx')
const DECOY = join('src', 'i.tsx')

/** A repo holding `src/[id].tsx` beside `src/i.tsx`, both changed in the tree. */
function makeRepo(name: string): { root: string; repo: string } {
  const root = mkdtempSync(join(tmpdir(), `multicode-git-file-actions-${name}-`))
  const repo = join(root, 'repo')
  execFileSync('git', ['init', '--quiet', '--initial-branch=main', repo], { encoding: 'utf8' })
  git(repo, ['config', 'user.email', 'test@example.com'])
  git(repo, ['config', 'user.name', 'Test'])
  git(repo, ['config', 'commit.gpgsign', 'false'])
  mkdirSync(join(repo, 'src'))
  writeFileSync(join(repo, BRACKETED), 'bracketed original\n')
  writeFileSync(join(repo, DECOY), 'decoy original\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '--quiet', '-m', 'base'])
  writeFileSync(join(repo, BRACKETED), 'bracketed changed\n')
  writeFileSync(join(repo, DECOY), 'decoy changed\n')
  return { root, repo }
}

/** `git status --porcelain` for one path, matched literally. */
function statusOf(repo: string, relativePath: string): string {
  return git(repo, ['status', '--porcelain=v1', '--', `:(literal)${relativePath}`]).trimEnd()
}

function read(repo: string, relativePath: string): string {
  return readFileSync(join(repo, relativePath), 'utf8')
}

async function assertStageTouchesOnlyTheNamedFile(): Promise<void> {
  const { root, repo } = makeRepo('stage')
  try {
    const result = await stageGitPaths(repo, [join(repo, BRACKETED)])
    assert.equal(result.ok, true, result.message ?? '')
    assert.equal(statusOf(repo, BRACKETED), 'M  src/[id].tsx', 'the named file is staged')
    assert.equal(statusOf(repo, DECOY), ' M src/i.tsx', 'and the glob-matching file is untouched')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

async function assertUnstageTouchesOnlyTheNamedFile(): Promise<void> {
  const { root, repo } = makeRepo('unstage')
  try {
    git(repo, ['add', '-A'])
    const result = await unstageGitPaths(repo, [join(repo, BRACKETED)])
    assert.equal(result.ok, true, result.message ?? '')
    assert.equal(statusOf(repo, BRACKETED), ' M src/[id].tsx')
    assert.equal(statusOf(repo, DECOY), 'M  src/i.tsx', 'the decoy stays staged')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

async function assertRevertTouchesOnlyTheNamedFile(): Promise<void> {
  const { root, repo } = makeRepo('revert')
  try {
    git(repo, ['add', '-A'])
    const result = await revertGitPaths(repo, [join(repo, BRACKETED)])
    assert.equal(result.ok, true, result.message ?? '')
    assert.equal(read(repo, BRACKETED), 'bracketed original\n')
    assert.equal(statusOf(repo, BRACKETED), '')
    assert.equal(read(repo, DECOY), 'decoy changed\n', 'the decoy keeps its edit')
    assert.equal(statusOf(repo, DECOY), 'M  src/i.tsx', 'and stays staged')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/** Reverting a new file ends in `git clean`, which is the most destructive of
 *  the commands a glob could aim at the wrong name. */
async function assertRevertCleansOnlyTheNamedUntrackedFile(): Promise<void> {
  const { root, repo } = makeRepo('clean')
  try {
    writeFileSync(join(repo, 'src', '[new].tsx'), 'fresh\n')
    writeFileSync(join(repo, 'src', 'n.tsx'), 'neighbour\n')
    const result = await revertGitPaths(repo, [join(repo, 'src', '[new].tsx')])
    assert.equal(result.ok, true, result.message ?? '')
    assert.equal(existsSync(join(repo, 'src', '[new].tsx')), false, 'the named new file is gone')
    assert.equal(existsSync(join(repo, 'src', 'n.tsx')), true, 'and its glob-matching neighbour survives')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// Last, not first: the module-level path constants above have to be evaluated
// before `main` runs, and a bundler keeps statement order exactly as written.
void main()
