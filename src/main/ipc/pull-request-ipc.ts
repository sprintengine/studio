import type { IpcMain } from 'electron'

import type { BranchPullRequest } from '../../shared/git/pull-request'

/**
 * The one channel behind a conversation's pull request marks (epic
 * `pull-request-marks`, decision 10): "this session is being looked at, make
 * sure what you know about its branch is fresh".
 *
 * It returns no pull requests. The answer travels the way every other fact
 * about a session does — a `terminal:sessions-changed` snapshot carrying the
 * session's `pullRequests` — so there is exactly one path into the renderer and
 * no second copy of the record living in a promise result.
 *
 * What it DOES answer is whether there was anything to ask about: false for an
 * id main cannot name, and for a session whose checkout has not resolved yet.
 * The renderer fires this once per session and would otherwise spend that one
 * shot on a session that could not be asked about — the checkout resolves a
 * moment later and nothing would ever ask again.
 *
 * The payload is a session id and nothing else: the renderer never names a
 * repository, a branch or a URL, so nothing it sends can widen what main asks
 * GitHub. A malformed id is dropped in silence, because a hover must never
 * surface an error.
 */
/**
 * The SECOND channel, and the reason it exists (owner, 2026-09-10).
 *
 * Everything above is about a session, and a session's marks reach the renderer
 * on the `terminal:sessions-changed` snapshot — one path, no second copy. That
 * path can only carry what is running. The rows this channel serves are the ones
 * with nothing running in them: a chat whose agents have all finished still has
 * pull requests, and until now nothing could tell it so.
 *
 * So this asks a different question with a different key — by CONVERSATION, not
 * by session — and it is a read rather than a push because the renderer decides
 * which conversations are on screen and main should not broadcast the whole
 * history to every window on every change. What main pushes is only
 * `pullRequest:workspaces-changed`: the ids that moved, so a window knows to ask
 * again. The list itself is never in that event, so there is still exactly one
 * copy of the record and it still lives in main.
 */
export type PullRequestIpcDependencies = {
  refreshPullRequestsForSession(sessionId: string): boolean
  /** Every pull request these conversations hold, keyed by conversation id. */
  listForWorkspaces(workspaceIds: readonly string[]): Record<string, BranchPullRequest[]>
}

/**
 * A cap on how many conversations one ask may name. The sidebar asks about what
 * it is showing, which is bounded by the window; this is the abuse guard on a
 * channel that would otherwise walk an unbounded list per call.
 */
const MAX_WORKSPACE_IDS = 500

/** Cap on an id off the wire. Session ids are uuid-shaped; this is an abuse guard. */
const MAX_ID_LENGTH = 512

export function registerPullRequestIpc(ipcMain: IpcMain, deps: PullRequestIpcDependencies): void {
  ipcMain.handle('pullRequest:refreshForSession', (_event, sessionId: unknown): Promise<boolean> => {
    if (!isId(sessionId)) return Promise.resolve(false)
    return Promise.resolve(deps.refreshPullRequestsForSession(sessionId))
  })

  ipcMain.handle(
    'pullRequest:listForWorkspaces',
    (_event, workspaceIds: unknown): Promise<Record<string, BranchPullRequest[]>> => {
      if (!Array.isArray(workspaceIds)) return Promise.resolve({})
      // Malformed ids are dropped rather than refused: a sidebar asking about
      // twenty rows must not lose the other nineteen answers to one bad id.
      const ids = workspaceIds.filter(isId).slice(0, MAX_WORKSPACE_IDS)
      if (ids.length === 0) return Promise.resolve({})
      return Promise.resolve(deps.listForWorkspaces(ids))
    },
  )
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH && !value.includes('\0')
}
