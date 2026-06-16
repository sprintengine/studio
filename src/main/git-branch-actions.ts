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
    const pushedCommitCount = await countCommitsToPush(repoRoot, branch.upstream)
    const result = await runGitCommand(repoRoot, ['push'])
    return result.ok ? { ...result, pushedCommitCount } : result
  }

  return {
    ok: false,
    stdout: '',
    stderr: '',
    message: `Branch "${currentBranch}" has no upstream. Set an upstream branch first, for example: git push --set-upstream origin ${currentBranch}`,
  }
}

async function countCommitsToPush(repoRoot: string, upstream: string): Promise<number> {
  const result = await runGitCommand(repoRoot, ['rev-list', '--count', `${upstream}..HEAD`])
  if (!result.ok) return 0
  return Number.parseInt(result.stdout.trim(), 10) || 0
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

  const pullResult = await runGitCommand(repoRoot, ['pull', '--no-rebase', '--ff', '--no-edit'])
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

const COMMIT_HASH_PATTERN = /^[0-9a-f]{7,40}$/i

function invalidCommit(): GitCommandResult {
  return { ok: false, stdout: '', stderr: '', message: 'Invalid commit hash.' }
}

function validateRefName(name: string, kind: 'branch' | 'tag'): GitCommandResult | null {
  const trimmed = name.trim()
  if (!trimmed) return { ok: false, stdout: '', stderr: '', message: `Enter a ${kind} name.` }
  if (trimmed.startsWith('-')) {
    return { ok: false, stdout: '', stderr: '', message: `${kind === 'branch' ? 'Branch' : 'Tag'} names cannot start with a dash.` }
  }
  return null
}

function validateMergeTarget(ref: string): GitCommandResult | null {
  const trimmed = ref.trim()
  if (!trimmed) return { ok: false, stdout: '', stderr: '', message: 'Choose a branch or commit to merge.' }
  if (trimmed.startsWith('-')) {
    return { ok: false, stdout: '', stderr: '', message: 'Merge targets cannot start with a dash.' }
  }
  return null
}

/** Tracked, uncommitted modifications block a detaching checkout to avoid silent carry-over. */
async function hasUncommittedTrackedChanges(repoRoot: string): Promise<boolean> {
  const result = await runGitCommand(repoRoot, ['status', '--porcelain=v1', '--untracked-files=no'])
  return result.ok && result.stdout.trim().length > 0
}

async function getCurrentBranchName(repoRoot: string): Promise<string | null> {
  const result = await runGitCommand(repoRoot, ['symbolic-ref', '--short', '-q', 'HEAD'])
  if (!result.ok) return null
  return result.stdout.trim() || null
}

export async function mergeGitRef(repoRoot: string, ref: string): Promise<GitCommandResult> {
  const target = ref.trim()
  const invalid = validateMergeTarget(target)
  if (invalid) return invalid

  const currentBranch = await getCurrentBranchName(repoRoot)
  if (!currentBranch) {
    return {
      ok: false,
      stdout: '',
      stderr: '',
      message: 'Cannot merge while HEAD is detached. Check out a branch first.',
    }
  }

  if (target === currentBranch || target === `refs/heads/${currentBranch}`) {
    return {
      ok: false,
      stdout: '',
      stderr: '',
      message: 'Choose a different branch or commit to merge.',
    }
  }

  if (await hasUncommittedTrackedChanges(repoRoot)) {
    return {
      ok: false,
      stdout: '',
      stderr: '',
      message: 'Commit, stash, or discard your tracked changes before merging.',
    }
  }

  const resolved = await runGitCommand(repoRoot, ['rev-parse', '--verify', '--quiet', `${target}^{commit}`])
  if (!resolved.ok) {
    return {
      ok: false,
      stdout: resolved.stdout,
      stderr: resolved.stderr,
      message: `Cannot find branch or commit "${target}".`,
    }
  }

  return runGitCommand(repoRoot, ['merge', '--no-edit', target])
}

export async function checkoutGitCommit(repoRoot: string, commitHash: string): Promise<GitCommandResult> {
  const hash = commitHash.trim()
  if (!COMMIT_HASH_PATTERN.test(hash)) return invalidCommit()
  if (await hasUncommittedTrackedChanges(repoRoot)) {
    return {
      ok: false,
      stdout: '',
      stderr: '',
      message: 'Commit, stash, or discard your tracked changes before checking out a commit.',
    }
  }
  return runGitCommand(repoRoot, ['checkout', hash])
}

export async function createGitBranchFromCommit(
  repoRoot: string,
  branchName: string,
  commitHash: string
): Promise<GitCommandResult> {
  const hash = commitHash.trim()
  if (!COMMIT_HASH_PATTERN.test(hash)) return invalidCommit()
  const invalid = validateRefName(branchName, 'branch')
  if (invalid) return invalid
  return runGitCommand(repoRoot, ['branch', branchName.trim(), hash])
}

export async function checkoutGitCommitAsBranch(
  repoRoot: string,
  branchName: string,
  commitHash: string
): Promise<GitCommandResult> {
  const hash = commitHash.trim()
  if (!COMMIT_HASH_PATTERN.test(hash)) return invalidCommit()
  const invalid = validateRefName(branchName, 'branch')
  if (invalid) return invalid
  if (await hasUncommittedTrackedChanges(repoRoot)) {
    return {
      ok: false,
      stdout: '',
      stderr: '',
      message: 'Commit, stash, or discard your tracked changes before creating a branch here.',
    }
  }
  return runGitCommand(repoRoot, ['checkout', '-b', branchName.trim(), hash])
}

export async function createGitTagFromCommit(
  repoRoot: string,
  tagName: string,
  commitHash: string
): Promise<GitCommandResult> {
  const hash = commitHash.trim()
  if (!COMMIT_HASH_PATTERN.test(hash)) return invalidCommit()
  const invalid = validateRefName(tagName, 'tag')
  if (invalid) return invalid
  return runGitCommand(repoRoot, ['tag', tagName.trim(), hash])
}
