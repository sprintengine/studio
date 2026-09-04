import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  isLinkedWorktree,
  parseNumstatZ,
  readBranchName,
  readBranchSpan,
  resolveBranchBase,
} from './git-branch-span'

// The branch reading's plumbing (the-diff-an-agent-made / branch-scoped-row-diff).
// The parser's shapes are here because they are silently wrong until someone
// renames a file — this suite inherits that duty from checkpoint-store's, which
// goes with the checkpoint machinery.

let failures = 0
async function run(name: string, fn: () => Promise<void> | void): Promise<void> {
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
function repo(prefix = 'multicode-branch-span-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  created.push(dir)
  git(dir, 'init', '-b', 'main')
  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-m', 'seed')
  return dir
}

void (async () => {
  // ---- parseNumstatZ ------------------------------------------------------

  await run('an ordinary change carries its path inline', () => {
    const stat = parseNumstatZ('3\t1\tsrc/a.ts\0')
    assert.deepEqual(stat.files, [{ path: 'src/a.ts', additions: 3, deletions: 1 }])
    assert.equal(stat.additions, 3)
    assert.equal(stat.deletions, 1)
    assert.equal(stat.changedFiles, 1)
  })

  await run('a rename emits THREE fields and is reported at its new path', () => {
    // The shape that silently drops or misattributes every file after it when
    // framed as two fields.
    const stat = parseNumstatZ('0\t0\t\0old/name.ts\0new/name.ts\0' + '4\t2\tsrc/after.ts\0')
    assert.deepEqual(stat.files, [
      { path: 'new/name.ts', additions: 0, deletions: 0 },
      { path: 'src/after.ts', additions: 4, deletions: 2 },
    ])
    assert.equal(stat.changedFiles, 2, 'the file after a rename survives')
  })

  await run('a binary file counts as changed and contributes no lines', () => {
    const stat = parseNumstatZ('-\t-\tassets/logo.png\0')
    assert.deepEqual(stat.files, [{ path: 'assets/logo.png', additions: 0, deletions: 0 }])
    assert.equal(stat.changedFiles, 1)
    assert.equal(stat.additions, 0)
  })

  await run('a path containing a newline round-trips exactly', () => {
    const stat = parseNumstatZ('1\t0\tsrc/we\nird.ts\0')
    assert.deepEqual(stat.files, [{ path: 'src/we\nird.ts', additions: 1, deletions: 0 }])
  })

  await run('empty and malformed output yield an empty stat, never a throw', () => {
    assert.equal(parseNumstatZ('').changedFiles, 0)
    assert.equal(parseNumstatZ('\0\0').changedFiles, 0)
    assert.equal(parseNumstatZ('garbage\0').changedFiles, 0)
  })

  await run('every empty stat is a FRESH object', () => {
    const first = parseNumstatZ('')
    first.files.push({ path: 'x', additions: 1, deletions: 0 })
    assert.equal(parseNumstatZ('').files.length, 0, 'not a shared mutable singleton')
  })

  // ---- base resolution ----------------------------------------------------

  await run('a feature branch merge-bases against local main', async () => {
    const dir = repo()
    const mainOid = git(dir, 'rev-parse', 'HEAD').trim()
    git(dir, 'checkout', '-b', 'feat')
    writeFileSync(join(dir, 'b.txt'), 'x\n')
    git(dir, 'add', '.')
    git(dir, 'commit', '-m', 'work')
    assert.equal(await resolveBranchBase(dir), mainOid)
  })

  await run('a repo with neither main nor master nor a remote has no base', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'multicode-branch-span-solo-'))
    created.push(dir)
    git(dir, 'init', '-b', 'solo')
    writeFileSync(join(dir, 'a.txt'), 'one\n')
    git(dir, 'add', '.')
    git(dir, 'commit', '-m', 'seed')
    assert.equal(await resolveBranchBase(dir), null)
  })

  await run('origin/HEAD wins over the conventional guesses', async () => {
    const origin = repo('multicode-branch-span-origin-')
    git(origin, 'checkout', '-b', 'trunk')
    writeFileSync(join(origin, 'trunk.txt'), 'trunk\n')
    git(origin, 'add', '.')
    git(origin, 'commit', '-m', 'trunk work')

    const clone = mkdtempSync(join(tmpdir(), 'multicode-branch-span-clone-'))
    created.push(clone)
    rmSync(clone, { recursive: true, force: true })
    execFileSync('git', ['clone', '--quiet', origin, clone])
    // The clone's default branch is `trunk`; `main` also exists on the remote,
    // so a resolver that guessed origin/main first would pick the wrong base.
    const trunkOid = git(clone, 'rev-parse', 'HEAD').trim()
    git(clone, 'checkout', '-b', 'feat')
    writeFileSync(join(clone, 'c.txt'), 'c\n')
    git(clone, 'add', '.')
    git(clone, 'commit', '-m', 'feature')
    assert.equal(await resolveBranchBase(clone), trunkOid)
  })

  // ---- worktree detection -------------------------------------------------

  await run('the main checkout is not a linked worktree; a linked one is', async () => {
    const dir = repo()
    assert.equal(await isLinkedWorktree(dir), false)
    const tree = join(dir, '..', `multicode-branch-span-wt-${process.pid}`)
    created.push(tree)
    git(dir, 'worktree', 'add', '-b', 'wt', tree)
    assert.equal(await isLinkedWorktree(tree), true)
  })

  await run('a subdirectory of the main checkout is still not a worktree', async () => {
    const dir = repo()
    const sub = join(dir, 'src')
    execFileSync('mkdir', ['-p', sub])
    writeFileSync(join(sub, 'x.ts'), 'x\n')
    assert.equal(await isLinkedWorktree(sub), false, '--git-dir is relative from a repo root')
  })

  // ---- the span itself ----------------------------------------------------

  await run('a missing folder and a non-repo both read null', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'multicode-branch-span-plain-'))
    created.push(plain)
    assert.equal(await readBranchSpan(plain), null)
    assert.equal(await readBranchSpan(join(plain, 'gone')), null)
  })

  await run('an unborn HEAD names its branch and spans nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'multicode-branch-span-unborn-'))
    created.push(dir)
    git(dir, 'init', '-b', 'main')
    writeFileSync(join(dir, 'a.txt'), 'x\n')
    const result = await readBranchSpan(dir)
    assert.equal(result?.branch, 'main')
    assert.equal(result?.baseOid, null)
    assert.equal(result?.aheadOfBase, false)
    assert.equal(result?.stat.changedFiles, 0)
  })

  await run('readBranchName is null on a detached HEAD, not a hash', async () => {
    const dir = repo()
    git(dir, 'checkout', '--detach', 'HEAD')
    assert.equal(await readBranchName(dir), null)
  })

  await run('a staged rename spans to its new path', async () => {
    const dir = repo()
    git(dir, 'checkout', '-b', 'feat')
    renameSync(join(dir, 'a.txt'), join(dir, 'renamed.txt'))
    git(dir, 'add', '-A')
    const result = await readBranchSpan(dir)
    const paths = (result?.stat.files ?? []).map((file) => file.path).sort()
    assert.ok(paths.includes('renamed.txt'), `expected the new path, got ${paths.join(', ')}`)
  })

  for (const dir of created) rmSync(dir, { recursive: true, force: true })

  if (failures > 0) {
    console.error(`git-branch-span.test.ts: ${failures} failing`)
    process.exit(1)
  }
  console.log('git-branch-span.test.ts: ok')
})()
