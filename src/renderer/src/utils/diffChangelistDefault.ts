// Which changelist a Diff opens on when nobody said (agent changelists, Wave 4).
//
// The rule is one sentence: the workspace's last-active agent, if that agent
// still has a changelist in this repository. Everything else about it is the
// consequence of two failures it must not have.
//
// IT MUST NOT SHOW AN EMPTY VIEWER. An agent's list is deleted the moment the
// agent exits with nothing left uncommitted (`reconcileChangelists`), and
// `lastActiveAgentId` outlives that by design — it is a memory of the layout,
// not a claim about git. So the list is looked up before it is named, and a
// missing one answers `null`, which every caller reads as "all changes".
//
// IT MUST NOT OUTRANK A REAL REQUEST. This is consulted only where the person
// named neither a file nor a list: the pane's "+ Diff", and a Diff tab restored
// with nothing in it. A Git panel row, a File Explorer "View Git diff" and the
// peek card's "open the diff" all carry their own answer and never come here.
//
// Pure — no store, no IPC — so the rule can be read and tested on its own.

import { changelistOwnerId, type Changelist } from '../../../shared/git/changelists'

/** The two fields of a workspace this decision rests on. Structural rather than
 *  `Workspace`, so the test can state its input in a line. The id is needed as
 *  much as the agent: `agent-1` is the first agent of nearly every chat, and the
 *  list is this chat's `agent-1`'s, not the one another chat left behind. */
export type LastActiveAgentSource = { id: string; lastActiveAgentId?: string | null }

/**
 * The last-active agent's list when the repository really has it, else
 * null. Null is not a failure — it is "all changes", which is the right answer
 * for a workspace with no agent, an agent that has committed everything, and a
 * repository whose lists have not been read yet.
 *
 * `launchWorkspaceId` is the workspace that agent's process was launched in,
 * when its session says so. An agent dragged in from another chat keeps its
 * process, and its list is filed under the chat that process names
 * (`agent-changelist-feed.ts`), so that list is looked for first; this chat's
 * is the answer once the agent is resumed here and starts a list of its own.
 */
export function defaultDiffChangelistId(
  workspace: LastActiveAgentSource | null | undefined,
  changelists: Changelist[] | null | undefined,
  launchWorkspaceId?: string | null,
): string | null {
  if (!workspace) return null
  const agentId = workspace.lastActiveAgentId
  if (typeof agentId !== 'string' || agentId.trim().length === 0) return null
  const lists = changelists ?? []
  for (const workspaceId of [launchWorkspaceId?.trim() || null, workspace.id]) {
    if (!workspaceId) continue
    const id = changelistOwnerId({ workspaceId, agentId })
    if (lists.some((list) => list.id === id)) return id
  }
  return null
}
