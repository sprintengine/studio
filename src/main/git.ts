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
    unstaged: code.worktree !== ' ' && code.worktree !== '?',
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
