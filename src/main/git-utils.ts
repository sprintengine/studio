import { stat } from 'fs/promises'
import { isAbsolute, join, relative, resolve } from 'path'
import { comparablePath, wslToWindowsPath } from '../shared/host-paths'

// The runner lives in its own module (deadlines, lock policy, environment);
// every caller that already imports it from here keeps doing so.
export { runGit, runGitCommand, gitEnv } from './git-run'

export function toPosixPath(pathValue: string): string {
  return pathValue.replace(/\\/g, '/')
}

export function toFilesystemPath(pathValue: string): string {
  return process.platform === 'win32' ? wslToWindowsPath(pathValue) : pathValue
}

export function normalizeComparablePath(pathValue: string): string {
  return comparablePath(pathValue)
}

export function toAbsolutePath(repoRoot: string, relativePath: string): string {
  return join(repoRoot, ...relativePath.split('/'))
}

export function getRelativeGitPath(repoRoot: string, filePath: string): string {
  const absolutePath = isAbsolute(filePath) ? filePath : resolve(filePath)
  return toPosixPath(relative(repoRoot, absolutePath))
}

/**
 * A path, said to git as a path.
 *
 * Every argument after `--` is a PATHSPEC, not a filename: `src/[id].tsx` is a
 * character class that matches `src/i.tsx`, `a?b.ts` matches `axb.ts`, and a
 * leading `:` is magic of its own. The renderer only ever names files that
 * exist, so `:(literal)` is what says "this string, exactly" — and it matters
 * most on the destructive side, where a glob would restore or clean a file
 * nobody selected.
 */
export function toPathspec(relativePath: string): string {
  return `:(literal)${relativePath}`
}

export function isInsideRepo(repoRoot: string, filePath: string): boolean {
  const relativePath = relative(repoRoot, filePath)
  return Boolean(relativePath) && !relativePath.startsWith('..') && !isAbsolute(relativePath)
}

export async function pathExists(pathValue: string): Promise<boolean> {
  try {
    await stat(toFilesystemPath(pathValue))
    return true
  } catch {
    return false
  }
}
