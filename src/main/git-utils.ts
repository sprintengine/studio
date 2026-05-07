import { execFile } from 'child_process'
import { stat } from 'fs/promises'
import { isAbsolute, join, relative, resolve } from 'path'
import { promisify } from 'util'
import type { GitCommandResult } from './git'

const execFileAsync = promisify(execFile)

function removeLineEndingWarnings(output: string): string {
  return output
    .split(/\r?\n/)
    .filter((line) => !/^warning: in the working copy of '.+', (?:LF|CRLF) will be replaced by (?:LF|CRLF) the next time Git touches it$/.test(line.trim()))
    .join('\n')
    .trim()
}

export async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    windowsHide: true,
  })

  return stdout
}

export async function runGitCommand(cwd: string, args: string[]): Promise<GitCommandResult> {
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

export function toPosixPath(pathValue: string): string {
  return pathValue.replace(/\\/g, '/')
}

export function toWindowsPath(pathValue: string): string {
  const normalized = toPosixPath(pathValue)
  const wslMatch = normalized.match(/^\/mnt\/([A-Za-z])\/(.*)$/)
  if (!wslMatch) return pathValue

  const [, drive, rest] = wslMatch
  return `${drive.toUpperCase()}:\\${rest.replace(/\//g, '\\')}`
}

export function toFilesystemPath(pathValue: string): string {
  return process.platform === 'win32' ? toWindowsPath(pathValue) : pathValue
}

export function normalizeComparablePath(pathValue: string): string {
  const normalized = toPosixPath(pathValue).replace(/\/+$/, '')
  const wslMatch = normalized.match(/^\/mnt\/([A-Za-z])\/(.*)$/)
  const comparable = wslMatch
    ? `${wslMatch[1].toUpperCase()}:/${wslMatch[2]}`
    : normalized

  return /^[A-Za-z]:/.test(comparable) ? comparable.toLowerCase() : comparable
}

export function toAbsolutePath(repoRoot: string, relativePath: string): string {
  return join(repoRoot, ...relativePath.split('/'))
}

export function getRelativeGitPath(repoRoot: string, filePath: string): string {
  const absolutePath = isAbsolute(filePath) ? filePath : resolve(filePath)
  return toPosixPath(relative(repoRoot, absolutePath))
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
