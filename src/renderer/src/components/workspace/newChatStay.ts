import type { WorkspaceActivity } from './workspaceManagerHelpers'

// ⌘⏎ in New chat (`chat.new.launchInBackground`), the host's half: start the
// chat ⏎ would start, and keep the person on New chat.
//
// The chat is created without being brought to the front: the window keeps
// what it shows, nothing treats the chat as looked at, and it earns its
// "finished while you were away" mark like any chat out of sight. Its agent
// starts where it is mounted, so until it is seen under way the chat is held
// as a warm hidden layer (`starting`). And because the person never sees it
// start, each is watched for its first minute: a failure then is reported,
// since nothing on screen would show it.

/** How long a chat started with ⌘⏎ is watched for a failure. */
export const NEW_CHAT_STAY_WATCH_MS = 60_000

export type NewChatStay = ReturnType<typeof createNewChatStay>

export type NewChatStayReview = {
  /** Watched chats that have just failed, to report. */
  failed: string[]
  /**
   * Started and not yet seen under way: held mounted, so the agent the chat
   * view starts gets to start. The first minute at most.
   */
  starting: string[]
}

export function createNewChatStay(now: () => number = Date.now) {
  const watched = new Map<string, { startedAt: number; underWay: boolean }>()

  const startingIds = (): string[] =>
    [...watched].filter(([, watch]) => !watch.underWay).map(([workspaceId]) => workspaceId)

  return {
    /** A chat ⌘⏎ just created, out of sight. */
    started(workspaceId: string): void {
      watched.set(workspaceId, { startedAt: now(), underWay: false })
    },
    /** The chats started and not yet seen under way. */
    starting(): string[] {
      return startingIds()
    },
    /**
     * Read the latest activity. A failure is reported unless the chat is on
     * screen, where the person can see it; a chat that stops to ask has
     * started, and is the Home badge's from then on; past its first minute a
     * failure is an ordinary failed turn, and a chat closed meanwhile is
     * forgotten with it.
     */
    review(
      activityByWorkspaceId: Readonly<Record<string, WorkspaceActivity>>,
      isOnScreen: (workspaceId: string) => boolean,
      // Its worktree is still being made: its agent cannot start yet, so its
      // first minute has not begun. Counted from when the folder lands, a
      // worktree slower than a minute does not let the chat go before its
      // agent could start.
      isWaitingOnWorktree: (workspaceId: string) => boolean = () => false,
    ): NewChatStayReview {
      const failed: string[] = []
      const at = now()
      for (const [workspaceId, watch] of watched) {
        if (isWaitingOnWorktree(workspaceId)) watch.startedAt = at
        const activity = activityByWorkspaceId[workspaceId]
        if (activity === 'failed') {
          watched.delete(workspaceId)
          if (!isOnScreen(workspaceId)) failed.push(workspaceId)
        } else if (activity === 'needs-input' || at - watch.startedAt > NEW_CHAT_STAY_WATCH_MS) {
          watched.delete(workspaceId)
        } else if (activity === 'working') {
          watch.underWay = true
        }
      }
      return { failed, starting: startingIds() }
    },
  }
}
