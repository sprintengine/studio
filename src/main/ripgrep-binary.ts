import { existsSync } from 'fs'

// Where the search panels' ripgrep lives, and what to say when it cannot run.
//
// The ripgrep package resolves its binary with `require.resolve`, which in a
// packaged app answers a path INSIDE app.asar
// (`…/resources/app.asar/node_modules/@vscode/ripgrep-win32-x64/bin/rg.exe`).
// Electron's fs can read that path, so it looks present, but no OS can execute
// a file out of an archive: Windows reports `spawn … ENOENT` and macOS throws
// `ENOTDIR` before the child exists. electron-builder puts the real file in
// app.asar.unpacked (`asarUnpack` in package.json names the platform packages
// so that does not rest on its own detection), so the path is rewritten to
// point there. In dev nothing is packed and the path is left alone.

export type RipgrepBinary = { ok: true; path: string } | { ok: false; message: string }

const ASAR_SEGMENT = /([\\/])app\.asar(?=[\\/])/u

/** The same path with its app.asar segment moved to app.asar.unpacked; unchanged outside an archive. */
export function unpackedAsarPath(path: string): string {
  return path.replace(ASAR_SEGMENT, '$1app.asar.unpacked')
}

export async function locateRipgrep(deps: {
  load: () => Promise<{ rgPath: string }>
  exists: (path: string) => boolean
}): Promise<RipgrepBinary> {
  let rgPath: string
  try {
    ;({ rgPath } = await deps.load())
  } catch (error) {
    // 1.18 throws at import when the platform package (an optional
    // dependency) was not installed for this OS and architecture.
    return {
      ok: false,
      message: `Search can't run: ripgrep isn't installed for ${process.platform}-${process.arch} (${errorMessage(error)}).`,
    }
  }
  const path = unpackedAsarPath(rgPath)
  if (!deps.exists(path)) {
    return { ok: false, message: `Search can't run: ripgrep is missing from this install (${path}).` }
  }
  return { ok: true, path }
}

let located: Promise<RipgrepBinary> | null = null

/**
 * The packaged or dev ripgrep, located once per process — an install does not
 * gain or lose its binary while it runs. Loaded lazily, so a missing platform
 * package costs search rather than main's startup.
 */
export function ripgrepBinary(): Promise<RipgrepBinary> {
  located ??= locateRipgrep({ load: () => import('@vscode/ripgrep'), exists: existsSync })
  return located
}

/**
 * A binary that exists but will not start (blocked by security software, no
 * execute permission) is no more use than a missing one, and trying it again
 * on every keystroke only fails again: later lookups answer `message`.
 */
export function markRipgrepUnusable(message: string): void {
  located = Promise.resolve({ ok: false, message })
}

// Codes that mean the binary itself cannot be run, as opposed to a passing
// shortage (EAGAIN, EMFILE) that the next query may not hit.
const START_FAILURE_CODES = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'UNKNOWN'])

/**
 * A spawn failure in words a person can act on. `spawn C:\…\rg.exe ENOENT` is
 * the raw form, and reads as a bug in their folder rather than in the install.
 * `unusable` says whether the binary should be given up on for this process.
 */
export function describeRipgrepSpawnFailure(
  binaryPath: string,
  error: unknown,
): { message: string; unusable: boolean } {
  const code = (error as NodeJS.ErrnoException | null)?.code
  if (code && START_FAILURE_CODES.has(code)) {
    return { message: `Search can't run: ripgrep at ${binaryPath} could not be started (${code}).`, unusable: true }
  }
  return { message: errorMessage(error), unusable: false }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
