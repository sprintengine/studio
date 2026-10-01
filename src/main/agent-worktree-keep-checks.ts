import { lstat, open, readFile, readdir, readlink, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'

import { comparablePath } from '../shared/host-paths'
import type { GitCommandResult } from './git'
import { toFilesystemPath } from './git-utils'

/**
 * The on-disk checks the agent worktree cleanup (agent-worktree-cleanup.ts)
 * runs before it lets `git worktree remove` take a worktree: the ones `git
 * status` cannot answer, because what they look for is invisible to it.
 */

type RunGit = (cwd: string, args: string[]) => Promise<GitCommandResult>

// --- Path identity -----------------------------------------------------------

/**
 * macOS and Windows filesystems are case-insensitive by default. Folding there
 * can only make two spellings of one folder match; on a case-sensitive volume
 * it can make two different folders match too, which keeps a worktree that
 * could have gone. Keeping is the side to err on.
 */
const FOLD_CASE = process.platform === 'darwin' || process.platform === 'win32'

function comparable(path: string): string {
  const value = comparablePath(path)
  return FOLD_CASE ? value.toLowerCase() : value
}

/**
 * The spellings one path can be compared under: as given, and with every
 * symlink resolved. Git records a worktree's path resolved (`/private/tmp/…`
 * for `/tmp/…`, `/Volumes/…` for a `~/code` link to it), while the app's
 * records keep whatever path the person opened. A path that does not exist
 * (a folder removed since) resolves through its nearest existing parent.
 */
export async function pathSpellings(path: string): Promise<string[]> {
  const spellings = new Set([comparable(path)])
  let current = toFilesystemPath(path)
  const rest: string[] = []
  for (let depth = 0; depth < 64; depth += 1) {
    try {
      const real = await realpath(current)
      spellings.add(comparable(rest.length > 0 ? join(real, ...rest) : real))
      break
    } catch {
      const parent = dirname(current)
      if (parent === current) break
      rest.unshift(basename(current))
      current = parent
    }
  }
  return [...spellings]
}

/** True when any spelling of `child` is `parent` or inside it. */
export function insideAny(childSpellings: readonly string[], parentSpellings: readonly string[]): boolean {
  return childSpellings.some((child) =>
    parentSpellings.some(
      (parent) => child === parent || child.startsWith(parent.endsWith('/') ? parent : `${parent}/`),
    ),
  )
}

// --- Age ---------------------------------------------------------------------

/**
 * When git last wrote to the worktree's admin directory
 * (`<common>/worktrees/<name>`): its creation, and every index write, HEAD move
 * or commit made in it since. Null when it cannot be read.
 *
 * The cleanup keeps a worktree younger than an hour whatever else it finds. A
 * freshly created agent worktree is clean and has no commits of its own, so on
 * every other rule it qualifies at once; this is the window in which its owner
 * may not have been recorded anywhere yet (another profile, an MCP launch the
 * window has not heard of, a worktree created while a sweep was listing).
 */
export async function adminDirWrittenAt(worktreePath: string, runGit: RunGit): Promise<number | null> {
  const gitDir = await runGit(worktreePath, ['rev-parse', '--absolute-git-dir'])
  const dir = gitDir.ok ? gitDir.stdout.trim() : ''
  if (!dir) return null
  try {
    // mtime, not birthtime: a directory's mtime moves every time an entry in
    // it is created or renamed (`index.lock` → `index` on each index write),
    // so it is the newest of "created" and "last used by git", and it is
    // reported the same way on every platform.
    return (await stat(toFilesystemPath(dir))).mtimeMs
  } catch {
    return null
  }
}

// --- Hidden edits ------------------------------------------------------------

/**
 * Tracked files whose edits `git status` does not show, and `git worktree
 * remove` (without `--force`) therefore does not see either: a lowercase tag
 * in `git ls-files -v` is `--assume-unchanged`, `S` is `--skip-worktree`.
 *
 * A skip-worktree entry with no file on disk is a sparse checkout leaving that
 * path out, which hides nothing, and is not counted.
 */
export async function hiddenEditPaths(
  worktreePath: string,
  runGit: RunGit,
): Promise<{ ok: true; paths: string[] } | { ok: false; message: string }> {
  const listed = await runGit(worktreePath, ['ls-files', '-v', '-z'])
  if (!listed.ok) return { ok: false, message: listed.message ?? 'git ls-files failed' }
  const paths: string[] = []
  for (const record of listed.stdout.split('\0')) {
    if (record.length < 3) continue
    const tag = record[0]
    const path = record.slice(2)
    if (/[a-z]/.test(tag)) {
      paths.push(path)
    } else if (tag === 'S') {
      const onDisk = await lstat(toFilesystemPath(join(worktreePath, path))).then(
        () => true,
        () => false,
      )
      if (onDisk) paths.push(path)
    }
  }
  return { ok: true, paths }
}

// --- Ignored files -----------------------------------------------------------

/**
 * Ignored folders that only ever hold what a command rebuilds: installed
 * dependencies, build and test output, tool caches. A folder with one of these
 * names that git ignores as a whole (at any depth, so a monorepo package's
 * `dist/` counts too) goes with the worktree; anything else ignored keeps it.
 */
const REBUILDABLE_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  'target',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.vite',
  '.parcel-cache',
  '.cache',
  '.gradle',
  '.venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
])

/** Ignored files that are never anyone's work. */
const DISPOSABLE_FILES = new Set(['.DS_Store', 'Thumbs.db'])

function isRebuildable(path: string): boolean {
  const directory = path.endsWith('/')
  const segments = path.split('/').filter(Boolean)
  const last = segments.at(-1) ?? ''
  if (!directory) return DISPOSABLE_FILES.has(last) || last.endsWith('.tsbuildinfo')
  // `--ignored=matching` names a folder only when the folder itself is
  // ignored as a whole (`packages/a/dist/`). A file is named on its own when
  // its folder is NOT ignored, so a file under `build/` proves that `build/` is
  // a source folder (a tracked `build/entitlements.plist` beside an ignored
  // `build/dev.p12`), and the folder's name says nothing about the file.
  return REBUILDABLE_DIRS.has(last)
}

/** The repository's `.worktreeinclude` entries, the way worktree creation reads them. */
async function readIncludeEntries(repoRoot: string): Promise<string[]> {
  let text = ''
  try {
    text = await readFile(join(toFilesystemPath(repoRoot), '.worktreeinclude'), 'utf8')
  } catch {
    return []
  }
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .filter((line) => !isAbsolute(line) && !line.split(/[\\/]/).includes('..') && !/[*?[\]{}]/.test(line))
    .map((line) =>
      line
        .replace(/\\/g, '/')
        .replace(/^(\.\/)+/, '')
        .replace(/\/+$/, ''),
    )
    .filter(Boolean)
}

function overlaps(path: string, entry: string): boolean {
  const a = path.replace(/\/+$/, '')
  return a === entry || a.startsWith(`${entry}/`) || entry.startsWith(`${a}/`)
}

const MAX_COMPARED_ENTRIES = 20_000
const MAX_COMPARED_BYTES = 256 * 1024 * 1024

/**
 * Whether everything at `rel` in the worktree is byte-for-byte what the
 * source checkout has at the same path. Only the worktree side is walked:
 * something the source has and the worktree lacks loses nothing. Everything
 * inside is compared, whatever its folder is called. Past the budget the
 * answer is "not the same", which keeps the worktree.
 */
async function sameAsSource(
  sourceRoot: string,
  worktreeRoot: string,
  rel: string,
  budget: { entries: number; bytes: number },
): Promise<boolean> {
  const walk = async (source: string, target: string): Promise<boolean> => {
    budget.entries -= 1
    if (budget.entries < 0) return false
    let info
    let sourceInfo
    try {
      info = await lstat(target)
      sourceInfo = await lstat(source)
    } catch {
      return false
    }
    if (info.isSymbolicLink()) {
      if (!sourceInfo.isSymbolicLink()) return false
      return (await readlink(target)) === (await readlink(source))
    }
    if (info.isDirectory()) {
      if (!sourceInfo.isDirectory()) return false
      for (const name of await readdir(target)) {
        // Only `.DS_Store`-style litter is skipped. A folder named `build` or
        // `node_modules` inside a copied folder is part of the copy, and an
        // edit in it is as much an edit as any other.
        if (DISPOSABLE_FILES.has(name)) continue
        if (!(await walk(join(source, name), join(target, name)))) return false
      }
      return true
    }
    if (!info.isFile() || !sourceInfo.isFile() || info.size !== sourceInfo.size) return false
    budget.bytes -= info.size
    if (budget.bytes < 0) return false
    return sameBytes(source, target, info.size)
  }
  const segments = rel.split('/').filter(Boolean)
  return walk(join(toFilesystemPath(sourceRoot), ...segments), join(toFilesystemPath(worktreeRoot), ...segments))
}

async function sameBytes(a: string, b: string, size: number): Promise<boolean> {
  const chunk = 1024 * 1024
  const [left, right] = await Promise.all([open(a, 'r'), open(b, 'r')])
  try {
    const bufferA = Buffer.alloc(Math.min(chunk, Math.max(size, 1)))
    const bufferB = Buffer.alloc(bufferA.length)
    for (let offset = 0; offset < size; offset += bufferA.length) {
      const [readA, readB] = await Promise.all([
        left.read(bufferA, 0, bufferA.length, offset),
        right.read(bufferB, 0, bufferB.length, offset),
      ])
      if (readA.bytesRead !== readB.bytesRead) return false
      if (!bufferA.subarray(0, readA.bytesRead).equals(bufferB.subarray(0, readB.bytesRead))) return false
      if (readA.bytesRead === 0) break
    }
    return true
  } finally {
    await Promise.all([left.close(), right.close()])
  }
}

/**
 * Ignored files `git worktree remove` would delete that may be someone's work.
 *
 * `git status --ignored=matching` names each ignored thing once: a folder that
 * is ignored as a whole (`node_modules/`), else the file. One is disposable
 * when it is rebuildable output (`REBUILDABLE_DIRS`, `DISPOSABLE_FILES`), or
 * when `.worktreeinclude` copied it in at creation and it is still exactly the
 * source checkout's copy. Everything else — an edited `.env`, notes in an
 * ignored folder, a `todo.local` — is returned, and keeps the worktree.
 */
export async function ignoredPathsAtRisk(
  repoRoot: string,
  worktreePath: string,
  runGit: RunGit,
): Promise<{ ok: true; paths: string[] } | { ok: false; message: string }> {
  // `--untracked-files=normal` explicitly: a `status.showUntrackedFiles=no` in
  // the person's config makes git refuse `--ignored=matching` outright.
  const status = await runGit(worktreePath, [
    'status',
    '--ignored=matching',
    '--untracked-files=normal',
    '--porcelain=v1',
    '-z',
  ])
  if (!status.ok) return { ok: false, message: status.message ?? 'git status --ignored failed' }
  const ignored = status.stdout
    .split('\0')
    .filter((record) => record.startsWith('!! '))
    .map((record) => record.slice(3))
    .filter((path) => path && !isRebuildable(path))
  if (ignored.length === 0) return { ok: true, paths: [] }

  const includes = await readIncludeEntries(repoRoot)
  const budget = { entries: MAX_COMPARED_ENTRIES, bytes: MAX_COMPARED_BYTES }
  const atRisk: string[] = []
  for (const path of ignored) {
    const copied = includes.some((entry) => overlaps(path, entry))
    if (copied && (await sameAsSource(repoRoot, worktreePath, path, budget).catch(() => false))) continue
    atRisk.push(path)
  }
  return { ok: true, paths: atRisk }
}
