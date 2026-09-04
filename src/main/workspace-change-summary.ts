import { diffCheckpointStat, hasCheckpointRef } from './checkpoint-store'
import { getGitRowSummary } from './git-status'
import { runGitCommand } from './git-utils'
import type { CheckpointIndex } from './checkpoint-index'
import type { WorkspaceChangeSummary } from '../shared/electron-api'

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
  deps: { index: CheckpointIndex }
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
  // `diff --shortstat HEAD`, a full worktree scan, and running it for every row
  // on every sweep is the cost regression this ordering avoids — a checkpointed
  // row now costs two cheap ref reads and a ref-to-ref diff instead.
  const folder = await getGitRowSummary(input.folderPath)
  return {
    branch: folder.branch,
    additions: folder.additions,
    deletions: folder.deletions,
    changedFiles: 0,
    scope: 'folder',
  }
}

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
