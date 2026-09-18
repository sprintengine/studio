import { isAbsolute, resolve } from 'path'
import type { GitCommandResult, GitWorktreeOperationResult } from './git'
import { normalizeComparablePath, runGit, runGitCommand, toFilesystemPath, toPosixPath } from './git-utils'

export async function resolveRepoRoot(repoRoot: string): Promise<GitWorktreeOperationResult<string>> {
  const normalizedRoot = toPosixPath(repoRoot)
  const resolvedRoot = /^\/mnt\/[A-Za-z](?:\/|$)/.test(normalizedRoot)
    ? toFilesystemPath(normalizedRoot)
    : toFilesystemPath(resolve(repoRoot))
  const actualRoot = await getGitRepoRoot(resolvedRoot)

  if (!actualRoot) {
    return { ok: false, message: 'Choose a folder inside a Git repository before managing worktrees.' }
  }

  return { ok: true, data: actualRoot, message: null }
}

export function resolveWorktreeDestination(
  containerPath: string,
  destinationPath: string,
): GitWorktreeOperationResult<{
  containerPath: string
  destinationPath: string
}> {
  const resolvedContainer = containerPath
  const resolvedDestination = isAbsolute(destinationPath)
    ? destinationPath
    : resolve(resolvedContainer, destinationPath)

  const comparableContainer = normalizeComparablePath(resolvedContainer)
  const comparableDestination = normalizeComparablePath(resolvedDestination)
  if (comparableDestination !== comparableContainer && !comparableDestination.startsWith(`${comparableContainer}/`)) {
    return {
      ok: false,
      message: 'Worktree destination must be inside the configured worktree container.',
    }
  }

  return {
    ok: true,
    data: {
      containerPath: resolvedContainer,
      destinationPath: resolvedDestination,
    },
    message: null,
  }
}

export async function validateBranchName(
  repoRoot: string,
  branchName: string,
): Promise<GitWorktreeOperationResult<string>> {
  const trimmedBranch = branchName.trim()

  if (!trimmedBranch) {
    return { ok: false, message: 'Enter a branch name for the worktree.' }
  }

  if (trimmedBranch.startsWith('-')) {
    return { ok: false, message: 'Branch names cannot start with a dash.' }
  }

  const result = await runGitCommand(repoRoot, ['check-ref-format', '--branch', trimmedBranch])
  if (!result.ok) {
    return {
      ok: false,
      message: `Branch name "${trimmedBranch}" is not valid for Git.`,
      stdout: result.stdout,
      stderr: result.stderr,
    }
  }

  return { ok: true, data: result.stdout.trim() || trimmedBranch, message: null }
}

export async function validateBaseRef(repoRoot: string, baseRef: string): Promise<GitWorktreeOperationResult<string>> {
  const trimmedBaseRef = baseRef.trim()

  if (!trimmedBaseRef) {
    return { ok: false, message: 'Choose a base ref for the worktree.' }
  }

  if (trimmedBaseRef.startsWith('-')) {
    return { ok: false, message: 'Base refs cannot start with a dash.' }
  }

  const result = await runGitCommand(repoRoot, ['rev-parse', '--verify', '--quiet', `${trimmedBaseRef}^{commit}`])
  if (!result.ok) {
    return {
      ok: false,
      message: `Base ref "${trimmedBaseRef}" does not resolve to a commit.`,
      stdout: result.stdout,
      stderr: result.stderr,
    }
  }

  return { ok: true, data: trimmedBaseRef, message: null }
}

export function toWorktreeResult<T>(
  result: GitCommandResult,
  data: T,
  successMessage: string | null = null,
): GitWorktreeOperationResult<T> {
  if (result.ok) {
    return { ok: true, data, message: successMessage, stdout: result.stdout, stderr: result.stderr }
  }

  return {
    ok: false,
    message: result.message ?? 'Git worktree command failed.',
    stdout: result.stdout,
    stderr: result.stderr,
  }
}

async function getGitRepoRoot(folderPath: string): Promise<string | null> {
  try {
    const stdout = await runGit(folderPath, ['rev-parse', '--show-toplevel'])
    return stdout.trim() || null
  } catch {
    return null
  }
}
