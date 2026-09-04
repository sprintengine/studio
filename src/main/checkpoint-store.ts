import { randomUUID } from 'crypto'
import { rm } from 'fs/promises'
import { isAbsolute, join, resolve } from 'path'

import { pathExists, runGitCommand } from './git-utils'

/**
 * Checkpoint store: a worktree snapshotted into a parentless commit under a
 * hidden ref, and the diff between two of them.
 *
 * This is the plumbing the whole "diff an agent actually made" epic rests on
 * (`backlog/epics/2026-09-04-the-diff-an-agent-made.md`). The checkpoint store knows nothing about
 * workspaces, turns or agents — the reactor supplies those.
 *
 * The one invariant that makes it safe: a capture NEVER touches the user's
 * index, worktree, HEAD, or anything under `refs/heads` / `refs/remotes`. It
 * stages into a temporary index file addressed by `GIT_INDEX_FILE` and removes
 * it on every path, including failure. A capture that wrote through the real
 * index would silently restage or unstage someone's work, which is the one way
 * this feature could do harm.
 *
 * Everything here is quiet by construction: git runs through `runGitCommand`,
 * which returns failures as values rather than throwing, and every entry point
 * degrades to a negative result (false / null / zeros) rather than propagating
 * an error into main.
 */

/** Everything this module writes lives under here — never `refs/heads`. */
export const CHECKPOINT_REFS_PREFIX = 'refs/multicode/checkpoints'

/** How a temp index file is named, so a stale one is recognisable and sweepable. */
const TEMP_INDEX_PREFIX = 'multicode-checkpoint-index-'

export type CheckpointFileStat = {
  path: string
  additions: number
  deletions: number
}

export type CheckpointStat = {
  additions: number
  deletions: number
  changedFiles: number
  files: CheckpointFileStat[]
}

const EMPTY_STAT: CheckpointStat = { additions: 0, deletions: 0, changedFiles: 0, files: [] }

/**
 * The ref a workspace's turn is stored at.
 *
 * The workspace id is base64url-encoded rather than interpolated raw: ids are
 * nanoid today and a refname has rules (no `..`, no leading `-`, no `~^:?*[`,
 * no trailing `.lock`). Encoding means no id can ever produce an invalid ref,
 * and it survives an id scheme changing under us.
 */
export function checkpointRefFor(workspaceId: string, turn: number): string {
  const encoded = Buffer.from(workspaceId, 'utf8').toString('base64url')
  return `${CHECKPOINT_REFS_PREFIX}/${encoded}/turn/${turn}`
}

/** The `refs/…/<workspace>` prefix every turn of one workspace shares. */
export function checkpointRefPrefixFor(workspaceId: string): string {
  const encoded = Buffer.from(workspaceId, 'utf8').toString('base64url')
  return `${CHECKPOINT_REFS_PREFIX}/${encoded}`
}

/**
 * The real git directory — `--git-common-dir`, not `--git-dir`, so a linked
 * worktree resolves to the shared directory its refs actually live in rather
 * than to its own `.git/worktrees/<name>` stub.
 */
async function resolveGitCommonDir(cwd: string): Promise<string | null> {
  const result = await runGitCommand(cwd, ['rev-parse', '--git-common-dir'])
  if (!result.ok) return null
  const value = result.stdout.trim()
  if (!value) return null
  return isAbsolute(value) ? value : resolve(cwd, value)
}

async function hasHeadCommit(cwd: string): Promise<boolean> {
  const result = await runGitCommand(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD'])
  return result.ok && result.stdout.trim().length > 0
}

/**
 * Snapshot the whole worktree at `ref`.
 *
 * The five-command dance, all of it through a temp index:
 *   read-tree HEAD → add -A → write-tree → commit-tree → update-ref
 *
 * `read-tree` seeds the temp index from HEAD so `add -A` records a delta rather
 * than treating every tracked file as new; it is skipped on an unborn HEAD
 * (a fresh `git init`), where there is nothing to read and the empty index is
 * already correct.
 *
 * The commit is parentless. It is a snapshot, not history: giving it HEAD as a
 * parent would make it show up in `git log HEAD..` style queries and invite it
 * into a merge, and nothing here wants to be part of the user's DAG.
 *
 * Returns false — never throws — when the folder is gone, is not a repo, or any
 * step fails. A missing checkpoint degrades a row; a thrown one would take out
 * whatever called it.
 */
export async function captureCheckpoint(input: { cwd: string; ref: string }): Promise<boolean> {
  const { cwd, ref } = input
  if (!(await pathExists(cwd))) return false

  const gitCommonDir = await resolveGitCommonDir(cwd)
  if (!gitCommonDir) return false

  const tempIndexPath = join(gitCommonDir, `${TEMP_INDEX_PREFIX}${randomUUID()}`)
  // The identity on the snapshot commit. Spelled out rather than inherited so a
  // checkpoint never carries the user's name into a commit they did not make,
  // and so capture works on a machine with no `user.email` configured at all —
  // where `commit-tree` would otherwise fail outright.
  const env: NodeJS.ProcessEnv = {
    GIT_INDEX_FILE: tempIndexPath,
    GIT_AUTHOR_NAME: 'Multicode',
    GIT_AUTHOR_EMAIL: 'checkpoints@multicode.local',
    GIT_COMMITTER_NAME: 'Multicode',
    GIT_COMMITTER_EMAIL: 'checkpoints@multicode.local',
  }

  try {
    if (await hasHeadCommit(cwd)) {
      const seeded = await runGitCommand(cwd, ['read-tree', 'HEAD'], env)
      if (!seeded.ok) return false
    }

    // `-A` includes untracked files, which is the point: an agent's new file is
    // its most visible work. `.gitignore` still applies, so node_modules and
    // build output stay out without us maintaining a second exclude list.
    const staged = await runGitCommand(cwd, ['add', '-A', '--', '.'], env)
    if (!staged.ok) return false

    const treeResult = await runGitCommand(cwd, ['write-tree'], env)
    const treeOid = treeResult.ok ? treeResult.stdout.trim() : ''
    if (!treeOid) return false

    const commitResult = await runGitCommand(
      cwd,
      ['commit-tree', treeOid, '-m', `multicode checkpoint ${ref}`],
      env
    )
    const commitOid = commitResult.ok ? commitResult.stdout.trim() : ''
    if (!commitOid) return false

    // update-ref runs WITHOUT the temp-index env: it touches refs, not the
    // index, and leaving the override off keeps the blast radius honest.
    const updated = await runGitCommand(cwd, ['update-ref', ref, commitOid])
    return updated.ok
  } finally {
    // Every path, including a throw from the runtime itself. A leaked index file
    // is inert, but they would accumulate one per turn forever.
    await rm(tempIndexPath, { force: true }).catch(() => {})
  }
}

/** Whether a checkpoint ref resolves to a commit. */
export async function hasCheckpointRef(input: { cwd: string; ref: string }): Promise<boolean> {
  const commit = await resolveCheckpointCommit(input)
  return commit !== null
}

async function resolveCheckpointCommit(input: { cwd: string; ref: string }): Promise<string | null> {
  const result = await runGitCommand(input.cwd, [
    'rev-parse',
    '--verify',
    '--quiet',
    `${input.ref}^{commit}`,
  ])
  if (!result.ok) return null
  const commit = result.stdout.trim()
  return commit.length > 0 ? commit : null
}

/**
 * Per-file additions/deletions between two checkpoints, plus their totals.
 *
 * `--numstat` rather than `--shortstat`: the file list is what the changed-files
 * surface renders, and the totals are a sum of it — one git call for both,
 * rather than two readings that could disagree.
 *
 * `-z` makes the record separator NUL, so a path containing a newline (legal,
 * and quoted-with-escapes under the default format) round-trips exactly. In
 * `-z` numstat, renames emit THREE NUL-terminated fields — stats, old path, new
 * path — while an ordinary change emits stats then path; the parser below
 * handles both, and reports a rename at its new path.
 *
 * A binary file's counts are `-` in both columns; it is reported as a changed
 * file contributing zero lines, which is what it is.
 */
export async function diffCheckpointStat(input: {
  cwd: string
  fromRef: string
  toRef: string
}): Promise<CheckpointStat> {
  const result = await runGitCommand(input.cwd, [
    'diff',
    '--numstat',
    '-z',
    '--no-color',
    '--no-ext-diff',
    '--no-textconv',
    `${input.fromRef}^{commit}`,
    `${input.toRef}^{commit}`,
  ])
  if (!result.ok) return EMPTY_STAT
  return parseNumstatZ(result.stdout)
}

/**
 * Parses `git diff --numstat -z` output.
 *
 * Exported for its own test: the rename shape (three fields, not two) is the
 * kind of thing that is silently wrong until someone renames a file.
 */
export function parseNumstatZ(stdout: string): CheckpointStat {
  const fields = stdout.split('\0')
  const files: CheckpointFileStat[] = []
  let additions = 0
  let deletions = 0

  let index = 0
  while (index < fields.length) {
    const record = fields[index]
    if (!record) {
      index += 1
      continue
    }
    // "<adds>\t<dels>\t" for a plain change (path is the next field only when
    // the trailing tab leaves it empty), or "<adds>\t<dels>\t<path>" inline.
    const parts = record.split('\t')
    if (parts.length < 2) {
      index += 1
      continue
    }
    const addsField = parts[0]
    const delsField = parts[1]
    const inlinePath = parts.slice(2).join('\t')

    let path: string
    if (inlinePath) {
      // Ordinary change, path inline in the same NUL-terminated record.
      path = inlinePath
      index += 1
    } else {
      // Rename/copy: the record ends after the stats, and the two following
      // fields are the old path and the new path. Report the new one — that is
      // where the file lives now and where opening it must go.
      const oldPath = fields[index + 1] ?? ''
      const newPath = fields[index + 2] ?? ''
      path = newPath || oldPath
      index += newPath ? 3 : 2
    }
    if (!path) continue

    // Binary files report `-`; they changed, but they contributed no lines.
    const fileAdditions = addsField === '-' ? 0 : Number.parseInt(addsField, 10)
    const fileDeletions = delsField === '-' ? 0 : Number.parseInt(delsField, 10)
    const safeAdditions = Number.isFinite(fileAdditions) ? fileAdditions : 0
    const safeDeletions = Number.isFinite(fileDeletions) ? fileDeletions : 0

    additions += safeAdditions
    deletions += safeDeletions
    files.push({ path, additions: safeAdditions, deletions: safeDeletions })
  }

  return { additions, deletions, changedFiles: files.length, files }
}

/** The patch between two checkpoints, for the diff viewer. Empty when unreadable. */
export async function diffCheckpointPatch(input: {
  cwd: string
  fromRef: string
  toRef: string
}): Promise<string> {
  const result = await runGitCommand(input.cwd, [
    'diff',
    '--patch',
    '--no-color',
    '--no-ext-diff',
    '--no-textconv',
    `${input.fromRef}^{commit}`,
    `${input.toRef}^{commit}`,
  ])
  return result.ok ? result.stdout : ''
}

/** Every checkpoint ref a workspace owns, in git's lexical ref order. */
export async function listCheckpointRefs(input: {
  cwd: string
  workspaceId: string
}): Promise<string[]> {
  const result = await runGitCommand(input.cwd, [
    'for-each-ref',
    '--format=%(refname)',
    checkpointRefPrefixFor(input.workspaceId),
  ])
  if (!result.ok) return []
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

/**
 * Delete checkpoint refs. Best effort: a ref that is already gone is a success,
 * and one failure does not abandon the rest — this runs during cleanup, where
 * giving up halfway leaves more litter than it removes.
 *
 * `update-ref -d` without an expected-oid argument deletes whatever is there,
 * which is what cleanup wants: we are not guarding against a concurrent writer,
 * we are removing our own snapshots.
 */
export async function deleteCheckpointRefs(input: {
  cwd: string
  refs: readonly string[]
}): Promise<void> {
  for (const ref of input.refs) {
    if (!ref.startsWith(`${CHECKPOINT_REFS_PREFIX}/`)) continue
    await runGitCommand(input.cwd, ['update-ref', '-d', ref])
  }
}
