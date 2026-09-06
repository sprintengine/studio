// The deep-link latch for the Extensions door (MC-1847 B1). The
// `openExtensionsSurface({ view })` callers — the command palette, Settings →
// Modules, and the agent "Manage skills" footers — mean "open the door and land
// on this row", but the door may open a tick before the surface mounts and
// subscribes. So, exactly like the automations surface-target latch,
// the producer both stashes the pending target and emits a live event; the
// surface drains the latch on mount and also handles the live event, so the
// deep-link lands whether the door was already open or just mounted.
//
// Pure (a module-level ref + window CustomEvent, no store, no React) so entry
// points can import it without pulling the door bundle into their graph.

// The drawer rows this surface contributes (Extensions drawer ruling,
// 2026-09-05): the ids the module registers as its `views` and the surface
// publishes while it is showing one (surfaceView.ts). Kept here, in the leaf
// both the eager module registration and the lazy surface already import, so
// the row a person clicks and the row that lights are named by one constant.
export const EXTENSIONS_DRAWER_VIEWS = {
  plugins: 'plugins',
  skills: 'skills',
  agentClis: 'agent-clis',
} as const

export type ExtensionsDrawerView = (typeof EXTENSIONS_DRAWER_VIEWS)[keyof typeof EXTENSIONS_DRAWER_VIEWS]

/**
 * Where a deep link lands: one of the door's three real views, optionally on
 * its Installed tab.
 *
 * `browse` and `installed` were the whole vocabulary until the source-tabs
 * ruling (2026-09-05). They named the two halves of a surface that no longer
 * exists — one grid of everything, and one list of what you have — and by the
 * end of Stage 2 `browse` did not even reach the Plugins the drawer row named,
 * because the surface had grown a `plugins` section the union could not spell.
 * The views are the three the drawer offers now, and "what I have" is a TAB of
 * each of them rather than a fourth place.
 */
export type ExtensionsSurfaceTarget = {
  view: ExtensionsDrawerView
  /** Land on the Installed tab — what "Manage skills" means. */
  installed?: boolean
}

export const EXTENSIONS_SURFACE_TARGET_EVENT = 'multicode:extensions-surface-target'

const VIEWS: readonly string[] = Object.values(EXTENSIONS_DRAWER_VIEWS)

// The newest pending target. A second dispatch before the surface drains
// supersedes the first — the latest "open this" wins.
let pendingTarget: ExtensionsSurfaceTarget | null = null

export function dispatchExtensionsSurfaceTarget(target: ExtensionsSurfaceTarget): void {
  pendingTarget = target
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent<ExtensionsSurfaceTarget>(EXTENSIONS_SURFACE_TARGET_EVENT, { detail: target }),
    )
  }
}

// Drain the pending target (read once, then clear). The surface calls this on
// mount so a target dispatched before it was listening is not lost.
export function consumePendingExtensionsSurfaceTarget(): ExtensionsSurfaceTarget | null {
  const target = pendingTarget
  pendingTarget = null
  return target
}

// Subscribe to live target events. The handler should clear the latch (via
// consumePendingExtensionsSurfaceTarget) so the live path and the mount-drain
// path don't double-fire. Returns an unsubscribe fn.
export function subscribeExtensionsSurfaceTarget(
  handler: (target: ExtensionsSurfaceTarget) => void,
): () => void {
  const listener = (event: Event): void => {
    const target = (event as CustomEvent<ExtensionsSurfaceTarget>).detail
    if (target && VIEWS.includes(target.view)) handler(target)
  }
  window.addEventListener(EXTENSIONS_SURFACE_TARGET_EVENT, listener)
  return () => window.removeEventListener(EXTENSIONS_SURFACE_TARGET_EVENT, listener)
}
