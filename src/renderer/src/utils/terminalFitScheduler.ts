// Shared fit scheduler for xterm terminal panels.
//
// Terminal containers respond to size changes through a ResizeObserver that
// runs `fitAddon.fit()` (a forced reflow + buffer re-wrap) and a PTY-resize
// IPC. Three situations make the naive `requestAnimationFrame(fit)` debounce
// far too expensive once many terminals are mounted:
//
// 1. Inactive workspace layers are kept mounted with `visibility: hidden`
//    (see WorkspaceManager's retention cache). Hidden layers still have
//    layout, so a window resize fires every retained workspace's terminal
//    observers even though nothing they draw can be seen.
// 2. An interactive window resize emits a size change per animation frame,
//    so every visible terminal re-fits ~60× per second, re-wrapping up to
//    25k scrollback lines and SIGWINCH-ing its CLI on each frame.
// 3. The sidebar collapse/expand glide resizes the main column on every
//    frame of its 150 ms width transition (see sidebarTransition.ts).
//
// This scheduler resolves each case without changing what the user sees:
// fits for terminals that are not rendered are parked until their workspace
// layer is revealed; fits during a window resize are throttled to
// RESIZE_FIT_THROTTLE_MS with one trailing fit when the resize settles; fits
// during the sidebar glide keep the existing run-once-on-landing behavior.

import { isSidebarAnimating, onSidebarAnimating } from './sidebarTransition'

// Dispatched (as a plain window event) when a hidden workspace layer becomes
// the active, visible one. WorkspaceManager owns the dispatch; parked
// schedulers re-check their container and run the deferred fit.
export const WORKSPACE_LAYER_REVEAL_EVENT = 'sprintengine:workspace-layer-revealed'

// While the window is being interactively resized, visible terminals re-fit
// at most once per throttle window so the content still tracks the drag.
export const RESIZE_FIT_THROTTLE_MS = 100
// A window resize is considered settled after this long without a resize
// event; parked fits then run once at the final size.
const WINDOW_RESIZE_SETTLE_MS = 150

type ResizeSettleListener = () => void

let windowResizing = false
let windowResizeEndTimer: number | null = null
let windowResizeListenerInstalled = false
const resizeSettleListeners = new Set<ResizeSettleListener>()

function ensureWindowResizeListener(): void {
  if (windowResizeListenerInstalled || typeof window === 'undefined') return
  windowResizeListenerInstalled = true
  window.addEventListener('resize', () => {
    windowResizing = true
    if (windowResizeEndTimer !== null) window.clearTimeout(windowResizeEndTimer)
    windowResizeEndTimer = window.setTimeout(() => {
      windowResizeEndTimer = null
      windowResizing = false
      for (const listener of resizeSettleListeners) listener()
    }, WINDOW_RESIZE_SETTLE_MS)
  })
}

// checkVisibility is structurally typed so the call works regardless of which
// DOM lib version TypeScript resolves; older spec drafts named the option
// `checkVisibilityCSS`, newer ones `visibilityProperty`, so both are passed.
type VisibilityProbe = {
  checkVisibility?: (options?: { checkVisibilityCSS?: boolean; visibilityProperty?: boolean }) => boolean
}

function isContainerRendered(container: HTMLElement): boolean {
  const probe = container as HTMLElement & VisibilityProbe
  if (typeof probe.checkVisibility !== 'function') return true
  return probe.checkVisibility({ checkVisibilityCSS: true, visibilityProperty: true })
}

/**
 * Wraps an xterm fit callback so it only runs when the result can be seen.
 *
 * Call `requestFit` from the terminal's ResizeObserver. The fit is parked
 * while the container is not rendered (hidden workspace layer or hidden
 * FlexLayout tab), while the sidebar glide is animating, or — beyond the
 * throttle budget — while the window is being interactively resized. Each
 * parked fit runs exactly once when its gate lifts: layer reveal, glide
 * landing, or resize settle. A fit parked behind a hidden FlexLayout tab is
 * released by the ResizeObserver itself when the tab's display flips.
 *
 * `dispose` must run on teardown to drop the subscriptions.
 */
export function createTerminalFitScheduler(
  fit: () => void,
  container: HTMLElement,
): { requestFit: () => void; dispose: () => void } {
  ensureWindowResizeListener()

  let disposed = false
  let pendingReveal = false
  let pendingSidebarLanding = false
  let pendingResizeSettle = false
  let lastResizeFitAt = 0

  const schedule = (): void => {
    if (disposed) return
    if (!isContainerRendered(container)) {
      pendingReveal = true
      return
    }
    pendingReveal = false
    if (isSidebarAnimating()) {
      pendingSidebarLanding = true
      return
    }
    if (windowResizing) {
      const now = performance.now()
      if (now - lastResizeFitAt < RESIZE_FIT_THROTTLE_MS) {
        pendingResizeSettle = true
        return
      }
      lastResizeFitAt = now
      pendingResizeSettle = false
    }
    requestAnimationFrame(() => {
      if (!disposed) fit()
    })
  }

  const unsubscribeSidebar = onSidebarAnimating((animating) => {
    if (animating || !pendingSidebarLanding) return
    pendingSidebarLanding = false
    schedule()
  })

  const onResizeSettle: ResizeSettleListener = () => {
    if (!pendingResizeSettle) return
    pendingResizeSettle = false
    schedule()
  }
  resizeSettleListeners.add(onResizeSettle)

  const onReveal = (): void => {
    if (!pendingReveal) return
    schedule()
  }
  window.addEventListener(WORKSPACE_LAYER_REVEAL_EVENT, onReveal)

  return {
    requestFit: schedule,
    dispose: () => {
      disposed = true
      unsubscribeSidebar()
      resizeSettleListeners.delete(onResizeSettle)
      window.removeEventListener(WORKSPACE_LAYER_REVEAL_EVENT, onReveal)
    },
  }
}
