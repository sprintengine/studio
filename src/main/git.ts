import { execFile } from 'child_process'
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

type GitStatusCode = {
  index: string
  worktree: string
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

    return { ok: true, stdout, stderr, message: null }
  } catch (error) {
    const execError = error as { stdout?: string; stderr?: string; message?: string }
    return {
      ok: false,
      stdout: execError.stdout ?? '',
      stderr: execError.stderr ?? '',
      message: execError.stderr?.trim() || execError.message || 'Git command failed.',
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

export async function commitGitChanges(repoRoot: string, message: string): Promise<GitCommandResult> {
  const trimmedMessage = message.trim()
  if (!trimmedMessage) {
    return { ok: false, stdout: '', stderr: '', message: 'Enter a commit message.' }
  }

  return runGitCommand(repoRoot, ['commit', '-m', trimmedMessage])
}

export async function pushGitBranch(repoRoot: string): Promise<GitCommandResult> {
  return runGitCommand(repoRoot, ['push'])
}

export async function switchGitBranch(repoRoot: string, branchName: string): Promise<GitCommandResult> {
  const trimmedBranch = branchName.trim()
  if (!trimmedBranch) {
    return { ok: false, stdout: '', stderr: '', message: 'Choose a branch.' }
  }

  return runGitCommand(repoRoot, ['switch', trimmedBranch])
}
