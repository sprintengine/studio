import type { GitCommandResult } from './git'
import { getGitBranches } from './git-read-models'
import { runGitCommand } from './git-utils'

export async function commitGitChanges(repoRoot: string, message: string): Promise<GitCommandResult> {
  const trimmedMessage = message.trim()
  if (!trimmedMessage) {
    return { ok: false, stdout: '', stderr: '', message: 'Enter a commit message.' }
  }

  return runGitCommand(repoRoot, ['commit', '-m', trimmedMessage])
}

export async function pushGitBranch(repoRoot: string): Promise<GitCommandResult> {
  const branchSnapshot = await getGitBranches(repoRoot)
  const currentBranch = branchSnapshot.current

  if (!currentBranch) {
    return {
      ok: false,
      stdout: '',
      stderr: '',
      message: 'Cannot push while HEAD is detached. Check out a branch first.',
    }
  }

  const branch = branchSnapshot.branches.find((candidate) => candidate.current)
  if (branch?.upstream) {
    return runGitCommand(repoRoot, ['push'])
  }

  return {
    ok: false,
    stdout: '',
    stderr: '',
    message: `Branch "${currentBranch}" has no upstream. Set an upstream branch first, for example: git push --set-upstream origin ${currentBranch}`,
  }
}

export async function switchGitBranch(repoRoot: string, branchName: string): Promise<GitCommandResult> {
  const trimmedBranch = branchName.trim()
  if (!trimmedBranch) {
    return { ok: false, stdout: '', stderr: '', message: 'Choose a branch.' }
  }

  return runGitCommand(repoRoot, ['switch', trimmedBranch])
}
