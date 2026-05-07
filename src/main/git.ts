import { cp, mkdir, readFile } from 'fs/promises'
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
import { getGitHubRepoWebUrl } from './git-github'
import { getGitStatus } from './git-status'
import { listGitWorktrees } from './git-worktree-list'
import {
  resolveRepoRoot,
  resolveWorktreeDestination,
  toWorktreeResult,
  validateBaseRef,
  validateBranchName,
} from './git-worktree-validation'

export { listGitWorktrees, parseGitWorktreePorcelain } from './git-worktree-list'
export { getGitStatus } from './git-status'

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
  updatedAt: number
}

export type GitCommandResult = {
  ok: boolean
  stdout: string
  stderr: string
  message: string | null
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

export async function getGitBranches(repoRoot: string): Promise<GitBranchSnapshot> {
  const branchOutput = await runGit(repoRoot, [
    'branch',
    '--format=%(refname:short)%09%(HEAD)%09%(upstream:short)',
    '--sort=refname',
  ])
  const branches = branchOutput
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [name, head, upstream] = line.split('\t')
      return {
        name,
        current: head === '*',
        upstream: upstream || null,
      }
    })
  const current = branches.find((branch) => branch.current)?.name ?? null
  let ahead = 0
  let behind = 0

  try {
    const counts = await runGit(repoRoot, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'])
    const [aheadText, behindText] = counts.trim().split(/\s+/)
    ahead = Number.parseInt(aheadText ?? '0', 10) || 0
    behind = Number.parseInt(behindText ?? '0', 10) || 0
  } catch {
    // Repositories without an upstream simply have no ahead/behind counts.
  }

  return { current, branches, ahead, behind }
}

export async function getGitHistory(repoRoot: string, limit = 12): Promise<GitHistorySnapshot> {
  try {
    const safeLimit = Math.min(Math.max(Math.floor(limit), 1), 50)
    const githubRepoWebUrl = await getGitHubRepoWebUrl(repoRoot)
    const stdout = await runGit(repoRoot, [
      'log',
      `--max-count=${safeLimit}`,
      '--date=short',
      '--pretty=format:%H%x1f%h%x1f%an%x1f%ad%x1f%D%x1f%s%x1e',
    ])

    const commits = stdout
      .split('\x1e')
      .map((record) => record.trim())
      .filter(Boolean)
      .map((record) => {
        const [hash = '', shortHash = '', author = '', date = '', refsText = '', subject = ''] = record.split('\x1f')
        return {
          hash,
          shortHash,
          author,
          date,
          refs: refsText.split(',').map((ref) => ref.trim()).filter(Boolean),
          subject,
          commitWebUrl: githubRepoWebUrl ? `${githubRepoWebUrl}/commit/${hash}` : null,
        }
      })

    return { commits, updatedAt: Date.now() }
  } catch {
    return { commits: [], updatedAt: Date.now() }
  }
}

export async function stageGitPaths(repoRoot: string, paths: string[]): Promise<GitCommandResult> {
  if (!paths.length) return runGitCommand(repoRoot, ['add', '-A'])
  return runGitCommand(repoRoot, ['add', '--', ...paths.map((path) => getRelativeGitPath(repoRoot, path))])
}

export async function unstageGitPaths(repoRoot: string, paths: string[]): Promise<GitCommandResult> {
  if (!paths.length) return runGitCommand(repoRoot, ['restore', '--staged', '.'])
  return runGitCommand(repoRoot, ['restore', '--staged', '--', ...paths.map((path) => getRelativeGitPath(repoRoot, path))])
}

function uniqueEntries(entries: GitStatusEntry[]): GitStatusEntry[] {
  return [...new Map(entries.map((entry) => [entry.path, entry])).values()]
}

function getSelectedStatusEntries(snapshot: GitStatusSnapshot, paths: string[]): GitStatusEntry[] {
  if (!paths.length) return uniqueEntries(Object.values(snapshot.files))

  return uniqueEntries(
    paths
      .map((path) => {
        const absolutePath = isAbsolute(path) ? path : toAbsolutePath(snapshot.repoRoot, toPosixPath(path))
        return snapshot.files[absolutePath]
      })
      .filter((entry): entry is GitStatusEntry => Boolean(entry))
  )
}

function isUntrackedEntry(entry: GitStatusEntry): boolean {
  return entry.status === 'new' && !entry.staged
}

function isStagedAddition(entry: GitStatusEntry): boolean {
  return entry.status === 'new' && entry.staged
}

function relativePaths(repoRoot: string, entries: GitStatusEntry[]): string[] {
  return entries.map((entry) => getRelativeGitPath(repoRoot, entry.path))
}

function combineCommandResults(results: GitCommandResult[], emptyMessage: string): GitCommandResult {
  if (!results.length) {
    return { ok: true, stdout: '', stderr: '', message: emptyMessage }
  }

  const failed = results.find((result) => !result.ok)
  if (failed) return failed

  return {
    ok: true,
    stdout: results.map((result) => result.stdout).filter(Boolean).join('\n'),
    stderr: results.map((result) => result.stderr).filter(Boolean).join('\n'),
    message: null,
  }
}

export async function revertGitPaths(repoRoot: string, paths: string[]): Promise<GitCommandResult> {
  const snapshot = await getGitStatus(repoRoot)
  const entries = getSelectedStatusEntries(snapshot, paths)
  const trackedEntries = entries.filter((entry) => !isUntrackedEntry(entry) && !isStagedAddition(entry))
  const stagedAdditions = entries.filter(isStagedAddition)
  const untrackedEntries = entries.filter(isUntrackedEntry)
  const results: GitCommandResult[] = []

  if (trackedEntries.length) {
    results.push(await runGitCommand(repoRoot, ['restore', '--staged', '--worktree', '--', ...relativePaths(repoRoot, trackedEntries)]))
  }

  if (stagedAdditions.length) {
    results.push(await runGitCommand(repoRoot, ['restore', '--staged', '--', ...relativePaths(repoRoot, stagedAdditions)]))
  }

  const cleanEntries = uniqueEntries([...untrackedEntries, ...stagedAdditions])
  if (cleanEntries.length) {
    results.push(await runGitCommand(repoRoot, ['clean', '-f', '--', ...relativePaths(repoRoot, cleanEntries)]))
  }

  return combineCommandResults(results, 'No file changes to revert.')
}

export async function discardUnstagedGitChanges(repoRoot: string, paths: string[]): Promise<GitCommandResult> {
  const snapshot = await getGitStatus(repoRoot)
  const entries = getSelectedStatusEntries(snapshot, paths).filter((entry) => entry.unstaged)
  const trackedEntries = entries.filter((entry) => !isUntrackedEntry(entry))
  const untrackedEntries = entries.filter(isUntrackedEntry)
  const results: GitCommandResult[] = []

  if (trackedEntries.length) {
    results.push(await runGitCommand(repoRoot, ['restore', '--worktree', '--', ...relativePaths(repoRoot, trackedEntries)]))
  }

  if (untrackedEntries.length) {
    results.push(await runGitCommand(repoRoot, ['clean', '-f', '--', ...relativePaths(repoRoot, untrackedEntries)]))
  }

  return combineCommandResults(results, 'No unstaged changes to roll back.')
}

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
