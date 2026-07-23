// The deep-link latch for the Extensions door (MC-1847 B1). The modal-era
// `openExtensionsSurface({ view })` callers — the command palette, Settings →
// Modules, and the agent "Manage skills" footers — become "open the door and
// land on this rail row", but the door may open a tick before the surface
// mounts and subscribes. So, exactly like the automations surface-target latch,
// the producer both stashes the pending view and emits a live event; the
// surface drains the latch on mount and also handles the live event, so the
// deep-link lands whether the door was already open or just mounted.
//
// Pure (a module-level ref + window CustomEvent, no store, no React) so entry
// points can import it without pulling the door bundle into their graph.

/** The two deep-link destinations the old modal exposed; the surface maps them
 *  onto rail rows (browse → the marketplace grid, installed → Installed). */
export type ExtensionsSurfaceView = 'browse' | 'installed'

export const EXTENSIONS_SURFACE_TARGET_EVENT = 'multicode:extensions-surface-target'

// The newest pending view. A second dispatch before the surface drains
// supersedes the first — the latest "open this" wins.
let pendingView: ExtensionsSurfaceView | null = null

export function dispatchExtensionsSurfaceTarget(view: ExtensionsSurfaceView): void {
  pendingView = view
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent<ExtensionsSurfaceView>(EXTENSIONS_SURFACE_TARGET_EVENT, { detail: view }),
    )
  }
}

// Drain the pending view (read once, then clear). The surface calls this on
// mount so a target dispatched before it was listening is not lost.
export function consumePendingExtensionsSurfaceTarget(): ExtensionsSurfaceView | null {
  const view = pendingView
  pendingView = null
  return view
}

// Subscribe to live target events. The handler should clear the latch (via
// consumePendingExtensionsSurfaceTarget) so the live path and the mount-drain
// path don't double-fire. Returns an unsubscribe fn.
export function subscribeExtensionsSurfaceTarget(
  handler: (view: ExtensionsSurfaceView) => void,
): () => void {
  const listener = (event: Event) => {
    const view = (event as CustomEvent<ExtensionsSurfaceView>).detail
    if (view === 'browse' || view === 'installed') handler(view)
  }
  window.addEventListener(EXTENSIONS_SURFACE_TARGET_EVENT, listener)
  return () => window.removeEventListener(EXTENSIONS_SURFACE_TARGET_EVENT, listener)
}
