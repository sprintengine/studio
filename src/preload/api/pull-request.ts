import { ipc as ipcRenderer } from '../ipc-router'

import type { ElectronApi } from '../../shared/electron-api'

/**
 * A terminal agent's pull request marks' one call; a sidebar row's marks are
 * read from the Studio server over the protocol (`pullRequests.*`). Fired when a mark comes into
 * view or the pointer lands on a conversation; main looks the session's branch
 * up and re-reads any state that has gone stale.
 *
 * It takes a session id and answers only whether there was anything to ask
 * about — false for a session main cannot name or whose checkout has not
 * resolved yet, so a caller with one shot to spend does not spend it on a
 * question that was never put. The refreshed list itself arrives on the
 * `terminal:sessions-delta` snapshot the renderer already subscribes to.
 */
type PullRequestIpcRenderer = {
  invoke(channel: 'pullRequest:refreshForSession', sessionId: string): Promise<boolean>
}

export function createPullRequestApi(renderer: PullRequestIpcRenderer) {
  return {
    refreshPullRequestsForSession: (sessionId: string): Promise<boolean> =>
      renderer.invoke('pullRequest:refreshForSession', sessionId),
  } satisfies Pick<ElectronApi, 'refreshPullRequestsForSession'>
}

export const pullRequestApi = createPullRequestApi(ipcRenderer)
