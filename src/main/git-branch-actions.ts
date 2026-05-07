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

export async function fetchGitRemotes(repoRoot: string): Promise<GitCommandResult> {
  return runGitCommand(repoRoot, ['fetch', '--prune'])
}

function appendGitCommandOutput(parts: string[], label: string, result: GitCommandResult): void {
  const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n')
  if (output) parts.push(`${label}:\n${output}`)
}

export async function pullGitBranchWithStash(repoRoot: string): Promise<GitCommandResult> {
  const statusResult = await runGitCommand(repoRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  if (!statusResult.ok) return statusResult

  const hasLocalChanges = statusResult.stdout.length > 0
  const outputs: string[] = []
  let stashCreated = false

  if (hasLocalChanges) {
    const stashResult = await runGitCommand(repoRoot, [
      'stash',
      'push',
      '--include-untracked',
      '-m',
      'Multicode auto-stash before pull',
    ])
    appendGitCommandOutput(outputs, 'stash', stashResult)
    if (!stashResult.ok) return stashResult
    stashCreated = !/No local changes to save/i.test(`${stashResult.stdout}\n${stashResult.stderr}`)
  }

  const pullResult = await runGitCommand(repoRoot, ['pull'])
  appendGitCommandOutput(outputs, 'pull', pullResult)
  if (!pullResult.ok) {
    return {
      ...pullResult,
      stdout: outputs.join('\n\n'),
      message: stashCreated
        ? `${pullResult.message ?? 'Git pull failed.'}\n\nYour local changes were saved in the Git stash and were not reapplied because pull did not finish cleanly.`
        : pullResult.message,
    }
  }

  if (!stashCreated) {
    return {
      ...pullResult,
      stdout: outputs.join('\n\n') || pullResult.stdout,
    }
  }

  const popResult = await runGitCommand(repoRoot, ['stash', 'pop'])
  appendGitCommandOutput(outputs, 'stash pop', popResult)
  if (!popResult.ok) {
    return {
      ...popResult,
      stdout: outputs.join('\n\n'),
      message: `${popResult.message ?? 'Git reapplied the stash with conflicts.'}\n\nPull completed, but reapplying your stashed changes did not finish cleanly. Resolve conflicts in the working tree; Git keeps the stash entry when pop conflicts.`,
    }
  }

  return {
    ...popResult,
    stdout: outputs.join('\n\n'),
    message: null,
  }
}

export async function switchGitBranch(repoRoot: string, branchName: string): Promise<GitCommandResult> {
  const trimmedBranch = branchName.trim()
  if (!trimmedBranch) {
    return { ok: false, stdout: '', stderr: '', message: 'Choose a branch.' }
  }

  return runGitCommand(repoRoot, ['switch', trimmedBranch])
}
