import type {
  GitFileStatus,
  GitStatusEntry,
  GitStatusSnapshot,
} from './git'
import { runGit, toAbsolutePath } from './git-utils'

type GitStatusCode = {
  index: string
  worktree: string
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
