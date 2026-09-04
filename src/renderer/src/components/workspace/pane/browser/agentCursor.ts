import type { BrowserController, BrowserPointerEvent } from '../../../../../../shared/browser'

// The agent cursor's arithmetic, pure so it is testable: where the arrow sits
// inside the (possibly scaled) device frame, and whether it shows at all.

/** How long the cursor stays after the agent's last pointer event. */
export const AGENT_CURSOR_LINGER_MS = 700

export type AgentCursorEvent = BrowserPointerEvent & { at: number }

/** Frame-relative position: the guest's CSS px scaled by the frame's fit. */
export function cursorPlacement(event: Pick<BrowserPointerEvent, 'x' | 'y'>, scale: number): { left: number; top: number } {
  const factor = Number.isFinite(scale) && scale > 0 ? scale : 1
  return { left: Math.round(event.x * factor), top: Math.round(event.y * factor) }
}

/**
 * Shown while the agent's last event is fresh — and never while the person
 * holds the page: a takeover hides the agent's hand at once.
 */
export function cursorVisible(event: AgentCursorEvent | null, now: number, controller: BrowserController): boolean {
  if (!event || controller === 'human') return false
  return now - event.at <= AGENT_CURSOR_LINGER_MS
}
