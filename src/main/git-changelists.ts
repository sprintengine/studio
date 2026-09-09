// The changelist store (epic `git-commit-window`, T6). The model lives in
// `src/shared/git/changelists.ts`; this is the half that owns the disk and the
// half that asks git what is actually changed.
//
// WHERE IT LIVES. `<userData>/git-changelists/<basename>-<hash>.json`, one file
// per repository, keyed by the repo root. Keyed rather than stored inside the
// repository on purpose: a changelist is the person's private division of their
// own working tree, and a `.git/multicode-changelists.json` would be one more
// untracked file in the very list it describes. The basename is in the filename
// only so a human opening the folder can tell the files apart; the hash is what
// makes the key unique. Written temp-then-rename, exactly as
// `review/review-state-store.ts` does, so a crash mid-write leaves the previous
// file rather than a truncated one.
//
// PRUNE ON READ. `get` asks git for the current status and reconciles before it
// answers, so a list can never report files that are no longer changed. It is
// main that asks — not the renderer handing over what it happens to be showing
// — because a stale renderer snapshot would prune paths that are still there.
//
// ONE WRITER PER REPOSITORY. Every entry point goes through `withStore`, which
// chains this repository's operations onto one promise. Two menu items fired a
// frame apart — "rename" and "delete" on the same list — would otherwise both
// read the same file, both write, and the second would land on top of the
// first's changes. The chain is what makes the last write a function of the
// previous one.

import { mkdir, readFile, rename, unlink, writeFile } from 'fs/promises'
import { createHash, randomUUID } from 'crypto'
import { isAbsolute, join } from 'path'
import {
  createDefaultChangelists,
  moveChangelistPaths,
  normalizeChangelists,
  reconcileChangelists,
  createChangelist as createInModel,
  deleteChangelist as deleteInModel,
  renameChangelist as renameInModel,
  setActiveChangelist as setActiveInModel,
  type Changelist,
} from '../shared/git/changelists'
import { getGitStatus } from './git-status'
import { getRelativeGitPath, normalizeComparablePath, toPosixPath } from './git-utils'

const STORE_DIR = 'git-changelists'
const STORE_VERSION = 1

type StoreFile = {
  version: number
  repoRoot: string
  lists: Changelist[]
}

/** The file this repository's lists live in. Exported so the test can look at
 *  the same path the store writes, rather than guessing at the scheme. */
export function changelistsStorePath(userDataDir: string, repoRoot: string): string {
  const comparable = normalizeComparablePath(repoRoot)
  const hash = createHash('sha1').update(comparable).digest('hex').slice(0, 16)
  const name = comparable.split('/').filter(Boolean).pop() ?? 'repo'
  const slug = name.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'repo'
  return join(userDataDir, STORE_DIR, `${slug}-${hash}.json`)
}

async function readStoredLists(userDataDir: string, repoRoot: string): Promise<Changelist[]> {
  let raw: string
  try {
    raw = await readFile(changelistsStorePath(userDataDir, repoRoot), 'utf-8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return createDefaultChangelists()
    // A store we cannot read is a store we start over from. The alternative is
    // a Git panel that will not render because of a file nobody can see.
    return createDefaultChangelists()
  }
  try {
    const parsed = JSON.parse(raw) as Partial<StoreFile>
    return normalizeChangelists(parsed?.lists)
  } catch {
    return createDefaultChangelists()
  }
}

async function writeStoredLists(userDataDir: string, repoRoot: string, lists: Changelist[]): Promise<void> {
  const finalPath = changelistsStorePath(userDataDir, repoRoot)
  const tempPath = `${finalPath}.${randomUUID()}.tmp`
  const file: StoreFile = { version: STORE_VERSION, repoRoot, lists }
  await mkdir(join(userDataDir, STORE_DIR), { recursive: true })
  try {
    await writeFile(tempPath, `${JSON.stringify(file, null, 2)}\n`, 'utf-8')
    await rename(tempPath, finalPath)
  } catch (error) {
    await unlink(tempPath).catch(() => {})
    throw error
  }
}

/** What git says is changed right now, repo-relative and posix — the truth the
 *  stored lists are reconciled against. */
export async function readChangedPaths(repoRoot: string): Promise<string[]> {
  const snapshot = await getGitStatus(repoRoot)
  return Object.values(snapshot.files).map((entry) => toPosixPath(entry.relativePath))
}

/** A path from the renderer, in the store's spelling. Rows carry git's absolute
 *  path; the store speaks repo-relative, and a mixed list would put one file in
 *  two lists under two names. */
export function toStoredPath(repoRoot: string, path: string): string {
  return isAbsolute(path) ? getRelativeGitPath(repoRoot, path) : toPosixPath(path)
}

// One promise chain per repository — see the header. Keyed on the comparable
// root so `/repo` and `/repo/` are one queue and not two.
const storeQueues = new Map<string, Promise<unknown>>()

async function withStore<T>(repoRoot: string, action: () => Promise<T>): Promise<T> {
  const key = normalizeComparablePath(repoRoot)
  const previous = storeQueues.get(key) ?? Promise.resolve()
  // `then(action, action)` rather than `then(action)`: a failed operation must
  // not poison the queue and take every later one down with it.
  const next = previous.then(action, action)
  // What is REMEMBERED is a promise that never rejects, so an unhandled
  // rejection cannot escape from the queue itself; the caller still gets `next`
  // and still sees the real error.
  const settled = next.then(
    () => {},
    () => {},
  )
  storeQueues.set(key, settled)
  void settled.then(() => {
    if (storeQueues.get(key) === settled) storeQueues.delete(key)
  })
  return next
}

/**
 * Apply a change to this repository's lists, reconcile against git, persist,
 * and answer with what the panel should now render. Every public entry point
 * below is this function with a different `mutate`, which is what keeps
 * "normalize, prune, adopt, write" from being spelled six times.
 */
async function updateLists(
  userDataDir: string,
  repoRoot: string,
  mutate: (lists: Changelist[]) => Changelist[],
): Promise<Changelist[]> {
  return withStore(repoRoot, async () => {
    const stored = await readStoredLists(userDataDir, repoRoot)
    const mutated = mutate(stored)
    const changedPaths = await readChangedPaths(repoRoot).catch(() => null)
    // A repository git cannot read (mid-checkout, a missing worktree) must not
    // prune every path out of every list — the lists are kept exactly as they
    // were and the next successful read reconciles them.
    const reconciled = changedPaths ? reconcileChangelists(mutated, changedPaths) : normalizeChangelists(mutated)
    await writeStoredLists(userDataDir, repoRoot, reconciled)
    return reconciled
  })
}

export function getGitChangelists(userDataDir: string, repoRoot: string): Promise<Changelist[]> {
  return updateLists(userDataDir, repoRoot, (lists) => lists)
}

export function setActiveGitChangelist(
  userDataDir: string,
  repoRoot: string,
  id: string,
): Promise<Changelist[]> {
  return updateLists(userDataDir, repoRoot, (lists) => setActiveInModel(lists, id))
}

export function createGitChangelist(
  userDataDir: string,
  repoRoot: string,
  input: { name: string; comment?: string; activate?: boolean; paths?: string[] },
): Promise<Changelist[]> {
  const id = randomUUID()
  return updateLists(userDataDir, repoRoot, (lists) => {
    const created = createInModel(lists, { id, name: input.name, comment: input.comment, activate: input.activate })
    if (!input.paths?.length) return created
    return moveChangelistPaths(created, id, input.paths.map((path) => toStoredPath(repoRoot, path)))
  })
}

export function renameGitChangelist(
  userDataDir: string,
  repoRoot: string,
  id: string,
  input: { name: string; comment?: string },
): Promise<Changelist[]> {
  return updateLists(userDataDir, repoRoot, (lists) => renameInModel(lists, id, input))
}

export function deleteGitChangelist(
  userDataDir: string,
  repoRoot: string,
  id: string,
): Promise<Changelist[]> {
  return updateLists(userDataDir, repoRoot, (lists) => deleteInModel(lists, id))
}

export function moveGitChangelistPaths(
  userDataDir: string,
  repoRoot: string,
  id: string,
  paths: string[],
): Promise<Changelist[]> {
  return updateLists(userDataDir, repoRoot, (lists) =>
    moveChangelistPaths(lists, id, paths.map((path) => toStoredPath(repoRoot, path))),
  )
}
