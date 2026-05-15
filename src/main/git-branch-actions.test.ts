import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pullGitBranchWithStash } from './git-branch-actions'

void main()

async function main(): Promise<void> {
  await assertPullMergesDivergentBranches()
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
