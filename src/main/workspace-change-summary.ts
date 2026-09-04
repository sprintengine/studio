import { diffCheckpointStat } from './checkpoint-store'
import { getGitRowSummary } from './git-status'
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
 * `scope` is part of the contract, not a debug field. A row that has no
 * checkpoints yet still wants to say something, and the folder reading is the
 * honest thing to say — but the UI must be able to tell the two apart, because
 * one is the agent's work and the other is the repo's.
 */
export async function getWorkspaceChangeSummary(
  input: { workspaceId: string; folderPath: string },
  deps: { index: CheckpointIndex }
): Promise<WorkspaceChangeSummary> {
  // The branch is a FOLDER fact, true of every workspace in the repo, and the
  // row wants it in both scopes. Read once here rather than twice below.
  const folder = await getGitRowSummary(input.folderPath)

  const timeline = deps.index.timelineFor(input.workspaceId)
  const turns = timeline?.turns ?? []
  const baseline = turns.find((turn) => turn.turn === 0)
  const latest = turns[turns.length - 1]

  // A workspace mid-way through its FIRST turn has a baseline and nothing to
  // measure against it yet. It falls back rather than reporting a confident
  // zero, because "the agent has changed nothing" and "we have not captured
  // what the agent changed" are different claims and only one of them is true.
  if (!baseline || !latest || latest.turn === 0 || !timeline) {
    return {
      branch: folder.branch,
      additions: folder.additions,
      deletions: folder.deletions,
      changedFiles: 0,
      scope: 'folder',
    }
  }

  const stat = await diffCheckpointStat({
    cwd: timeline.cwd,
    fromRef: baseline.ref,
    toRef: latest.ref,
  })

  // Deliberately NOT falling back when the stat is empty: once a turn has
  // closed, "this agent changed nothing" is a true and useful answer, and
  // showing the repo's numbers there would be the exact lie this child exists
  // to remove (epic decision 6).
  return {
    branch: folder.branch,
    additions: stat.additions,
    deletions: stat.deletions,
    changedFiles: stat.changedFiles,
    scope: 'workspace',
  }
}
