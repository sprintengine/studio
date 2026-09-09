import { ipcRenderer } from 'electron'

import type { ElectronApi } from '../../shared/electron-api'

/**
 * The conversation pull request marks' one call. Fired when a mark comes into
 * view or the pointer lands on a conversation; main looks the session's branch
 * up and re-reads any state that has gone stale.
 *
 * It takes a session id and answers nothing: the refreshed list arrives on the
 * `terminal:sessions-changed` snapshot the renderer already subscribes to.
 */
type PullRequestIpcRenderer = {
  invoke(channel: 'pullRequest:refreshForSession', sessionId: string): Promise<void>
}

export function createPullRequestApi(renderer: PullRequestIpcRenderer) {
  return {
    refreshPullRequestsForSession: (sessionId: string): Promise<void> =>
      renderer.invoke('pullRequest:refreshForSession', sessionId),
  } satisfies Pick<ElectronApi, 'refreshPullRequestsForSession'>
}

export const pullRequestApi = createPullRequestApi(ipcRenderer)
