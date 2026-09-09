import type { IpcMain } from 'electron'

/**
 * The one channel behind a conversation's pull request marks (epic
 * `pull-request-marks`, decision 10): "this session is being looked at, make
 * sure what you know about its branch is fresh".
 *
 * It returns nothing. The answer travels the way every other fact about a
 * session does — a `terminal:sessions-changed` snapshot carrying the session's
 * `pullRequests` — so there is exactly one path into the renderer and no second
 * copy of the record living in a promise result.
 *
 * The payload is a session id and nothing else: the renderer never names a
 * repository, a branch or a URL, so nothing it sends can widen what main asks
 * GitHub. A malformed id is dropped in silence, because a hover must never
 * surface an error.
 */
export type PullRequestIpcDependencies = {
  refreshPullRequestsForSession(sessionId: string): void
}

/** Cap on an id off the wire. Session ids are uuid-shaped; this is an abuse guard. */
const MAX_ID_LENGTH = 512

export function registerPullRequestIpc(ipcMain: IpcMain, deps: PullRequestIpcDependencies): void {
  ipcMain.handle('pullRequest:refreshForSession', (_event, sessionId: unknown): Promise<void> => {
    if (!isId(sessionId)) return Promise.resolve()
    deps.refreshPullRequestsForSession(sessionId)
    return Promise.resolve()
  })
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH && !value.includes('\0')
}
