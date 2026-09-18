import type { GitWorktreeEntry, GitWorktreeListSnapshot, GitWorktreeOperationResult } from './git'
import { runGitCommand } from './git-utils'
import { resolveRepoRoot } from './git-worktree-validation'

function normalizeWorktreeBranch(refName: string): { branch: string; branchRef: string } {
  const branchPrefix = 'refs/heads/'
  return {
    branch: refName.startsWith(branchPrefix) ? refName.slice(branchPrefix.length) : refName,
    branchRef: refName,
  }
}

function createEmptyWorktree(pathValue: string): GitWorktreeEntry {
  return {
    path: pathValue,
    head: null,
    branch: null,
    branchRef: null,
    detached: false,
    bare: false,
    locked: false,
    lockedReason: null,
    prunable: false,
    prunableReason: null,
  }
}

function parseGitWorktreePorcelain(output: string): GitWorktreeEntry[] {
  const lines = output
    .split('\0')
    .flatMap((record) => record.split(/\r?\n/))
    .map((line) => line.trimEnd())
    .filter(Boolean)
  const worktrees: GitWorktreeEntry[] = []
  let current: GitWorktreeEntry | null = null

  for (const line of lines) {
    if (line.startsWith('worktree ')) {
      if (current) worktrees.push(current)
      current = createEmptyWorktree(line.slice('worktree '.length))
      continue
    }

    if (!current) continue

    if (line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length)
    } else if (line.startsWith('branch ')) {
      const branch = normalizeWorktreeBranch(line.slice('branch '.length))
      current.branch = branch.branch
      current.branchRef = branch.branchRef
    } else if (line === 'detached') {
      current.detached = true
    } else if (line === 'bare') {
      current.bare = true
    } else if (line === 'locked' || line.startsWith('locked ')) {
      current.locked = true
      current.lockedReason = line === 'locked' ? null : line.slice('locked '.length)
    } else if (line === 'prunable' || line.startsWith('prunable ')) {
      current.prunable = true
      current.prunableReason = line === 'prunable' ? null : line.slice('prunable '.length)
    }
  }

  if (current) worktrees.push(current)
  return worktrees
}

export async function listGitWorktrees(repoRoot: string): Promise<GitWorktreeOperationResult<GitWorktreeListSnapshot>> {
  const root = await resolveRepoRoot(repoRoot)
  if (!root.ok) return root

  const result = await runGitCommand(root.data, ['worktree', 'list', '--porcelain', '-z'])
  if (!result.ok) {
    return {
      ok: false,
      message: result.message ?? 'Unable to list Git worktrees.',
      stdout: result.stdout,
      stderr: result.stderr,
    }
  }

  return {
    ok: true,
    data: {
      repoRoot: root.data,
      worktrees: parseGitWorktreePorcelain(result.stdout),
      updatedAt: Date.now(),
    },
    message: null,
    stdout: result.stdout,
    stderr: result.stderr,
  }
}
