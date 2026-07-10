import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyGitStash, dropGitStash, listGitStashes, pushGitStash } from './git-stash'

void main()

async function main(): Promise<void> {
  await assertStashLifecycle()
}

async function assertStashLifecycle(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'multicode-git-stash-'))
  const repo = join(root, 'repo')

  try {
    git(root, ['init', '--initial-branch=main', repo])
    configureRepo(repo)
    writeFileSync(join(repo, 'file.txt'), 'base\n')
    git(repo, ['add', 'file.txt'])
    git(repo, ['commit', '-m', 'base'])

    // A clean tree lists no stashes and refuses a push.
    const emptyList = await listGitStashes(repo)
    assert.equal(emptyList.stashes.length, 0)
    const nothing = await pushGitStash(repo, '')
    assert.equal(nothing.ok, false)
    assert.equal(nothing.message, 'No local changes to stash.')

    // Push captures tracked and untracked changes and cleans the tree.
    writeFileSync(join(repo, 'file.txt'), 'changed\n')
    writeFileSync(join(repo, 'untracked.txt'), 'new\n')
    const pushed = await pushGitStash(repo, 'wip: panel work')
    assert.equal(pushed.ok, true, pushed.message ?? pushed.stderr)
    assert.equal(git(repo, ['status', '--porcelain=v1']).trim(), '')

    const list = await listGitStashes(repo)
    assert.equal(list.stashes.length, 1)
    assert.equal(list.stashes[0].ref, 'stash@{0}')
    assert.equal(list.stashes[0].index, 0)
    assert.equal(list.stashes[0].branch, 'main')
    assert.equal(list.stashes[0].message, 'wip: panel work')
    assert.equal(list.stashes[0].createdAt > 0, true)
    assert.match(list.stashes[0].hash, /^[0-9a-f]{40}$/)
    const stashHash = list.stashes[0].hash

    // A stale expected hash (the stack changed under the panel) is refused.
    const stale = await applyGitStash(repo, 0, 'f'.repeat(40), false)
    assert.equal(stale.ok, false)
    assert.match(stale.message ?? '', /stash list changed/)

    // Apply restores the changes and keeps the entry.
    const applied = await applyGitStash(repo, 0, stashHash, false)
    assert.equal(applied.ok, true, applied.message ?? applied.stderr)
    assert.notEqual(git(repo, ['status', '--porcelain=v1']).trim(), '')
    assert.equal((await listGitStashes(repo)).stashes.length, 1)

    // Drop removes the entry without touching the restored tree.
    const dropped = await dropGitStash(repo, 0, stashHash)
    assert.equal(dropped.ok, true, dropped.message ?? dropped.stderr)
    assert.equal((await listGitStashes(repo)).stashes.length, 0)

    // Pop restores and removes in one step; a default message parses.
    git(repo, ['add', '--all'])
    git(repo, ['commit', '-m', 'checkpoint'])
    writeFileSync(join(repo, 'file.txt'), 'more\n')
    const pushedDefault = await pushGitStash(repo, '')
    assert.equal(pushedDefault.ok, true, pushedDefault.message ?? pushedDefault.stderr)
    const defaultList = await listGitStashes(repo)
    assert.equal(defaultList.stashes.length, 1)
    assert.equal(defaultList.stashes[0].branch, 'main')
    assert.equal(defaultList.stashes[0].message.length > 0, true)
    const popped = await applyGitStash(repo, 0, defaultList.stashes[0].hash, true)
    assert.equal(popped.ok, true, popped.message ?? popped.stderr)
    assert.equal((await listGitStashes(repo)).stashes.length, 0)

    // Missing and invalid selectors fail without side effects.
    const missing = await applyGitStash(repo, 5, 'f'.repeat(40))
    assert.equal(missing.ok, false)
    const invalid = await dropGitStash(repo, -1, 'f'.repeat(40))
    assert.equal(invalid.ok, false)
    assert.equal(invalid.message, 'Choose a stash entry.')

    console.log('ok - stash lifecycle: push, list parse, apply, drop, pop, guards')
  } finally {
    rmSync(root, { force: true, recursive: true })
  }
}

function configureRepo(cwd: string): void {
  git(cwd, ['config', 'user.email', 'multicode@example.invalid'])
  git(cwd, ['config', 'user.name', 'Multicode Test'])
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}
