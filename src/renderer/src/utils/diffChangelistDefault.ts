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

/** The one field of a workspace this decision rests on. Structural rather than
 *  `Workspace`, so the test can state its input in a line. */
export type LastActiveAgentSource = { lastActiveAgentId?: string | null }

/**
 * `agent:<lastActiveAgentId>` when the repository really has that list, else
 * null. Null is not a failure — it is "all changes", which is the right answer
 * for a workspace with no agent, an agent that has committed everything, and a
 * repository whose lists have not been read yet.
 */
export function defaultDiffChangelistId(
  workspace: LastActiveAgentSource | null | undefined,
  changelists: Changelist[] | null | undefined,
): string | null {
  const agentId = workspace?.lastActiveAgentId
  if (typeof agentId !== 'string' || agentId.trim().length === 0) return null
  const id = changelistOwnerId(agentId)
  return (changelists ?? []).some((list) => list.id === id) ? id : null
}
