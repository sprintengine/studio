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

/**
 * A fresh empty result each time. NOT a shared constant: it is handed to
 * callers, and one that sorted `files` in place or assigned a total would
 * corrupt every later failure result for the life of the process.
 */
function emptyStat(): CheckpointStat {
  return { additions: 0, deletions: 0, changedFiles: 0, files: [] }
}

/**
 * The ref a workspace's turn is stored at.
 *
 * The workspace id is base64url-encoded rather than interpolated raw: ids are
 * nanoid today and a refname has rules (no `..`, no leading `-`, no `~^:?*[`,
 * no trailing `.lock`). Encoding means no id can ever produce an invalid ref,
 * and it survives an id scheme changing under us.
 */
function encodeWorkspaceId(workspaceId: string): string | null {
  // Guarded rather than trusted. An EMPTY id would encode to nothing and leave
  // the bare prefix, which `for-each-ref` reads as "every workspace" — so
  // listing would return another workspace's refs and deleting would take them.
  // A non-string reaches `Buffer.from` from callers typed `string | null`
  // elsewhere in main, where it either throws or (for an array) silently
  // coerces to a colliding value.
  if (typeof workspaceId !== 'string' || workspaceId.length === 0) return null
  return Buffer.from(workspaceId, 'utf8').toString('base64url')
}

/**
 * The ref a workspace's turn is stored at, or null for an id that cannot own
 * one. Callers treat null as "no checkpoints for this thing", which is true.
 */
export function checkpointRefFor(workspaceId: string, turn: number): string | null {
  const encoded = encodeWorkspaceId(workspaceId)
  if (encoded === null) return null
  if (!Number.isInteger(turn) || turn < 0) return null
  return `${CHECKPOINT_REFS_PREFIX}/${encoded}/turn/${turn}`
}

/** The `refs/…/<workspace>` prefix every turn of one workspace shares. */
export function checkpointRefPrefixFor(workspaceId: string): string | null {
  const encoded = encodeWorkspaceId(workspaceId)
  return encoded === null ? null : `${CHECKPOINT_REFS_PREFIX}/${encoded}`
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
  //
  // The GIT_* clears matter as much as the sets. `runGitCommand` spreads the
  // whole process env, so an ambient GIT_DIR (or GIT_WORK_TREE, or
  // GIT_OBJECT_DIRECTORY) would redirect a capture into a DIFFERENT repository
  // than the cwd we were asked about — writing our ref somewhere nobody asked.
  // Node drops env keys whose value is undefined, so these unset them.
  const env: NodeJS.ProcessEnv = {
    GIT_INDEX_FILE: tempIndexPath,
    GIT_AUTHOR_NAME: 'Multicode',
    GIT_AUTHOR_EMAIL: 'checkpoints@multicode.local',
    GIT_COMMITTER_NAME: 'Multicode',
    GIT_COMMITTER_EMAIL: 'checkpoints@multicode.local',
    GIT_DIR: undefined,
    GIT_WORK_TREE: undefined,
    GIT_COMMON_DIR: undefined,
    GIT_OBJECT_DIRECTORY: undefined,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
  }
  // Config neutralised for every command in the capture:
  //
  // - `core.hooksPath` — staging fires `post-index-change`, and update-ref
  //   fires `reference-transaction`, several times per capture. Someone's
  //   post-index-change hook refreshing an editor index is common; a
  //   reference-transaction hook that MIRRORS refs to a remote would carry
  //   snapshots of their uncommitted work off-machine, which is the one thing
  //   this module promises cannot happen. Pointed at a path inside the git dir
  //   that we never create (portable, unlike /dev/null).
  // - `core.splitIndex` — with it on, each capture spawns a `sharedindex.<sha>`
  //   beside our temp index that the temp index's removal does not take with
  //   it, so they accumulate at ~20KB a turn forever.
  const hardened = [
    '-c',
    `core.hooksPath=${join(gitCommonDir, 'multicode-checkpoint-no-hooks')}`,
    '-c',
    'core.splitIndex=false',
  ]

  try {
    if (await hasHeadCommit(cwd)) {
      const seeded = await runGitCommand(cwd, [...hardened, 'read-tree', 'HEAD'], env)
      if (!seeded.ok) return false
    }

    // `-A` includes untracked files, which is the point: an agent's new file is
    // its most visible work. `.gitignore` still applies, so node_modules and
    // build output stay out without us maintaining a second exclude list.
    const staged = await runGitCommand(cwd, [...hardened, 'add', '-A', '--', '.'], env)
    if (!staged.ok) return false

    const treeResult = await runGitCommand(cwd, [...hardened, 'write-tree'], env)
    const treeOid = treeResult.ok ? treeResult.stdout.trim() : ''
    if (!treeOid) return false

    const commitResult = await runGitCommand(
      cwd,
      [...hardened, 'commit-tree', treeOid, '-m', `multicode checkpoint ${ref}`],
      env
    )
    const commitOid = commitResult.ok ? commitResult.stdout.trim() : ''
    if (!commitOid) return false

    // update-ref keeps the config hardening and the GIT_DIR clears — it would
    // otherwise follow an ambient GIT_DIR into another repo, and fire the
    // user's reference-transaction hook — but drops GIT_INDEX_FILE, which it
    // has no business reading.
    const updated = await runGitCommand(cwd, [...hardened, 'update-ref', ref, commitOid], {
      ...env,
      GIT_INDEX_FILE: undefined,
    })
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
  if (!result.ok) return emptyStat()
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
    // A plain change is ALWAYS "<adds>\t<dels>\t<path>" in one NUL-terminated
    // record — path inline. Only a rename or copy splits: its record ends after
    // the trailing tab, and the old and new paths follow as two more fields.
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

export type CheckpointPatch =
  | { ok: true; patch: string }
  | { ok: false; reason: 'too-large' | 'unreadable'; partial: string }

/**
 * The patch between two checkpoints, for the diff viewer.
 *
 * Discriminated rather than a bare string, because the failure a viewer will
 * actually hit is SIZE: `runGitCommand` buffers 20MB, and one regenerated
 * lockfile can exceed it. Returning `''` there would be indistinguishable from
 * "the agent changed nothing" — the row would say +400,000 while the viewer
 * showed an empty diff and no explanation. The truncated stdout comes back as
 * `partial` so a caller can show what it has and say why the rest is missing.
 *
 * `--src-prefix`/`--dst-prefix` are pinned because `diff.noprefix=true` is a
 * config people really set, and it silently produces `diff --git n.txt n.txt`
 * — which every standard patch parser, this repo's own included, mis-reads.
 */
export async function diffCheckpointPatch(input: {
  cwd: string
  fromRef: string
  toRef: string
}): Promise<CheckpointPatch> {
  const result = await runGitCommand(input.cwd, [
    'diff',
    '--patch',
    '--no-color',
    '--no-ext-diff',
    '--no-textconv',
    '--src-prefix=a/',
    '--dst-prefix=b/',
    `${input.fromRef}^{commit}`,
    `${input.toRef}^{commit}`,
  ])
  if (result.ok) return { ok: true, patch: result.stdout }
  const tooLarge = /ENOBUFS|maxBuffer/i.test(result.message ?? '')
  return {
    ok: false,
    reason: tooLarge ? 'too-large' : 'unreadable',
    partial: result.stdout,
  }
}

/**
 * Every checkpoint ref a workspace owns, in TURN order.
 *
 * Not git's order, which is lexical: `for-each-ref` returns turn 10 between
 * turn 1 and turn 2, and the step-through walks this list. Sorted numerically
 * on the turn suffix here rather than zero-padding the ref, so the ref format
 * stays readable and an old unpadded ref never becomes unfindable.
 */
export async function listCheckpointRefs(input: {
  cwd: string
  workspaceId: string
}): Promise<string[]> {
  const prefix = checkpointRefPrefixFor(input.workspaceId)
  if (prefix === null) return []
  const result = await runGitCommand(input.cwd, ['for-each-ref', '--format=%(refname)', prefix])
  if (!result.ok) return []
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .sort((left, right) => turnOfRef(left) - turnOfRef(right))
}

/** The turn number a checkpoint ref encodes; -1 for anything unrecognisable. */
export function turnOfRef(ref: string): number {
  const match = /\/turn\/(\d+)$/.exec(ref)
  return match ? Number.parseInt(match[1], 10) : -1
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
