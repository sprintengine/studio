import { readFile, readdir, rm } from 'fs/promises'
import { join } from 'path'

import { runGitCommand } from './git-utils'

/**
 * One-shot cleanup of the retired checkpoint machinery
 * (the-diff-an-agent-made / remove-checkpoint-machinery).
 *
 * **Migration, not a feature. Delete this file and its call one release after
 * it ships (target: 2026-10).**
 *
 * Every machine that ran a build between `c8ed695a2` and the removal has real
 * artefacts on disk that nothing else will ever collect once the code that made
 * them is gone: up to 50 refs per workspace under
 * `refs/multicode/checkpoints/`, each pinning a whole-worktree tree object so
 * it holds storage down against `gc`, plus the index that lists them.
 *
 * The index is the authority on WHICH repos to visit — it is the record of
 * where refs were written, and it is a much smaller and more accurate set than
 * every folder the workspace registry has ever known. Within a repo we do not
 * trust it further: `for-each-ref` lists what is actually there, so refs whose
 * index entry was lost to a torn write are swept too.
 *
 * The index file's own absence is the "already ran" marker. That needs no extra
 * bookkeeping and is self-healing in the right direction: if a repo's refs
 * cannot be deleted this launch, the index survives and the sweep runs again
 * next launch. A machine that never ran the checkpoint builds has no index and
 * does no work at all.
 *
 * That self-healing is only real if the index removal is GATED on every repo
 * having actually finished — a review found it removing the index
 * unconditionally, which orphaned the refs of any repo that was unmounted or
 * whose `packed-refs` was locked by a concurrent gc, permanently, since this
 * file deletes itself a release from now.
 */

const INDEX_FILE = 'checkpoint-index.json'
const CORRUPT_SUFFIX = '.corrupt'
const REFS_PREFIX = 'refs/multicode/checkpoints/'
/** Temp index files a capture killed mid-flight could not remove. */
const TEMP_INDEX_PREFIX = 'multicode-checkpoint-index-'

export type CheckpointSweepResult = {
  /** Repos visited, refs actually deleted, and whether the index could go. */
  reposVisited: number
  refsDeleted: number
  indexRemoved: boolean
}

/**
 * Parse the retired index defensively. Its shape is
 * `{ workspaces: { <id>: { turns: [{ cwd, ref, ... }] } } }`, but this reads a
 * file written by code that no longer exists, possibly torn by a crash, so
 * every level is checked rather than trusted. Anything unreadable yields no
 * cwds, which means "nothing to sweep here" — never a throw on startup.
 */
export function checkoutsFromIndex(raw: string): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (typeof parsed !== 'object' || parsed === null) return []
  const workspaces = (parsed as { workspaces?: unknown }).workspaces
  if (typeof workspaces !== 'object' || workspaces === null) return []

  const cwds = new Set<string>()
  for (const timeline of Object.values(workspaces as Record<string, unknown>)) {
    if (typeof timeline !== 'object' || timeline === null) continue
    const turns = (timeline as { turns?: unknown }).turns
    if (!Array.isArray(turns)) continue
    for (const turn of turns) {
      if (typeof turn !== 'object' || turn === null) continue
      const cwd = (turn as { cwd?: unknown }).cwd
      if (typeof cwd === 'string' && cwd.length > 0) cwds.add(cwd)
    }
  }
  return [...cwds]
}

/**
 * Delete every checkpoint ref in one repo, and any temp index file a killed
 * capture left in its git dir. Returns how many refs went.
 *
 * Deleting these cannot lose anyone's work: the commits are parentless, nothing
 * else references them, and nothing under `refs/heads` or `refs/remotes` is
 * touched. A repo that has moved, is not a repo any more, or is read-only
 * simply reports zero.
 */
export async function sweepCheckpointRefs(cwd: string): Promise<{ deleted: number; ok: boolean }> {
  const listed = await runGitCommand(cwd, ['for-each-ref', '--format=%(refname)', `${REFS_PREFIX}**`])
  // A repo we could not even LIST is not a repo we have finished with. Reporting
  // ok:false keeps the index — and so the next launch's attempt — alive.
  if (!listed.ok) return { deleted: 0, ok: false }
  const refs = listed.stdout
    .split('\n')
    .map((line) => line.trim())
    // Belt and braces: only ever delete under our own prefix, whatever
    // for-each-ref returned.
    .filter((line) => line.startsWith(REFS_PREFIX))

  // One process per ref rather than a single `update-ref --stdin` transaction:
  // `runGitCommand` has no stdin channel, and widening a util every other git
  // call in the app shares — for a migration that runs once and is then deleted
  // — is the worse trade. A ref that will not delete is skipped, not retried.
  let deleted = 0
  let ok = true
  for (const ref of refs) {
    const result = await runGitCommand(cwd, ['update-ref', '-d', ref])
    if (result.ok) deleted += 1
    else ok = false
  }

  await sweepTempIndexes(cwd)
  return { deleted, ok }
}

/**
 * Remove `multicode-checkpoint-index-*` files from the repo's git common dir.
 * A capture deleted its own in a `finally`, so only a hard kill mid-capture
 * leaves one; they are inert, but they are ours and nothing else will take
 * them.
 */
async function sweepTempIndexes(cwd: string): Promise<void> {
  const commonDir = await runGitCommand(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (!commonDir.ok) return
  const dir = commonDir.stdout.trim()
  if (!dir) return
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return
  }
  await Promise.all(
    entries
      .filter((name) => name.startsWith(TEMP_INDEX_PREFIX))
      .map((name) => rm(join(dir, name), { force: true }).catch(() => {})),
  )
}

/**
 * Run the sweep. Safe to call on every launch: with no index file it does
 * nothing at all and returns immediately.
 *
 * Never throws and never blocks a launch on a slow volume — a cleanup that
 * cannot finish must not stop the app starting, so callers fire this and forget
 * it.
 */
export async function sweepRetiredCheckpoints(userDataDir: string): Promise<CheckpointSweepResult> {
  const result: CheckpointSweepResult = { reposVisited: 0, refsDeleted: 0, indexRemoved: false }
  const indexPath = join(userDataDir, INDEX_FILE)

  let raw: string | null = null
  try {
    raw = await readFile(indexPath, 'utf8')
  } catch {
    raw = null
  }

  // A `.corrupt` sibling can exist with or without a live index; take it either
  // way. Deliberately WITHOUT `force`: force resolves for a file that was never
  // there, which would report a removal on every launch of every machine that
  // never ran these builds — and the caller logs on that flag.
  const corruptRemoved = await rm(`${indexPath}${CORRUPT_SUFFIX}`).then(
    () => true,
    () => false,
  )

  if (raw === null) {
    // Nothing to sweep. `indexRemoved` reports true when a corrupt-only leftover
    // was the entire job, so a caller's log is not silent about real work.
    result.indexRemoved = corruptRemoved
    return result
  }

  const checkouts = checkoutsFromIndex(raw)
  result.reposVisited = checkouts.length

  // Serially: these are git writes against repos the user may be working in, and
  // a burst of `update-ref` transactions across many repos at launch is the wrong
  // thing to do to a machine that is still starting up.
  let allFinished = true
  for (const cwd of checkouts) {
    const swept = await sweepCheckpointRefs(cwd)
    result.refsDeleted += swept.deleted
    if (!swept.ok) allFinished = false
  }

  // The index goes last, and ONLY when every repo it named actually finished.
  // A repo on an unmounted volume, or one whose refs are locked by a concurrent
  // gc, must keep its entry: this file is deleted a release from now, so an
  // index dropped over an unswept repo leaks its tree-pinning refs forever.
  if (!allFinished) {
    result.indexRemoved = false
    return result
  }
  try {
    await rm(indexPath, { force: true })
    result.indexRemoved = true
  } catch {
    result.indexRemoved = false
  }
  return result
}
