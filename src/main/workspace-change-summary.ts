import { diffCheckpointStat, hasCheckpointRef } from './checkpoint-store'
import { getGitRowSummary } from './git-status'
import { runGitCommand } from './git-utils'
import type { CheckpointIndex } from './checkpoint-index'
import type { GitRowSummary, WorkspaceChangeSummary } from '../shared/electron-api'

/**
 * What THIS workspace's agents changed — the honest replacement for the sidebar
 * row's repo-wide number (the-diff-an-agent-made / workspace-scoped-row-diff).
 *
 * `getGitRowSummary` answers "what does this folder look like", which is why
 * ten chats on one repo all read the same `+246 −94`. This answers "what did
 * the agents in this row do", by diffing the workspace's baseline checkpoint
 * against its latest one — so whatever the person already had dirty sits on
 * both sides and cancels.
 *
 * `scope` is part of the contract, not a debug field. A row that has no usable
 * checkpoints still wants to say something, and the folder reading is the
 * honest thing to say — but the UI must be able to tell the two apart, because
 * one is the agent's work and the other is the repo's.
 *
 * The rule this file exists to enforce: **never report a confident zero for a
 * span we could not read.** `diffCheckpointStat` is quiet by design and returns
 * zeros for a deleted ref, a pruned worktree or a re-cloned repo — and because
 * the row draws no stat at all for zeros, a workspace with real work would show
 * nothing, permanently, with no way back. Every path that cannot actually
 * measure the span falls back to the folder reading and says so.
 */
export async function getWorkspaceChangeSummary(
  input: { workspaceId: string; folderPath: string },
  deps: { index: CheckpointIndex; folderSummaries?: FolderSummaryShare }
): Promise<WorkspaceChangeSummary> {
  const timeline = deps.index.timelineFor(input.workspaceId)
  const turns = timeline?.turns ?? []
  const baseline = turns.find((turn) => turn.turn === 0)

  // The latest turn captured in the SAME working copy as the baseline. Two
  // agents in one workspace can run in different checkouts (one in a worktree,
  // one in the folder), and spanning across them diffs unrelated trees — a
  // review reproduced `+1 −100` over 11 files for a one-line edit. Turns from
  // another copy are skipped rather than trusted.
  const latest = baseline
    ? [...turns].reverse().find((turn) => turn.turn > 0 && turn.cwd === baseline.cwd)
    : undefined

  if (baseline && latest) {
    // Both refs must actually resolve. The index is bookkeeping; the repo is
    // the truth, and it can lose refs behind our back.
    const [hasBase, hasLatest] = await Promise.all([
      hasCheckpointRef({ cwd: baseline.cwd, ref: baseline.ref }),
      hasCheckpointRef({ cwd: latest.cwd, ref: latest.ref }),
    ])
    if (hasBase && hasLatest) {
      const stat = await diffCheckpointStat({
        cwd: baseline.cwd,
        fromRef: baseline.ref,
        toRef: latest.ref,
      })
      // Deliberately NOT falling back on an empty stat: once a turn has closed
      // and both refs resolve, "this agent changed nothing" is a true and
      // useful answer, and showing the repo's numbers there would be the exact
      // lie this child exists to remove (epic decision 6).
      return {
        // The branch is read from the checkout the NUMBERS came from, not from
        // the workspace folder. Pairing one repo's branch with another's stat
        // was its own small lie in the worktree case.
        branch: await readBranch(baseline.cwd),
        additions: stat.additions,
        deletions: stat.deletions,
        changedFiles: stat.changedFiles,
        scope: 'workspace',
      }
    }
  }

  // Fallback. Only HERE does the expensive read happen: `getGitRowSummary` runs
  // `diff --shortstat HEAD`, a full worktree scan. A checkpointed row costs two
  // cheap ref reads and a ref-to-ref diff instead — and the rows that DO land
  // here share one scan per folder per sweep (see `FolderSummaryShare`), so ten
  // fresh chats on one repo are one worktree scan, not ten.
  const folder = await (deps.folderSummaries ?? defaultFolderSummaries).read(input.folderPath)
  return {
    branch: folder.branch,
    additions: folder.additions,
    deletions: folder.deletions,
    changedFiles: 0,
    scope: 'folder',
  }
}

/**
 * One folder scan per sweep, shared by every un-checkpointed row on that folder.
 *
 * The renderer's poll asks per WORKSPACE — that is the point of the
 * checkpoint-scoped reading, each row answers for itself — but the fallback
 * for a row with no closed turn is the folder's `diff --shortstat HEAD`, and
 * ten fresh chats on one repo were ten full worktree scans every minute once
 * the old renderer-side folder dedupe went (6d4e28a6e). The guarantee the
 * two-line-rows spec makes is restored here, at the one place the scan runs:
 * a folder's read is shared while it is in flight and held for `holdMs` after
 * it settles, which covers a sweep's serial tail at the poll's concurrency of
 * four; the next 60s sweep always gets a fresh scan. The hold is measured from
 * settle rather than start on purpose — a slow scan on a large repo must not
 * expire while the rows queued behind it are still arriving.
 *
 * A rejected read is forgotten immediately, so a transient failure never pins
 * an error onto every row of the folder for the hold window.
 */
export type FolderSummaryShare = {
  read: (folderPath: string) => Promise<GitRowSummary>
}

export const FOLDER_SUMMARY_HOLD_MS = 15_000
/**
 * How long an in-flight read is shared before a newcomer starts its own. A
 * `git diff` hung on a spun-down volume must not pin every row of that folder,
 * in every window, for the life of main — before the share each row hung on
 * its own, and this keeps that worst case per read rather than per folder.
 */
export const FOLDER_SUMMARY_IN_FLIGHT_MAX_MS = 60_000

export function createFolderSummaryShare(
  read: (folderPath: string) => Promise<GitRowSummary>,
  options: { holdMs?: number; inFlightMaxMs?: number; now?: () => number } = {}
): FolderSummaryShare {
  const holdMs = options.holdMs ?? FOLDER_SUMMARY_HOLD_MS
  const inFlightMaxMs = options.inFlightMaxMs ?? FOLDER_SUMMARY_IN_FLIGHT_MAX_MS
  const now = options.now ?? Date.now
  type Entry = { promise: Promise<GitRowSummary>; startedAt: number; settledAt: number | null }
  const reads = new Map<string, Entry>()
  return {
    read(folderPath) {
      // Rows on one folder arrive with the folder path the workspace stores;
      // a trailing slash or a Windows separator must not split the share.
      const key = folderPath.replace(/\\/g, '/').replace(/\/+$/u, '')
      const existing = reads.get(key)
      if (existing) {
        const shareable = existing.settledAt === null
          ? now() - existing.startedAt < inFlightMaxMs
          : now() - existing.settledAt < holdMs
        if (shareable) return existing.promise
      }
      const entry: Entry = {
        promise: read(folderPath),
        startedAt: now(),
        settledAt: null,
      }
      entry.promise.then(
        () => {
          entry.settledAt = now()
        },
        () => {
          if (reads.get(key) === entry) reads.delete(key)
        }
      )
      reads.set(key, entry)
      return entry.promise
    },
  }
}

const defaultFolderSummaries = createFolderSummaryShare(getGitRowSummary)

/**
 * The branch name, or null on a detached HEAD / unreadable repo. `symbolic-ref`
 * rather than `rev-parse`: it names the branch even on an unborn HEAD and fails
 * on a detached checkout, which is exactly what a row wants shown.
 */
async function readBranch(cwd: string): Promise<string | null> {
  const result = await runGitCommand(cwd, ['symbolic-ref', '--short', 'HEAD'])
  if (!result.ok) return null
  return result.stdout.trim() || null
}
