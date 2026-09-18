import { ipcRenderer } from 'electron'

import type { ElectronApi } from '../../shared/electron-api'
import type { BranchPullRequest } from '../../shared/git/pull-request'

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
  invoke(
    channel: 'pullRequest:listForWorkspaces',
    workspaceIds: readonly string[],
  ): Promise<Record<string, BranchPullRequest[]>>
  on(channel: 'pullRequest:workspaces-changed', listener: (event: unknown, ids: string[]) => void): void
  removeListener(channel: 'pullRequest:workspaces-changed', listener: (event: unknown, ids: string[]) => void): void
}

export function createPullRequestApi(renderer: PullRequestIpcRenderer) {
  return {
    refreshPullRequestsForSession: (sessionId: string): Promise<boolean> =>
      renderer.invoke('pullRequest:refreshForSession', sessionId),

    /**
     * What these CONVERSATIONS hold, whether or not anything is running in
     * them — the sidebar's rows for chats whose agents have finished, and the
     * project line that sums them.
     *
     * Conversations with nothing are simply absent from the answer rather than
     * present with an empty array, so a window asking about two hundred rows
     * gets back only the handful that have news.
     */
    listPullRequestsForWorkspaces: (workspaceIds: readonly string[]): Promise<Record<string, BranchPullRequest[]>> =>
      renderer.invoke('pullRequest:listForWorkspaces', workspaceIds),

    /**
     * Main saying which conversations' lists moved. It carries ids and never
     * the lists themselves: the renderer asks for what it is showing, so the
     * record stays in one place.
     */
    onPullRequestWorkspacesChanged: (listener: (workspaceIds: string[]) => void): (() => void) => {
      const handler = (_event: unknown, ids: string[]): void => listener(ids)
      renderer.on('pullRequest:workspaces-changed', handler)
      return () => renderer.removeListener('pullRequest:workspaces-changed', handler)
    },
  } satisfies Pick<
    ElectronApi,
    'refreshPullRequestsForSession' | 'listPullRequestsForWorkspaces' | 'onPullRequestWorkspacesChanged'
  >
}

export const pullRequestApi = createPullRequestApi(ipcRenderer)
