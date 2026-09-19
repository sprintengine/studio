// "Open the palette, narrowed to this, for THIS agent."
//
// The palette's open state lives in WorkspaceManager — the shortcut that raises
// it fires when the palette is unmounted, so it has to. The terminal's star
// lives eight components down, inside a pane that knows the one thing the
// palette most needs and cannot work out for itself: which session the person
// is looking at. Threading a callback down that tree would put a palette prop
// on every pane between them.
//
// So it is a window event, exactly like the Extensions door's deep link: pure,
// no store, nothing in the eager module graph, and the shell is the one
// listener. There is no latch — unlike the door's target, the shell is always
// mounted, so a request can never arrive before its listener.

import type { PaletteScope } from '../commandPaletteSearch'

/**
 * The agent a palette result should land in without asking.
 *
 * Enough to paste into and to render the right CLI's invocation. The palette
 * still verifies the session is live before using it: a pane's session can
 * exit between the star being clicked and a row being chosen.
 */
export type PaletteAgentTarget = {
  sessionId: string
  /** The agent CLI's plugin id (`claude-code`, `codex`…), when known. */
  cli?: string
  workspaceId?: string
}

export type PaletteOpenRequest = {
  /** Which groups to narrow to. Absent behaves as the full launcher. */
  scope?: PaletteScope
  /** The pane that asked, when one did. */
  target?: PaletteAgentTarget | null
}

const PALETTE_OPEN_REQUEST_EVENT = 'multicode:palette-open-request'

export function requestPaletteOpen(request: PaletteOpenRequest): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent<PaletteOpenRequest>(PALETTE_OPEN_REQUEST_EVENT, { detail: request }))
}

/** The shell subscribes on mount. Returns an unsubscribe fn. */
export function subscribePaletteOpenRequest(handler: (request: PaletteOpenRequest) => void): () => void {
  const listener = (event: Event): void => {
    const request = (event as CustomEvent<PaletteOpenRequest>).detail
    if (request) handler(request)
  }
  window.addEventListener(PALETTE_OPEN_REQUEST_EVENT, listener)
  return () => window.removeEventListener(PALETTE_OPEN_REQUEST_EVENT, listener)
}
