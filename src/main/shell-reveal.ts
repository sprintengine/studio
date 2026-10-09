import type { BrowserWindow } from 'electron'

import type { ChatLink } from '../shared/deep-link'
import { REMOTE_OPEN_REQUESTED_CHANNEL } from '../shared/tailnet'
import type { ShellRevealTarget } from '../server/shell-bridge/shell-bridge'

// Where a clicked notice takes the person, carried out by the shell, which
// owns the windows. Never the hidden canvas worker: with the pane closed and an
// agent drawing, it can be the only window open, and revealing it would show
// an empty frame.

export type ShellRevealDeps = {
  windows: () => BrowserWindow[]
  isCanvasWorker: (window: BrowserWindow) => boolean
  revealMainWindow: (window: BrowserWindow) => void
  /**
   * Open a chat as its `sprintengine://chat/…` link would: the link router
   * picks the window that holds it and brings it forward. Late-bound, since the
   * router is built with the app's lifecycle; null until then.
   */
  openChat?: () => ((link: ChatLink) => void) | null
}

export function createShellReveal(deps: ShellRevealDeps): (target: ShellRevealTarget) => boolean {
  return (target) => {
    if (target.kind === 'chat') {
      const open = deps.openChat?.()
      if (open) {
        open({ kind: 'chat', chatId: target.chatId, agentId: target.agentId ?? null })
        return true
      }
      // Too early for the router: the app itself comes forward, which is
      // where the chat is.
    }
    const window = deps.windows().find((candidate) => !candidate.isDestroyed() && !deps.isCanvasWorker(candidate))
    if (!window) return false
    deps.revealMainWindow(window)
    // The Remote popover opens in the first workspace window.
    if (target.kind === 'remote') window.webContents.send(REMOTE_OPEN_REQUESTED_CHANNEL)
    return true
  }
}
