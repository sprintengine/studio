import { realpath, stat } from 'fs/promises'
import { resolve } from 'path'

import { writeFileAtomic } from '../server/platform/atomic-file'

// ── Writing a config file the person owns ──────────────────────────────────
//
// The CLI configs the app writes into — `.mcp.json`,
// `.claude/settings.local.json`, Codex's `config.toml` — are files the person
// (or the CLI itself) also edits, and launches write them concurrently: boot
// releases every held launch together, several agents may start in one
// checkout at once, and two writers touch the same files (the MCP sync and the
// agent-state hook installer). Two rules keep that from costing anyone their
// settings:
//
// 1. One read-modify-write per file at a time. Each writer reads a file,
//    derives the next content from what it read and writes it back;
//    interleaving two of those means the second writes over the first from a
//    stale read. The lock is per resolved path and process-wide, so every
//    writer that goes through it is serialised with every other. A caller that
//    holds two locks takes `.mcp.json` before `.claude/settings.local.json`,
//    the only nesting there is, so no two callers can wait on each other.
// 2. A write never truncates in place. The new bytes go to a temporary file in
//    the same directory and are renamed over the old one, so a reader (another
//    writer, or the CLI starting up) sees the old file or the new one, never an
//    empty or half-written one. That part is `writeFileAtomic`, shared with
//    every other store that replaces a file whole.

const configFileLocks = new Map<string, Promise<unknown>>()

function configFileLockKey(path: string): string {
  const absolute = resolve(path)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

/**
 * Run `task` once every earlier task queued on the same file has settled. A
 * failed task does not poison the queue: the next one still runs. Not
 * re-entrant: a task must not take the lock of the file it already holds.
 */
export async function withConfigFileLock<T>(path: string, task: () => Promise<T>): Promise<T> {
  const key = configFileLockKey(path)
  const previous = configFileLocks.get(key) ?? Promise.resolve()
  const run = previous.then(task, task)
  const settled = run.then(
    () => undefined,
    () => undefined,
  )
  configFileLocks.set(key, settled)
  try {
    return await run
  } finally {
    // Only the last task in the queue clears the entry; a later one replaced it.
    if (configFileLocks.get(key) === settled) configFileLocks.delete(key)
  }
}

/**
 * Replace `path` with `content` through a temporary file and a rename. A
 * symlinked config is written through to its target, so the link survives, and
 * an existing file keeps its permission bits.
 */
export async function writeFileAtomically(path: string, content: string): Promise<void> {
  let target = path
  let mode: number | undefined
  try {
    target = await realpath(path)
    mode = (await stat(target)).mode & 0o7777
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') throw error
  }
  // `mode` on a write is masked by the umask; the existing bits are kept exactly.
  await writeFileAtomic(target, content, mode === undefined ? {} : { mode, exactMode: true })
}
