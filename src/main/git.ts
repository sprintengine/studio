import { cp, mkdir, readFile, writeFile } from 'fs/promises'
import { dirname, isAbsolute, join, resolve } from 'path'
import {
  getRelativeGitPath,
  isInsideRepo,
  normalizeComparablePath,
  pathExists,
  runGit,
  runGitCommand,
  toAbsolutePath,
  toFilesystemPath,
  toPosixPath,
} from './git-utils'
import { listGitWorktrees } from './git-worktree-list'
import {
  resolveRepoRoot,
  resolveWorktreeDestination,
  toWorktreeResult,
  validateBaseRef,
  validateBranchName,
} from './git-worktree-validation'
import { getGitStatus } from './git-status'

export { listGitWorktrees, parseGitWorktreePorcelain } from './git-worktree-list'
export { getGitStatus } from './git-status'
export { getGitBranches, getGitHistory, getGitCommitGraph } from './git-read-models'
export {
  discardUnstagedGitChanges,
  revertGitPaths,
  stageGitPaths,
  unstageGitPaths,
} from './git-file-actions'
export {
  checkoutGitCommit,
  checkoutGitCommitAsBranch,
  commitGitChanges,
  createGitBranchFromCommit,
  createGitTagFromCommit,
  fetchGitRemotes,
  pullGitBranchWithStash,
  pushGitBranch,
  switchGitBranch,
} from './git-branch-actions'

export type GitFileStatus = 'new' | 'modified' | 'deleted' | 'renamed' | 'conflicted'

export type GitStatusEntry = {
  path: string
  relativePath: string
  status: GitFileStatus
  staged: boolean
  unstaged: boolean
}

export type GitStatusSnapshot = {
  repoRoot: string
  files: Record<string, GitStatusEntry>
  updatedAt: number
}

export type GitFileBaseResult =
  | { ok: true; content: string }
  | { ok: false; message: string }

export type GitBranch = {
  name: string
  current: boolean
  upstream: string | null
}

export type GitBranchSnapshot = {
  current: string | null
  branches: GitBranch[]
  ahead: number
  behind: number
}

export type GitCommit = {
  hash: string
  shortHash: string
  author: string
  date: string
  refs: string[]
  subject: string
  commitWebUrl: string | null
}

export type GitHistorySnapshot = {
  commits: GitCommit[]
  refs: GitRef[]
  totalCount: number
  updatedAt: number
}

export type GitGraphCommit = GitCommit & {
  parents: string[]
}

export type GitGraphSnapshot = {
  commits: GitGraphCommit[]
  refs: GitRef[]
  headHash: string | null
  detached: boolean
  totalCount: number
  hasMore: boolean
  updatedAt: number
}

export type GitGraphOptions = {
  limit?: number
  skip?: number
}

export type GitRef = {
  name: string
  hash: string
  type: 'head' | 'remote' | 'tag' | 'other'
}

export type GitCommandResult = {
  ok: boolean
  stdout: string
  stderr: string
  message: string | null
  pushedCommitCount?: number
}

export type GitWorktreeEntry = {
  path: string
  head: string | null
  branch: string | null
  branchRef: string | null
  detached: boolean
  bare: boolean
  locked: boolean
  lockedReason: string | null
  prunable: boolean
  prunableReason: string | null
}

export type GitWorktreeListSnapshot = {
  repoRoot: string
  worktrees: GitWorktreeEntry[]
  updatedAt: number
}

export type GitWorktreeCopyIncludedResult = {
  copied: string[]
  skipped: { path: string; reason: string }[]
}

export type GitWorktreeOperationResult<T> =
  | { ok: true; data: T; message: string | null; stdout?: string; stderr?: string }
  | { ok: false; message: string; stdout?: string; stderr?: string }

export type GitWorktreeCreateInput = {
  repoRoot: string
  containerPath: string
  destinationPath: string
  branchName: string
  baseRef: string
  copyIncludedFiles?: boolean
}

export type GitWorktreeRemoveInput = {
  repoRoot: string
  path: string
  force?: boolean
}

export type GitWorktreeRepairInput = {
  repoRoot: string
  path?: string
}

export type GitWorktreeCopyIncludedInput = {
  repoRoot: string
  worktreePath: string
}

export type GitConflictFile = {
  path: string
  relativePath: string
  status: string
}

export type GitConflictSnapshot = {
  repoRoot: string
  files: GitConflictFile[]
  updatedAt: number
}

export type GitConflictFileContent = {
  path: string
  relativePath: string
  base: string | null
  ours: string | null
  theirs: string | null
  result: string
}

export async function getGitRepoRoot(folderPath: string): Promise<string | null> {
  try {
    const stdout = await runGit(folderPath, ['rev-parse', '--show-toplevel'])
    return stdout.trim() || null
  } catch {
    return null
  }
}

export async function copyGitWorktreeIncludedFiles(
  input: GitWorktreeCopyIncludedInput
): Promise<GitWorktreeOperationResult<GitWorktreeCopyIncludedResult>> {
  const root = await resolveRepoRoot(input.repoRoot)
  if (!root.ok) return root

  const worktreePath = input.worktreePath
  const worktrees = await listGitWorktrees(root.data)
  if (!worktrees.ok) return worktrees

  const registeredWorktree = worktrees.data.worktrees.find(
    (worktree) => normalizeComparablePath(worktree.path) === normalizeComparablePath(worktreePath)
  )
  if (!registeredWorktree) {
    return {
      ok: false,
      message: `Worktree is not registered for this repository: ${worktreePath}`,
    }
  }

  if (!(await pathExists(worktreePath))) {
    return {
      ok: false,
      message: `Worktree path is missing: ${worktreePath}. Run worktree prune to clean up stale Git metadata.`,
    }
  }

  const includeFilePath = join(toFilesystemPath(root.data), '.worktreeinclude')
  const result: GitWorktreeCopyIncludedResult = {
    copied: [],
    skipped: [],
  }

  let includeFile = ''
  try {
    includeFile = await readFile(includeFilePath, 'utf8')
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code && code !== 'ENOENT') {
      return {
        ok: false,
        message: `Unable to read .worktreeinclude: ${includeFilePath}`,
      }
    }

    return {
      ok: true,
      data: result,
      message: 'No .worktreeinclude file found.',
    }
  }

  const entries = includeFile
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))

  for (const entry of entries) {
    if (isAbsolute(entry) || entry.split(/[\\/]/).includes('..')) {
      result.skipped.push({ path: entry, reason: 'Only repository-relative include paths are allowed.' })
      continue
    }

    if (/[*?[\]{}]/.test(entry)) {
      result.skipped.push({ path: entry, reason: 'Glob patterns are not supported; list explicit files or directories.' })
      continue
    }

    const sourcePath = join(root.data, ...entry.split(/[\\/]+/))
    const destinationPath = join(worktreePath, ...entry.split(/[\\/]+/))

    if (
      !normalizeComparablePath(sourcePath).startsWith(`${normalizeComparablePath(root.data)}/`)
      || !normalizeComparablePath(destinationPath).startsWith(`${normalizeComparablePath(worktreePath)}/`)
    ) {
      result.skipped.push({ path: entry, reason: 'Include path must stay inside the repository and target worktree.' })
      continue
    }

    if (!(await pathExists(sourcePath))) {
      result.skipped.push({ path: entry, reason: 'Source path does not exist.' })
      continue
    }

    try {
      const destinationFsPath = toFilesystemPath(destinationPath)
      await mkdir(dirname(destinationFsPath), { recursive: true })
      await cp(toFilesystemPath(sourcePath), destinationFsPath, {
        recursive: true,
        force: true,
        errorOnExist: false,
      })
      result.copied.push(entry)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      result.skipped.push({ path: entry, reason: message })
    }
  }

  return {
    ok: true,
    data: result,
    message: null,
  }
}

export async function createGitWorktree(
  input: GitWorktreeCreateInput
): Promise<GitWorktreeOperationResult<GitWorktreeEntry>> {
  const root = await resolveRepoRoot(input.repoRoot)
  if (!root.ok) return root

  const destination = resolveWorktreeDestination(input.containerPath, input.destinationPath)
  if (!destination.ok) return destination

  const branch = await validateBranchName(root.data, input.branchName)
  if (!branch.ok) return branch

  const baseRef = await validateBaseRef(root.data, input.baseRef)
  if (!baseRef.ok) return baseRef

  if (await pathExists(destination.data.destinationPath)) {
    return {
      ok: false,
      message: `Worktree destination already exists: ${destination.data.destinationPath}`,
    }
  }

  const existingWorktrees = await listGitWorktrees(root.data)
  if (!existingWorktrees.ok) return existingWorktrees

  const matchingWorktree = existingWorktrees.data.worktrees.find((worktree) => worktree.branch === branch.data)
  if (matchingWorktree) {
    return {
      ok: false,
      message: `Branch "${branch.data}" is already checked out at ${matchingWorktree.path}. Choose a different branch name or remove that worktree first.`,
    }
  }

  await mkdir(toFilesystemPath(destination.data.containerPath), { recursive: true })
  const addResult = await runGitCommand(root.data, [
    'worktree',
    'add',
    '-b',
    branch.data,
    destination.data.destinationPath,
    baseRef.data,
  ])

  if (!addResult.ok) {
    return {
      ok: false,
      message: addResult.message ?? 'Unable to create Git worktree.',
      stdout: addResult.stdout,
      stderr: addResult.stderr,
    }
  }

  if (input.copyIncludedFiles) {
    const copyResult = await copyGitWorktreeIncludedFiles({
      repoRoot: root.data,
      worktreePath: destination.data.destinationPath,
    })
    if (!copyResult.ok) return copyResult
  }

  const nextWorktrees = await listGitWorktrees(root.data)
  if (!nextWorktrees.ok) return nextWorktrees

  const createdWorktree = nextWorktrees.data.worktrees.find(
    (worktree) => normalizeComparablePath(worktree.path) === normalizeComparablePath(destination.data.destinationPath)
  )

  if (!createdWorktree) {
    return {
      ok: false,
      message: `Git created the worktree, but it was not reported by "git worktree list": ${destination.data.destinationPath}`,
      stdout: addResult.stdout,
      stderr: addResult.stderr,
    }
  }

  return {
    ok: true,
    data: createdWorktree,
    message: null,
    stdout: addResult.stdout,
    stderr: addResult.stderr,
  }
}

export async function removeGitWorktree(
  input: GitWorktreeRemoveInput
): Promise<GitWorktreeOperationResult<GitCommandResult>> {
  const root = await resolveRepoRoot(input.repoRoot)
  if (!root.ok) return root

  const worktreePath = input.path
  const worktrees = await listGitWorktrees(root.data)
  if (!worktrees.ok) return worktrees

  const registeredWorktree = worktrees.data.worktrees.find(
    (worktree) => normalizeComparablePath(worktree.path) === normalizeComparablePath(worktreePath)
  )
  if (!registeredWorktree) {
    return {
      ok: false,
      message: `Worktree is not registered for this repository: ${worktreePath}`,
    }
  }

  if (!(await pathExists(worktreePath))) {
    return {
      ok: false,
      message: `Worktree path is missing: ${worktreePath}. Run worktree prune to clean up stale Git metadata.`,
    }
  }

  if (!input.force) {
    const statusResult = await runGitCommand(worktreePath, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
    if (!statusResult.ok) {
      return {
        ok: false,
        message: statusResult.message ?? 'Unable to check whether the worktree is clean.',
        stdout: statusResult.stdout,
        stderr: statusResult.stderr,
      }
    }

    if (statusResult.stdout.length > 0) {
      return {
        ok: false,
        message: `Worktree has uncommitted changes: ${worktreePath}. Commit, stash, discard changes, or retry with force.`,
        stdout: statusResult.stdout,
        stderr: statusResult.stderr,
      }
    }
  }

  const removeResult = await runGitCommand(root.data, [
    'worktree',
    'remove',
    ...(input.force ? ['--force'] : []),
    worktreePath,
  ])

  return toWorktreeResult(removeResult, removeResult)
}

export async function pruneGitWorktrees(repoRoot: string): Promise<GitWorktreeOperationResult<GitCommandResult>> {
  const root = await resolveRepoRoot(repoRoot)
  if (!root.ok) return root

  const result = await runGitCommand(root.data, ['worktree', 'prune'])
  return toWorktreeResult(result, result)
}

export async function repairGitWorktrees(
  input: GitWorktreeRepairInput
): Promise<GitWorktreeOperationResult<GitCommandResult>> {
  const root = await resolveRepoRoot(input.repoRoot)
  if (!root.ok) return root

  const worktreePath = input.path?.trim() ? resolve(input.path) : null
  const result = await runGitCommand(root.data, [
    'worktree',
    'repair',
    ...(worktreePath ? [worktreePath] : []),
  ])

  return toWorktreeResult(result, result)
}

export async function getGitFileBase(repoRoot: string, filePath: string): Promise<GitFileBaseResult> {
  const absolutePath = isAbsolute(filePath) ? filePath : resolve(filePath)
  if (!isInsideRepo(repoRoot, absolutePath) && dirname(absolutePath) !== repoRoot) {
    return { ok: false, message: 'File is outside the Git repository.' }
  }

  try {
    const relativePath = getRelativeGitPath(repoRoot, absolutePath)
    const content = await runGit(repoRoot, ['show', `HEAD:${relativePath}`])
    return { ok: true, content }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, message }
  }
}

function normalizeConflictFilePath(repoRoot: string, filePath: string): { absolutePath: string; relativePath: string } | null {
  const absolutePath = isAbsolute(filePath) ? filePath : toAbsolutePath(repoRoot, toPosixPath(filePath))
  if (!isInsideRepo(repoRoot, absolutePath) && dirname(absolutePath) !== repoRoot) return null

  return {
    absolutePath,
    relativePath: getRelativeGitPath(repoRoot, absolutePath),
  }
}

export async function getGitConflicts(repoRoot: string): Promise<GitConflictSnapshot> {
  const snapshot = await getGitStatus(repoRoot)
  const files = Object.values(snapshot.files)
    .filter((entry) => entry.status === 'conflicted')
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath))
    .map((entry) => ({
      path: entry.path,
      relativePath: entry.relativePath,
      status: 'conflicted',
    }))

  return {
    repoRoot: snapshot.repoRoot,
    files,
    updatedAt: Date.now(),
  }
}

async function getGitConflictStage(repoRoot: string, stage: 1 | 2 | 3, relativePath: string): Promise<string | null> {
  const result = await runGitCommand(repoRoot, ['show', `:${stage}:${relativePath}`])
  return result.ok ? result.stdout : null
}

export async function getGitConflictFile(repoRoot: string, filePath: string): Promise<GitConflictFileContent | null> {
  const normalized = normalizeConflictFilePath(repoRoot, filePath)
  if (!normalized) return null

  const [base, ours, theirs] = await Promise.all([
    getGitConflictStage(repoRoot, 1, normalized.relativePath),
    getGitConflictStage(repoRoot, 2, normalized.relativePath),
    getGitConflictStage(repoRoot, 3, normalized.relativePath),
  ])

  let result = ''
  try {
    result = await readFile(toFilesystemPath(normalized.absolutePath), 'utf8')
  } catch {
    result = ''
  }

  return {
    path: normalized.absolutePath,
    relativePath: normalized.relativePath,
    base,
    ours,
    theirs,
    result,
  }
}

export async function resolveGitConflict(
  repoRoot: string,
  filePath: string,
  content: string
): Promise<GitCommandResult> {
  const normalized = normalizeConflictFilePath(repoRoot, filePath)
  if (!normalized) {
    return { ok: false, stdout: '', stderr: '', message: 'File is outside the Git repository.' }
  }

  await writeFile(toFilesystemPath(normalized.absolutePath), content, 'utf8')
  return runGitCommand(repoRoot, ['add', '--', normalized.relativePath])
}
