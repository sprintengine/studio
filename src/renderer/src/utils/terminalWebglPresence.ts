import { WORKSPACE_LAYER_REVEAL_EVENT } from './terminalFitScheduler'
import { createTerminalWebglBudget, type TerminalWebglBudget, type TerminalWebglPresence } from './terminalWebglBudget'
import { windowActivity } from './windowActivity'

/**
 * The DOM half of the WebGL budget: where a terminal's element actually is,
 * and when that may have changed.
 *
 * - Gone from the document, or inside a cold workspace layer
 *   (`data-layer-state="cold"`, set by WorkspaceManager on the layer that is
 *   rendered with `content-visibility: hidden`) → `off`.
 * - Not visible — a warm layer (`visibility: hidden`), a tab behind another
 *   tab (`display: none`), or a hidden window → `parked`.
 * - Otherwise → `on-screen`.
 *
 * Presence is re-read when a layer is revealed (the event WorkspaceManager
 * already dispatches for deferred fits), when the window is shown or hidden,
 * and when the terminal's own box appears or disappears (a tab switch).
 */

type VisibilityProbe = {
  checkVisibility?: (options?: { checkVisibilityCSS?: boolean; visibilityProperty?: boolean }) => boolean
}

export function readTerminalWebglPresence(
  element: Element | null | undefined,
  windowVisible: boolean = windowActivity().get().visible,
): TerminalWebglPresence {
  if (!element || !element.isConnected) return 'off'
  if (element.closest('[data-layer-state="cold"]')) return 'off'
  if (!windowVisible) return 'parked'
  const probe = element as Element & VisibilityProbe
  // An engine without checkVisibility cannot tell; treat the pane as seen, which
  // is what every pane was before the budget existed.
  if (typeof probe.checkVisibility !== 'function') return 'on-screen'
  return probe.checkVisibility({ checkVisibilityCSS: true, visibilityProperty: true }) ? 'on-screen' : 'parked'
}

/** This window's budget. One renderer process, one Chromium context limit. */
export const terminalWebglBudget: TerminalWebglBudget = createTerminalWebglBudget()

let windowSignalsInstalled = false

function installWindowSignals(): void {
  if (windowSignalsInstalled || typeof window === 'undefined' || typeof document === 'undefined') return
  windowSignalsInstalled = true
  const updateAll = (): void => terminalWebglBudget.updateAll()
  window.addEventListener(WORKSPACE_LAYER_REVEAL_EVENT, updateAll)
  windowActivity().subscribe(updateAll)
}

/**
 * Call `onChange` whenever `element`'s presence may have moved: the window
 * signals above, plus its own box appearing or disappearing. Returns the
 * unwatch.
 */
export function watchTerminalPresence(element: Element, onChange: () => void): () => void {
  installWindowSignals()
  if (typeof ResizeObserver === 'undefined') return () => undefined
  // The first callback reports the initial size; the lease has already been
  // updated for that, and a second pass is harmless.
  const observer = new ResizeObserver(() => onChange())
  observer.observe(element)
  return () => observer.disconnect()
}
