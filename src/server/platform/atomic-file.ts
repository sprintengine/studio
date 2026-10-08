import { randomUUID } from 'node:crypto'
import { chmodSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { chmod, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

// ── Replacing a file whole ──────────────────────────────────────────────────
//
// A write never truncates in place. The new bytes go to a temporary file in the
// same directory and are renamed over the old one, so a reader (another
// process, or this one after a crash mid-write) sees the old file or the new
// one, never an empty or half-written one. A write that fails removes its
// temporary file and rethrows; what to do about it is the caller's decision.
//
// Platform-neutral on purpose: main, the server and the standalone server all
// write this way, and none of them should need Electron to do it.

export type AtomicWriteOptions = {
  /** Permission bits for the new file. Given to the write, so the umask still applies. */
  mode?: number
  /**
   * Set `mode` exactly once the bytes are written, rather than as the umask
   * leaves it. Skipped on Windows, which has no permission bits to set.
   */
  exactMode?: boolean
}

/**
 * The temporary file a write stages into: beside the target so the rename
 * stays on one filesystem, hidden, and unique per write so two writers never
 * share one. Ends in `.tmp`, which is what a sweep of leftovers looks for.
 */
function stagingPath(path: string): string {
  return join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`)
}

/**
 * Windows refuses a rename over a file another process has open without
 * FILE_SHARE_DELETE (an editor, a scanner, a CLI reading its config) for the
 * moment it holds it. A few short retries ride that out; elsewhere the rename
 * either works or fails for good.
 */
const RENAME_ATTEMPTS = 5

function renameIsRetryable(error: unknown, attempt: number): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  const transient = code === 'EPERM' || code === 'EACCES' || code === 'EBUSY'
  return process.platform === 'win32' && transient && attempt < RENAME_ATTEMPTS - 1
}

const renameRetryDelayMs = (attempt: number): number => 25 * (attempt + 1)

/** Replace `path` with `data` through a temporary file and a rename. */
export async function writeFileAtomic(path: string, data: string, options: AtomicWriteOptions = {}): Promise<void> {
  const temporary = stagingPath(path)
  try {
    await writeFile(temporary, data, { encoding: 'utf8', ...(options.mode === undefined ? {} : { mode: options.mode }) })
    if (options.exactMode && options.mode !== undefined && process.platform !== 'win32') {
      await chmod(temporary, options.mode)
    }
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(temporary, path)
        break
      } catch (error) {
        if (!renameIsRetryable(error, attempt)) throw error
        await new Promise((resolveDelay) => setTimeout(resolveDelay, renameRetryDelayMs(attempt)))
      }
    }
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

/**
 * {@link writeFileAtomic} for a caller that cannot wait: a setting written as
 * it is changed, a record written on the way out. A Windows rename retry
 * blocks the thread for its short delay.
 */
export function writeFileAtomicSync(path: string, data: string, options: AtomicWriteOptions = {}): void {
  const temporary = stagingPath(path)
  try {
    writeFileSync(temporary, data, { encoding: 'utf8', ...(options.mode === undefined ? {} : { mode: options.mode }) })
    if (options.exactMode && options.mode !== undefined && process.platform !== 'win32') {
      chmodSync(temporary, options.mode)
    }
    for (let attempt = 0; ; attempt++) {
      try {
        renameSync(temporary, path)
        break
      } catch (error) {
        if (!renameIsRetryable(error, attempt)) throw error
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, renameRetryDelayMs(attempt))
      }
    }
  } catch (error) {
    try {
      unlinkSync(temporary)
    } catch {
      // The temporary file may never have been written.
    }
    throw error
  }
}
