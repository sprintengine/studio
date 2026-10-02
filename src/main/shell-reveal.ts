import type { BrowserWindow } from 'electron'

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
}

export function createShellReveal(deps: ShellRevealDeps): (target: ShellRevealTarget) => boolean {
  return (target) => {
    const window = deps.windows().find((candidate) => !candidate.isDestroyed() && !deps.isCanvasWorker(candidate))
    if (!window) return false
    deps.revealMainWindow(window)
    // The Remote popover opens in the first workspace window.
    if (target.kind === 'remote') window.webContents.send(REMOTE_OPEN_REQUESTED_CHANNEL)
    return true
  }
}
