// Chromium reports a ResizeObserver whose callback resized what it observes as
// a window error, with this exact message. Nothing failed: the notifications
// it held back are delivered on the next frame. Logged as [RendererError] it
// read as a crash in every diagnostics report, so it is the one message the
// global handler lets pass. Exact match only — any other ResizeObserver
// complaint is still worth seeing.
const BENIGN_MESSAGES = new Set(['ResizeObserver loop completed with undelivered notifications.'])

/** True for a window error that is the browser talking, not the app failing. */
export function isBenignRendererError(message: string | undefined): boolean {
  return message !== undefined && BENIGN_MESSAGES.has(message)
}
