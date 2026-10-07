import type { WorkspaceActivity } from './workspaceManagerHelpers'

// ⌘⏎ in New chat (`chat.new.launchInBackground`), the host's half: start the
// chat ⏎ would start, and keep the person on New chat.
//
// The launch is ⏎'s own, so the chat it creates becomes the window's active
// chat — UNDER the door, which is what mounts it and starts its agent. The
// window parks New chat whenever its active chat changes; this remembers the
// chats a ⌘⏎ made so that one activation each is let through. And because the
// person never sees the chat start, each is watched for its first minute: a
// failure then is reported, since nothing on screen would show it.

/** How long a chat started with ⌘⏎ is watched for a failure. */
export const NEW_CHAT_STAY_WATCH_MS = 60_000

export type NewChatStay = ReturnType<typeof createNewChatStay>

export function createNewChatStay(now: () => number = Date.now) {
  let collecting: Set<string> | null = null
  const keepOver = new Set<string>()
  const watched = new Map<string, number>()

  return {
    /** A ⌘⏎ launch is running: the launch paths leave the door up. */
    isRunning(): boolean {
      return collecting !== null
    },
    /** Run ⏎'s launch with the door kept up; whether it created a chat. */
    async run(launch: () => unknown): Promise<boolean> {
      const created = new Set<string>()
      collecting = created
      try {
        await launch()
      } finally {
        collecting = null
      }
      const at = now()
      for (const workspaceId of created) watched.set(workspaceId, at)
      return created.size > 0
    },
    /** A chat was created; part of the running ⌘⏎ launch, if there is one. */
    noteCreated(workspaceId: string): void {
      if (!collecting) return
      collecting.add(workspaceId)
      keepOver.add(workspaceId)
    },
    /** The window's active chat became `workspaceId`: true once for a ⌘⏎ chat, which keeps New chat up. */
    keepsNewChatOver(workspaceId: string | null): boolean {
      return workspaceId !== null && keepOver.delete(workspaceId)
    },
    /**
     * The watched chats that have just failed, to report — not one on screen,
     * whose failure the person can see. A chat that stops to ask has started,
     * and is the Home badge's from then on.
     */
    takeFailures(
      activityByWorkspaceId: Readonly<Record<string, WorkspaceActivity>>,
      isOnScreen: (workspaceId: string) => boolean,
    ): string[] {
      const failed: string[] = []
      const at = now()
      for (const [workspaceId, startedAt] of watched) {
        const activity = activityByWorkspaceId[workspaceId]
        if (activity === 'failed') {
          watched.delete(workspaceId)
          if (!isOnScreen(workspaceId)) failed.push(workspaceId)
        } else if (activity === 'needs-input' || at - startedAt > NEW_CHAT_STAY_WATCH_MS) {
          watched.delete(workspaceId)
        }
      }
      return failed
    },
  }
}
