import type { ShellRevealTarget } from '../shell-bridge/shell-bridge'

// How server code asks for a person's attention outside any window: a pairing
// request waiting for approval, a machine that came back.
//
// The desktop shows an OS notification. A standalone server has no screen, so
// the notice goes to whichever clients render notifications (a desktop, a web
// tab's Web Notifications), and a click comes back to it as an activation.

export type StudioNotice = {
  /**
   * Identifies what the notice is about. A later notice with the same key
   * replaces the earlier one rather than stacking under it ("waiting" becomes
   * "paired").
   */
  key: string
  title: string
  body?: string
  /** No sound with the banner. Absent, the OS plays its notification sound. */
  silent?: boolean
  /** What a click on the notice does, in this process. */
  onActivate?: () => void
  /**
   * Where a click goes, as data, for a notice another process shows (the
   * Studio server's, shown by the desktop shell): the shell carries it out.
   */
  activate?: ShellRevealTarget
}

export type Notifier = {
  notify(notice: StudioNotice): void
}

export type NoticeListener = (notice: StudioNotice) => void

/** The notifier outside Electron: in-process listeners, which the protocol's notification stream subscribes through. */
export type LocalNotifier = Notifier & {
  subscribe(listener: NoticeListener): () => void
}

export function createLocalNotifier(): LocalNotifier {
  const listeners = new Set<NoticeListener>()
  return {
    notify(notice) {
      for (const listener of [...listeners]) {
        try {
          listener(notice)
        } catch {
          // A notice is a courtesy; one listener's failure does not stop the rest.
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
