import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  checkoutGitCommit,
  checkoutGitCommitAsBranch,
  createGitBranchFromCommit,
  createGitTagFromCommit,
  pullGitBranchWithStash,
} from './git-branch-actions'

void main()

async function main(): Promise<void> {
  await assertPullMergesDivergentBranches()
  await assertCommitActions()
}

async function assertCommitActions(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'multicode-git-commit-actions-'))
  const repo = join(root, 'repo')

  try {
    git(root, ['init', '--initial-branch=main', repo])
    configureRepo(repo)
    writeFileSync(join(repo, 'file.txt'), 'v1\n')
    git(repo, ['add', 'file.txt'])
    git(repo, ['commit', '-m', 'first'])
    const firstCommit = git(repo, ['rev-parse', 'HEAD']).trim()
    writeFileSync(join(repo, 'file.txt'), 'v2\n')
    git(repo, ['commit', '-am', 'second'])

    // Invalid hash is rejected before shelling out.
    const invalid = await checkoutGitCommit(repo, 'not-a-hash')
    assert.equal(invalid.ok, false)
    assert.equal(invalid.message, 'Invalid commit hash.')

    // Empty branch name is rejected.
    const emptyName = await createGitBranchFromCommit(repo, '   ', firstCommit)
    assert.equal(emptyName.ok, false)

    // Branch from a commit creates the ref without moving HEAD.
    const branched = await createGitBranchFromCommit(repo, 'feature', firstCommit)
    assert.equal(branched.ok, true, branched.message ?? branched.stderr)
    assert.equal(git(repo, ['rev-parse', 'feature']).trim(), firstCommit)

    // Checkout on a clean tree detaches HEAD at the requested commit.
    const checkedOut = await checkoutGitCommit(repo, firstCommit)
    assert.equal(checkedOut.ok, true, checkedOut.message ?? checkedOut.stderr)
    assert.equal(git(repo, ['rev-parse', 'HEAD']).trim(), firstCommit)
    assert.throws(() => git(repo, ['symbolic-ref', '-q', 'HEAD']), 'HEAD should be detached')

    git(repo, ['switch', 'main'])

    // A dirty tracked file blocks the detaching checkout with a clear message.
    writeFileSync(join(repo, 'file.txt'), 'dirty\n')
    const blocked = await checkoutGitCommit(repo, firstCommit)
    assert.equal(blocked.ok, false)
    assert.match(blocked.message ?? '', /tracked changes/)
    git(repo, ['checkout', '--', 'file.txt'])

    // Create-and-switch lands on a new branch at the commit.
    const asBranch = await checkoutGitCommitAsBranch(repo, 'feature2', firstCommit)
    assert.equal(asBranch.ok, true, asBranch.message ?? asBranch.stderr)
    assert.equal(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), 'feature2')
    assert.equal(git(repo, ['rev-parse', 'HEAD']).trim(), firstCommit)

    // Tagging points a tag at the commit.
    const tagged = await createGitTagFromCommit(repo, 'v1.0.0', firstCommit)
    assert.equal(tagged.ok, true, tagged.message ?? tagged.stderr)
    assert.equal(git(repo, ['rev-parse', 'v1.0.0^{commit}']).trim(), firstCommit)

    console.log('ok - commit actions: checkout, branch, tag, dirty guard, invalid hash')
  } finally {
    rmSync(root, { force: true, recursive: true })
  }
}

async function assertPullMergesDivergentBranches(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'multicode-git-pull-'))

  try {
    const remote = join(root, 'remote.git')
    const upstream = join(root, 'upstream')
    const local = join(root, 'local')

    git(root, ['init', '--bare', '--initial-branch=main', remote])
    git(root, ['clone', remote, upstream])
    configureRepo(upstream)
    writeFileSync(join(upstream, 'file.txt'), 'base\n')
    git(upstream, ['add', 'file.txt'])
    git(upstream, ['commit', '-m', 'base'])
    git(upstream, ['push', '-u', 'origin', 'main'])

    git(root, ['clone', remote, local])
    configureRepo(local)
    git(local, ['switch', 'main'])
    git(local, ['config', 'pull.ff', 'only'])

    writeFileSync(join(upstream, 'file.txt'), 'base\nremote\n')
    git(upstream, ['commit', '-am', 'remote'])
    git(upstream, ['push'])

    writeFileSync(join(local, 'local.txt'), 'local\n')
    git(local, ['add', 'local.txt'])
    git(local, ['commit', '-m', 'local'])

    const result = await pullGitBranchWithStash(local)

    assert.equal(result.ok, true, result.message ?? result.stderr)
    assert.match(git(local, ['log', '--oneline', '--merges', '-1']), /Merge /)
    assert.equal(git(local, ['status', '--porcelain=v1']).trim(), '')
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
