import { execFile } from 'child_process'
import { lstat, readdir } from 'fs/promises'
import { basename, join } from 'path'
import type { WorktreeDiskUsage } from '../../shared/ipc/worktree-pool'

/**
 * How much disk a worktree takes, for Settings ▸ Worktrees and the pool's disk
 * limit. Only ever run because someone asked (the page opened, Measure again,
 * a return while a disk limit is set): a worktree with `node_modules` is a
 * hundred thousand files, and walking one costs seconds.
 *
 * `du` where there is one, because it counts allocated blocks (what removing
 * the tree gives back) and is far faster than a walk from Node. Windows has no
 * `du`, so there the tree is walked, and the walk counts file lengths.
 */

/** Top-level entries kept by name in the breakdown; the rest are summed as `…`. */
const NAMED_PARTS = 4
const DU_TIMEOUT_MS = 120_000
const WALK_CONCURRENCY = 16

export type MeasureDiskUsage = (path: string) => Promise<WorktreeDiskUsage | null>

function breakdown(total: number, children: Array<{ name: string; bytes: number }>, measuredAt: number) {
  const sorted = children.filter((child) => child.bytes > 0).sort((a, b) => b.bytes - a.bytes)
  const parts = sorted.slice(0, NAMED_PARTS)
  const rest = total - parts.reduce((sum, part) => sum + part.bytes, 0)
  // Everything else: smaller entries, and the top-level files `du -d 1` does not list.
  if (rest > 0) parts.push({ name: '…', bytes: rest })
  return { bytes: total, measuredAt, parts }
}

/** `du -k -d 1` output: `<kibibytes>\t<path>` per line, the tree itself last. */
export function parseDuOutput(stdout: string, root: string, measuredAt: number): WorktreeDiskUsage | null {
  let total: number | null = null
  const children: Array<{ name: string; bytes: number }> = []
  const rootKey = root.replace(/[\\/]+$/u, '')
  for (const line of stdout.split(/\r?\n/u)) {
    const match = /^(\d+)\s+(.+)$/u.exec(line.trim())
    if (!match) continue
    const bytes = Number(match[1]) * 1024
    const path = match[2].replace(/[\\/]+$/u, '')
    if (path === rootKey) total = bytes
    else children.push({ name: basename(path), bytes })
  }
  return total === null ? null : breakdown(total, children, measuredAt)
}

function runDu(path: string): Promise<string | null> {
  return new Promise((resolveRun) => {
    execFile(
      'du',
      ['-k', '-d', '1', path],
      { timeout: DU_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        // A file it may not read makes `du` exit 1 after printing every total
        // it could; those totals are still the answer.
        if (stdout) resolveRun(stdout)
        else resolveRun(error ? null : '')
      },
    )
  })
}

/** Bytes under `path`, symlinks not followed. */
async function walk(path: string): Promise<number> {
  const info = await lstat(path).catch(() => null)
  if (!info) return 0
  if (!info.isDirectory()) return info.isSymbolicLink() ? 0 : info.size
  const names = await readdir(path).catch(() => [] as string[])
  let total = 0
  for (let index = 0; index < names.length; index += WALK_CONCURRENCY) {
    const sizes = await Promise.all(names.slice(index, index + WALK_CONCURRENCY).map((name) => walk(join(path, name))))
    total += sizes.reduce((sum, size) => sum + size, 0)
  }
  return total
}

async function walkTopLevel(path: string, measuredAt: number): Promise<WorktreeDiskUsage | null> {
  const names = await readdir(path).catch(() => null)
  if (!names) return null
  const children: Array<{ name: string; bytes: number }> = []
  for (const name of names) children.push({ name, bytes: await walk(join(path, name)) })
  return breakdown(
    children.reduce((sum, child) => sum + child.bytes, 0),
    children,
    measuredAt,
  )
}

export const measureDiskUsage: MeasureDiskUsage = async (path) => {
  const measuredAt = Date.now()
  if (process.platform !== 'win32') {
    const stdout = await runDu(path)
    const parsed = stdout ? parseDuOutput(stdout, path, measuredAt) : null
    if (parsed) return parsed
  }
  return walkTopLevel(path, measuredAt)
}
