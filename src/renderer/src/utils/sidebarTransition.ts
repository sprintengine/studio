// Shared signal for the workspace sidebar collapse/expand animation.
//
// The sidebar glides open/closed by transitioning the `<aside>` width
// (see WorkspaceSidebar.tsx — `transition-[width] duration-150`). Because the
// sidebar and the main panel are flex-row siblings, that width change resizes
// the main panel on every animation frame. The heavy panel children respond to
// each intermediate size: xterm terminals run `fitAddon.fit()` (reflow + canvas
// repaint + a PTY-resize IPC) and Monaco re-lays-out. Over a ~150 ms glide that
// is ~9× of that work per panel, which is what makes the animation stutter once
// many terminals/editors are mounted.
//
// This module lets those responders skip the intermediate sizes and do their
// work exactly once, when the animation lands. It is a plain module-level flag
// with imperative subscribers — consumers read it inside their existing
// ResizeObserver callbacks, so nothing here triggers a React re-render.
// Terminal panels consume the flag through createTerminalFitScheduler in
// terminalFitScheduler.ts, which also gates on container visibility and
// interactive window resizes.

type Listener = (animating: boolean) => void

// Keep in sync with the `duration-150` width transition on the sidebar
// `<aside>`. The hold buffer lets the layout settle before the trailing fit.
export const SIDEBAR_TRANSITION_MS = 150
const HOLD_BUFFER_MS = 60

let animating = false
let endTimer: number | null = null
const listeners = new Set<Listener>()

export function isSidebarAnimating(): boolean {
  return animating
}

export function onSidebarAnimating(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function setAnimating(next: boolean): void {
  if (next === animating) return
  animating = next
  for (const listener of listeners) listener(animating)
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

/**
 * Marks the start of a sidebar collapse/expand. Holds the animating flag for
 * the width-transition window, then clears it so deferred work runs once.
 *
 * Under reduced motion the width snaps with no transition, so there is no
 * window to protect — we leave the flag untouched and let resize work run
 * immediately.
 */
export function beginSidebarTransition(): void {
  if (prefersReducedMotion()) return
  setAnimating(true)
  if (endTimer !== null) window.clearTimeout(endTimer)
  endTimer = window.setTimeout(() => {
    endTimer = null
    setAnimating(false)
  }, SIDEBAR_TRANSITION_MS + HOLD_BUFFER_MS)
}
