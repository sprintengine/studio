// Excluding files from one linked worktree only, in real repositories under a
// temporary directory.

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'

import { runGitCommand } from '../git-utils'
import { createIntegrationLedger, installIntegrationLedger } from './ledger'
import {
  excludeFromWorktree,
  removeMarkedBlock,
  withoutLegacySharedPair,
  WORKTREE_EXCLUDE_START,
} from './worktree-exclude'

afterEach(() => installIntegrationLedger(null))

const ENTRIES = ['.mcp.json', '.codex/config.toml']

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await runGitCommand(cwd, args)
  assert.ok(result.ok, `git ${args.join(' ')}: ${result.message ?? ''}`)
  return result.stdout
}

async function repoWithWorktrees(count: number): Promise<{ root: string; repo: string; worktrees: string[] }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sprintengine-exclude-')))
  const repo = join(root, 'repo')
  await mkdir(repo)
  await git(repo, 'init', '-q')
  await git(
    repo,
    '-c',
    'user.email=dev@example.com',
    '-c',
    'user.name=dev',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'seed',
  )
  // Never this machine's own global excludes.
  await git(repo, 'config', 'core.excludesFile', join(root, 'none'))
  const worktrees: string[] = []
  for (let index = 0; index < count; index += 1) {
    const path = join(root, `wt${index}`)
    await git(repo, 'worktree', 'add', '-q', '-b', `wt${index}`, path)
    worktrees.push(path)
  }
  return { root, repo, worktrees }
}

async function untracked(cwd: string): Promise<string> {
  return git(cwd, 'status', '--porcelain', '--untracked-files=all')
}

test("taking the old shared pair out keeps the files hidden in every other linked worktree, and shows the main checkout's", async () => {
  const { repo, worktrees } = await repoWithWorktrees(2)
  const shared = join(repo, '.git', 'info', 'exclude')
  await writeFile(shared, '# mine\n.mcp.json\n.codex/config.toml\n')
  for (const path of [repo, ...worktrees]) await writeFile(join(path, '.mcp.json'), '{}\n')

  await excludeFromWorktree(worktrees[0], ENTRIES)

  assert.equal(await readFile(shared, 'utf8'), '# mine\n')
  assert.ok(!(await untracked(worktrees[0])).includes('.mcp.json'))
  assert.ok(!(await untracked(worktrees[1])).includes('.mcp.json'), 'the other connector worktree was set up first')
  assert.ok((await untracked(repo)).includes('.mcp.json'), "the main checkout's own file is visible again")
})

test('the ledger keeps "the app turned on worktreeConfig" across a repeat that finds it already on', async () => {
  const { root, worktrees } = await repoWithWorktrees(1)
  const ledger = createIntegrationLedger({ path: join(root, 'ledger.json') })
  installIntegrationLedger(ledger)
  const first = await excludeFromWorktree(worktrees[0], ENTRIES)
  assert.ok(first.scope === 'worktree' && first.enabledWorktreeConfig)
  const second = await excludeFromWorktree(worktrees[0], ENTRIES)
  assert.ok(second.scope === 'worktree' && !second.enabledWorktreeConfig)
  await ledger.flush()
  const [entry] = (await ledger.list()).filter((candidate) => candidate.kind === 'git-exclude')
  assert.equal(entry.detail?.enabledWorktreeConfig, true)
})

test('the main checkout gets a marked block in the shared file, which comes back out byte for byte', async () => {
  const { repo } = await repoWithWorktrees(0)
  const shared = join(repo, '.git', 'info', 'exclude')
  await writeFile(shared, '# mine\nbuild/\n')
  const result = await excludeFromWorktree(repo, ENTRIES)
  assert.equal(result.scope, 'shared')
  const text = await readFile(shared, 'utf8')
  assert.ok(text.includes(WORKTREE_EXCLUDE_START))
  assert.equal(removeMarkedBlock(text), '# mine\nbuild/\n')
})

test('only the exact pair, adjacent and in order, counts as the old lines', () => {
  assert.equal(withoutLegacySharedPair('.codex/config.toml\n.mcp.json\n'), null)
  assert.equal(withoutLegacySharedPair('.mcp.json\n# x\n.codex/config.toml\n'), null)
  assert.equal(withoutLegacySharedPair('a\n.mcp.json\n.codex/config.toml\nb\n'), 'a\nb\n')
})
