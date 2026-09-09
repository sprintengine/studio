import { ipcRenderer } from 'electron'

import type { ElectronApi } from '../../shared/electron-api'

/**
 * The conversation pull request marks' one call. Fired when a mark comes into
 * view or the pointer lands on a conversation; main looks the session's branch
 * up and re-reads any state that has gone stale.
 *
 * It takes a session id and answers only whether there was anything to ask
 * about — false for a session main cannot name or whose checkout has not
 * resolved yet, so a caller with one shot to spend does not spend it on a
 * question that was never put. The refreshed list itself arrives on the
 * `terminal:sessions-changed` snapshot the renderer already subscribes to.
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
