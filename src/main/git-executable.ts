// Which file to start when the app runs git.
//
// Everywhere but Windows that is `git`, and the OS finds it. On Windows the
// git that Git for Windows' installer puts on PATH is `<Git>\cmd\git.exe` (the
// portable build's is `<Git>\bin\git.exe`), and that is not git: it is a small
// launcher that sets up the environment and starts the real binary under
// `<Git>\<build>\bin\`. Every git command the app runs through it costs a
// second process, and the app runs a lot of them — every view that shows a
// branch, a diff or a status polls one. Starting the real binary directly
// skips that process. It loses nothing when MSYSTEM is unset: the real git.exe
// then sets HOME and puts its own folders on PATH itself, which is what hooks
// (`#!/bin/sh`), ssh and credential helpers need. When MSYSTEM is set (git
// started from a Git Bash or MSYS2 shell) it adds those folders only if they
// are already there, so the launcher stays.

import { stat } from 'node:fs/promises'
import { win32 } from 'node:path'

import { resolveWindowsProgramOnPath } from './command-on-path'

// Git for Windows 2.56 moved x64 builds from mingw64 to ucrt64; ARM64 builds
// live in clangarm64 and 32-bit ones in mingw32. The newest layout is asked
// first, since an upgrade that left an old folder behind runs the new build.
const GIT_FOR_WINDOWS_BUILDS = ['ucrt64', 'clangarm64', 'mingw64', 'mingw32'] as const

export type GitExecutableDeps = {
  /** True when `path` is an existing regular file. */
  isFile?: (path: string) => Promise<boolean>
}

async function isFileOnDisk(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/**
 * The PATH a child given `env` would search. A copy of `process.env` on
 * Windows keeps the variable's own spelling, which is usually `Path`.
 */
function pathValueOf(env: NodeJS.ProcessEnv): string {
  if (env.PATH !== undefined) return env.PATH
  if (env.Path !== undefined) return env.Path
  for (const [key, value] of Object.entries(env)) if (key.toUpperCase() === 'PATH' && value !== undefined) return value
  return ''
}

/**
 * The git a Windows child with `env` should start: the real git.exe behind Git
 * for Windows' launcher when the git found first on PATH is that launcher,
 * otherwise plain `git`, leaving the lookup to the OS as before.
 */
export async function resolveGitForWindows(env: NodeJS.ProcessEnv, deps: GitExecutableDeps = {}): Promise<string> {
  if (env.MSYSTEM) return 'git'
  const isFile = deps.isFile ?? isFileOnDisk
  const found = await resolveWindowsProgramOnPath('git', { pathValue: pathValueOf(env), exists: isFile })
  if (found === null || win32.basename(found).toLowerCase() !== 'git.exe') return 'git'
  const launcherDirectory = win32.dirname(found)
  const launcherFolder = win32.basename(launcherDirectory).toLowerCase()
  if (launcherFolder !== 'cmd' && launcherFolder !== 'bin') return 'git'
  const installRoot = win32.dirname(launcherDirectory)
  for (const build of GIT_FOR_WINDOWS_BUILDS) {
    const candidate = win32.join(installRoot, build, 'bin', 'git.exe')
    if (await isFile(candidate)) return candidate
  }
  return 'git'
}

// One lookup per PATH (and MSYSTEM) for the life of the process: the scan
// stats a file in every PATH folder, which would otherwise run before every
// git command. PATH rarely differs between callers, so the map stays tiny; the
// cap only bounds a caller that builds a new PATH per command.
const MAX_REMEMBERED_PATHS = 8
const remembered = new Map<string, Promise<string>>()

function rememberedGitForWindows(env: NodeJS.ProcessEnv, deps: GitExecutableDeps): Promise<string> {
  const key = `${env.MSYSTEM ? 'msystem' : ''}\0${pathValueOf(env)}`
  const known = remembered.get(key)
  if (known) return known
  if (remembered.size >= MAX_REMEMBERED_PATHS) remembered.clear()
  const lookup = resolveGitForWindows(env, deps)
  remembered.set(key, lookup)
  return lookup
}

/** Forgets every remembered lookup. For tests, and for a binary that went missing. */
export function forgetGitExecutable(): void {
  remembered.clear()
}

/**
 * Runs `start` with the git file to spawn for a child with `env`. `start` is
 * called synchronously off Windows, so a caller that spawns there sees no
 * change in timing.
 *
 * The lookup is remembered, so a Git for Windows upgrade that moves the real
 * binary (2.56 moved mingw64 to ucrt64) would leave a path that no longer
 * exists. When the remembered binary could not be started, the lookup is made
 * again and `start` runs once more — a process that never started has done
 * nothing that a second attempt could repeat. `didNotStart` reads that from a
 * result, for runners that report a failed spawn instead of throwing; a thrown
 * ENOENT always counts.
 */
export async function withGitExecutable<T>(
  env: NodeJS.ProcessEnv,
  start: (file: string) => Promise<T>,
  options: { didNotStart?: (result: T) => boolean; platform?: NodeJS.Platform } & GitExecutableDeps = {},
): Promise<T> {
  if ((options.platform ?? process.platform) !== 'win32') return start('git')
  const file = await rememberedGitForWindows(env, options)
  if (file === 'git') return start(file)
  let result: T
  try {
    result = await start(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error
    forgetGitExecutable()
    return start(await rememberedGitForWindows(env, options))
  }
  if (!options.didNotStart?.(result)) return result
  forgetGitExecutable()
  return start(await rememberedGitForWindows(env, options))
}
