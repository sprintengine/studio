import type { IpcMain } from 'electron'

/**
 * The one shell channel behind a terminal agent's pull request marks (epic
 * `pull-request-marks`): "this session is being looked at, make sure what you
 * know about its branch is fresh".
 *
 * It returns no pull requests. The record is the Studio server's, and a
 * session's list travels the way every other fact about a session does — a
 * `terminal:sessions-delta` snapshot carrying its `pullRequests`, filled from
 * what the server answered (terminal-pull-requests.ts). The sidebar's rows read
 * the server's lists by workspace over the Studio protocol themselves.
 *
 * What it DOES answer is whether there was anything to ask about: false for an
 * id the shell cannot name, and for a session whose checkout has not resolved
 * yet. The renderer fires this once per session and would otherwise spend that
 * one shot on a session that could not be asked about.
 *
 * The payload is a session id and nothing else: the renderer never names a
 * repository, a branch or a URL. A malformed id is dropped in silence, because
 * a hover must never surface an error.
 */
export type PullRequestIpcDependencies = {
  refreshPullRequestsForSession(sessionId: string): boolean
}

/** Cap on an id off the wire. Session ids are uuid-shaped; this is an abuse guard. */
const MAX_ID_LENGTH = 512

export function registerPullRequestIpc(ipcMain: IpcMain, deps: PullRequestIpcDependencies): void {
  ipcMain.handle('pullRequest:refreshForSession', (_event, sessionId: unknown): Promise<boolean> => {
    if (!isId(sessionId)) return Promise.resolve(false)
    return Promise.resolve(deps.refreshPullRequestsForSession(sessionId))
  })
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH && !value.includes('\0')
}
