import type {
  GitCommandResult,
  GitStatusEntry,
  GitStatusSnapshot,
} from './git'
import { getGitStatus } from './git-status'
import {
  getRelativeGitPath,
  runGitCommand,
  toAbsolutePath,
  toPathspec,
  toPosixPath,
} from './git-utils'
import { isAbsolute } from 'path'

// Everything after `--` is a pathspec, so every renderer-supplied path goes
// through `toPathspec`: a file really called `src/[id].tsx` is a character
// class otherwise, and `restore`/`clean` below would then act on whatever else
// it happened to match rather than on the file the person selected.
function pathspecsFor(repoRoot: string, paths: string[]): string[] {
  return paths.map((path) => toPathspec(getRelativeGitPath(repoRoot, path)))
}

export async function stageGitPaths(repoRoot: string, paths: string[]): Promise<GitCommandResult> {
  if (!paths.length) return runGitCommand(repoRoot, ['add', '-A'])
  return runGitCommand(repoRoot, ['add', '--', ...pathspecsFor(repoRoot, paths)])
}

export async function unstageGitPaths(repoRoot: string, paths: string[]): Promise<GitCommandResult> {
  if (!paths.length) return runGitCommand(repoRoot, ['restore', '--staged', '.'])
  return runGitCommand(repoRoot, ['restore', '--staged', '--', ...pathspecsFor(repoRoot, paths)])
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

/** The selected entries as pathspecs — literal, for the reason above. */
function entryPathspecs(repoRoot: string, entries: GitStatusEntry[]): string[] {
  return pathspecsFor(repoRoot, entries.map((entry) => entry.path))
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
    results.push(await runGitCommand(repoRoot, ['restore', '--staged', '--worktree', '--', ...entryPathspecs(repoRoot, trackedEntries)]))
  }

  if (stagedAdditions.length) {
    results.push(await runGitCommand(repoRoot, ['restore', '--staged', '--', ...entryPathspecs(repoRoot, stagedAdditions)]))
  }

  const cleanEntries = uniqueEntries([...untrackedEntries, ...stagedAdditions])
  if (cleanEntries.length) {
    results.push(await runGitCommand(repoRoot, ['clean', '-f', '--', ...entryPathspecs(repoRoot, cleanEntries)]))
  }

  return combineCommandResults(results, 'No file changes to revert.')
}
