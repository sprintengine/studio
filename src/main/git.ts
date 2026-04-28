import { execFile } from 'child_process'
import { cp, mkdir, readFile, stat } from 'fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'path'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

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

type GitStatusCode = {
  index: string
  worktree: string
}

function removeLineEndingWarnings(output: string): string {
  return output
    .split(/\r?\n/)
    .filter((line) => !/^warning: in the working copy of '.+', (?:LF|CRLF) will be replaced by (?:LF|CRLF) the next time Git touches it$/.test(line.trim()))
    .join('\n')
    .trim()
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    windowsHide: true,
  })

  return stdout
}

async function runGitCommand(cwd: string, args: string[]): Promise<GitCommandResult> {
  try {
    const { stdout, stderr } = await execFileAsync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      windowsHide: true,
    })

    return { ok: true, stdout, stderr: removeLineEndingWarnings(stderr), message: null }
  } catch (error) {
    const execError = error as { stdout?: string; stderr?: string; message?: string }
    const stderr = removeLineEndingWarnings(execError.stderr ?? '')
    return {
      ok: false,
      stdout: execError.stdout ?? '',
      stderr,
      message: stderr || removeLineEndingWarnings(execError.message ?? '') || 'Git command failed.',
    }
  }
}

export async function getGitRepoRoot(folderPath: string): Promise<string | null> {
  try {
    const stdout = await runGit(folderPath, ['rev-parse', '--show-toplevel'])
    return stdout.trim() || null
  } catch {
    return null
  }
}

function toPosixPath(pathValue: string): string {
  return pathValue.replace(/\\/g, '/')
}

function toWindowsPath(pathValue: string): string {
  const normalized = toPosixPath(pathValue)
  const wslMatch = normalized.match(/^\/mnt\/([A-Za-z])\/(.*)$/)
  if (!wslMatch) return pathValue

  const [, drive, rest] = wslMatch
  return `${drive.toUpperCase()}:\\${rest.replace(/\//g, '\\')}`
}

function toFilesystemPath(pathValue: string): string {
  return process.platform === 'win32' ? toWindowsPath(pathValue) : pathValue
}

function normalizeComparablePath(pathValue: string): string {
  const normalized = toPosixPath(pathValue).replace(/\/+$/, '')
  const wslMatch = normalized.match(/^\/mnt\/([A-Za-z])\/(.*)$/)
  const comparable = wslMatch
    ? `${wslMatch[1].toUpperCase()}:/${wslMatch[2]}`
    : normalized

  return /^[A-Za-z]:/.test(comparable) ? comparable.toLowerCase() : comparable
}

function toAbsolutePath(repoRoot: string, relativePath: string): string {
  return join(repoRoot, ...relativePath.split('/'))
}

function getRelativeGitPath(repoRoot: string, filePath: string): string {
  const absolutePath = isAbsolute(filePath) ? filePath : resolve(filePath)
  return toPosixPath(relative(repoRoot, absolutePath))
}

function isInsideRepo(repoRoot: string, filePath: string): boolean {
  const relativePath = relative(repoRoot, filePath)
  return Boolean(relativePath) && !relativePath.startsWith('..') && !isAbsolute(relativePath)
}

async function pathExists(pathValue: string): Promise<boolean> {
  try {
    await stat(toFilesystemPath(pathValue))
    return true
  } catch {
    return false
  }
}

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

function githubWebUrlFromRemote(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim()
  if (!trimmed) return null

  const sshMatch = trimmed.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/)
  if (sshMatch) return `https://github.com/${sshMatch[1]}/${sshMatch[2]}`

  const sshUrlMatch = trimmed.match(/^ssh:\/\/git@github\.com\/([^/]+)\/(.+?)(?:\.git)?$/)
  if (sshUrlMatch) return `https://github.com/${sshUrlMatch[1]}/${sshUrlMatch[2]}`

  const httpsMatch = trimmed.match(/^https:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/)
  if (httpsMatch) return `https://github.com/${httpsMatch[1]}/${httpsMatch[2]}`

  return null
}

async function getGitHubRepoWebUrl(repoRoot: string): Promise<string | null> {
  try {
    const originUrl = await runGit(repoRoot, ['remote', 'get-url', 'origin'])
    const webUrl = githubWebUrlFromRemote(originUrl)
    if (webUrl) return webUrl
  } catch {
    // Ignore missing origin; fall through to scanning all remotes.
  }

  try {
    const remotes = await runGit(repoRoot, ['remote', '-v'])
    for (const line of remotes.split(/\r?\n/)) {
      const [, remoteUrl = ''] = line.trim().split(/\s+/)
      const webUrl = githubWebUrlFromRemote(remoteUrl)
      if (webUrl) return webUrl
    }
  } catch {
    return null
  }

  return null
}

export function parseGitWorktreePorcelain(output: string): GitWorktreeEntry[] {
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

async function resolveRepoRoot(repoRoot: string): Promise<GitWorktreeOperationResult<string>> {
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

function resolveWorktreeDestination(containerPath: string, destinationPath: string): GitWorktreeOperationResult<{
  containerPath: string
  destinationPath: string
}> {
  const resolvedContainer = containerPath
  const resolvedDestination = isAbsolute(destinationPath)
    ? destinationPath
    : resolve(resolvedContainer, destinationPath)

  const comparableContainer = normalizeComparablePath(resolvedContainer)
  const comparableDestination = normalizeComparablePath(resolvedDestination)
  if (
    comparableDestination !== comparableContainer
    && !comparableDestination.startsWith(`${comparableContainer}/`)
  ) {
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

async function validateBranchName(repoRoot: string, branchName: string): Promise<GitWorktreeOperationResult<string>> {
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

async function validateBaseRef(repoRoot: string, baseRef: string): Promise<GitWorktreeOperationResult<string>> {
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

function toWorktreeResult<T>(
  result: GitCommandResult,
  data: T,
  successMessage: string | null = null
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

function isConflictStatus({ index, worktree }: GitStatusCode): boolean {
  return index === 'U' || worktree === 'U' || (index === 'A' && worktree === 'A') || (index === 'D' && worktree === 'D')
}

function toFileStatus(code: GitStatusCode): GitFileStatus {
  if (code.index === '?' && code.worktree === '?') return 'new'
  if (isConflictStatus(code)) return 'conflicted'
  if (code.index === 'R' || code.worktree === 'R') return 'renamed'
  if (code.index === 'A' || code.worktree === 'A') return 'new'
  if (code.index === 'D' || code.worktree === 'D') return 'deleted'
  return 'modified'
}

function parseStatusEntry(repoRoot: string, code: GitStatusCode, relativePath: string): GitStatusEntry {
  return {
    path: toAbsolutePath(repoRoot, relativePath),
    relativePath,
    status: toFileStatus(code),
    staged: code.index !== ' ' && code.index !== '?',
    unstaged: code.index === '?' || code.worktree !== ' ',
  }
}

export async function getGitStatus(repoRoot: string): Promise<GitStatusSnapshot> {
  const stdout = await runGit(repoRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  const records = stdout.split('\0').filter(Boolean)
  const files: Record<string, GitStatusEntry> = {}

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (record.length < 4) continue

    const code = { index: record[0] ?? ' ', worktree: record[1] ?? ' ' }
    const relativePath = record.slice(3)
    const entry = parseStatusEntry(repoRoot, code, relativePath)
    files[entry.path] = entry

    if (code.index === 'R' || code.worktree === 'R') {
      const originalPath = records[index + 1]
      if (originalPath) {
        const deletedEntry = parseStatusEntry(repoRoot, { index: 'D', worktree: ' ' }, originalPath)
        files[deletedEntry.path] = deletedEntry
        index += 1
      }
    }
  }

  return {
    repoRoot,
    files,
    updatedAt: Date.now(),
  }
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
