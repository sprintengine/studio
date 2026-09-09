import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createGitPatch, gitPatchArgs } from './git-patch'

// A path is a PATHSPEC to git, and a file really named `src/[id].tsx` is a
// character class that also matches `src/i.tsx`. These assert the whole file's
// behaviour rather than only the argv: the patch a person copies must be the
// patch of the file they selected and of nothing that merely matched it.

void main()

async function main(): Promise<void> {
  await assertLiteralPathspecInArgv()
  await assertGlobbyNameCopiesOnlyItself()
  console.log('git-patch.test.ts: ok')
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
}

/** A repo holding `src/[id].tsx` beside `src/i.tsx`, both changed. */
function makeRepo(): { root: string; repo: string } {
  const root = mkdtempSync(join(tmpdir(), 'multicode-git-patch-'))
  const repo = join(root, 'repo')
  execFileSync('git', ['init', '--quiet', '--initial-branch=main', repo], { encoding: 'utf8' })
  git(repo, ['config', 'user.email', 'test@example.com'])
  git(repo, ['config', 'user.name', 'Test'])
  git(repo, ['config', 'commit.gpgsign', 'false'])
  mkdirSync(join(repo, 'src'))
  writeFileSync(join(repo, 'src', '[id].tsx'), 'bracketed original\n')
  writeFileSync(join(repo, 'src', 'i.tsx'), 'decoy original\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '--quiet', '-m', 'base'])
  writeFileSync(join(repo, 'src', '[id].tsx'), 'bracketed changed\n')
  writeFileSync(join(repo, 'src', 'i.tsx'), 'decoy changed\n')
  return { root, repo }
}

async function assertLiteralPathspecInArgv(): Promise<void> {
  assert.deepEqual(
    gitPatchArgs(['src/[id].tsx'], false),
    ['diff', '--no-color', '--binary', '--', ':(literal)src/[id].tsx'],
  )
}

async function assertGlobbyNameCopiesOnlyItself(): Promise<void> {
  const { root, repo } = makeRepo()
  try {
    const patch = await createGitPatch(repo, [join(repo, 'src', '[id].tsx')])
    assert.equal(patch.ok, true, patch.message ?? '')
    assert.match(patch.patch, /\+bracketed changed/, 'the selected file is in the patch')
    assert.ok(!patch.patch.includes('decoy'), 'and the file the glob would have matched is not')
    assert.ok(!patch.patch.includes('src/i.tsx'), 'not even by name')

    // The decoy on its own still works — `:(literal)` narrows, it does not break.
    const decoy = await createGitPatch(repo, [join(repo, 'src', 'i.tsx')])
    assert.equal(decoy.ok, true, decoy.message ?? '')
    assert.match(decoy.patch, /\+decoy changed/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}
