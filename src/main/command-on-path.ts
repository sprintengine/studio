// Is this command something this machine can actually run?
//
// One spelling, because two surfaces ask it and they must agree: the MCP config
// service, which turns "command was not found" into a validation issue every
// time it syncs, and the plugin install, which says the same thing on the row
// the moment a plugin lands
// (backlog/2026-09-06-a-plugins-own-files-must-land-before-its-server-can-start.md).
//
// It answers about PATH as this process sees it. That is the honest scope: a
// login shell may have more, and a person who installs `bun` after the app
// started will not be seen until the app restarts — which is why this is a
// warning beside a completed install, never a refusal.

import { existsSync } from 'node:fs'
import { access } from 'node:fs/promises'
import { delimiter, isAbsolute, join, win32 } from 'node:path'

/** True when `command` is an absolute file that exists, or a name on PATH. */
export function commandOnPath(command: string): boolean {
  return candidatePaths(command).some((path) => existsSync(path))
}

/**
 * {@link commandOnPath} without blocking the thread: the MCP sync asks it on
 * every agent launch, and a PATH entry on a slow mount would otherwise stall
 * the main process for as long as that mount takes to answer.
 */
export async function commandOnPathAsync(command: string): Promise<boolean> {
  for (const path of candidatePaths(command)) {
    try {
      await access(path)
      return true
    } catch {
      // Not here; try the next candidate.
    }
  }
  return false
}

/** Every file whose existence would answer yes, in lookup order. */
function candidatePaths(command: string): string[] {
  const trimmed = command.trim()
  if (trimmed === '') return []
  if (isAbsolute(trimmed)) return [trimmed]
  const pathValue = process.env.PATH ?? process.env.Path ?? ''
  const names =
    process.platform === 'win32' ? [trimmed, `${trimmed}.cmd`, `${trimmed}.exe`, `${trimmed}.ps1`] : [trimmed]
  return pathValue.split(delimiter).flatMap((dir) => names.map((name) => join(dir, name)))
}

/**
 * The absolute path of a Windows program named `name`, found on PATH and
 * nowhere else — or null.
 *
 * A bare name handed to `spawn` on Windows is looked for in the child's working
 * directory before PATH. When that directory is a repository, whoever wrote the
 * repository decides what runs: a `gh.exe` committed at its root is started in
 * place of the real one, whether or not the real one is installed. Resolving
 * against PATH first and spawning the result closes that. Only absolute PATH
 * entries count, since an empty or relative entry (`.`) means "the working
 * directory" again. Only `.exe` and `.com` are taken: a `.cmd` or `.bat` would
 * run through `cmd.exe` and its quoting rules, which is a different door.
 */
export async function resolveWindowsProgramOnPath(
  name: string,
  environment: { pathValue?: string; exists?: (path: string) => Promise<boolean> } = {},
): Promise<string | null> {
  const pathValue = environment.pathValue ?? process.env.PATH ?? process.env.Path ?? ''
  const exists =
    environment.exists ??
    (async (path: string) => {
      try {
        await access(path)
        return true
      } catch {
        return false
      }
    })
  for (const dir of pathValue.split(';')) {
    const trimmed = dir.trim().replace(/^"(.*)"$/u, '$1')
    if (!win32.isAbsolute(trimmed)) continue
    for (const extension of ['.exe', '.com']) {
      const candidate = win32.join(trimmed, `${name}${extension}`)
      if (await exists(candidate)) return candidate
    }
  }
  return null
}
