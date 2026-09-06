// The deep-link latch for the Extensions door (MC-1847 B1). The
// `openExtensionsSurface({ view })` callers — the command palette, Settings →
// Modules, and the agent "Manage skills" footers — mean "open the door and land
// on this row", but the door may open a tick before the surface mounts and
// subscribes. So, exactly like the automations surface-target latch,
// the producer both stashes the pending view and emits a live event; the
// surface drains the latch on mount and also handles the live event, so the
// deep-link lands whether the door was already open or just mounted.
//
// Pure (a module-level ref + window CustomEvent, no store, no React) so entry
// points can import it without pulling the door bundle into their graph.

/** Deep-link destinations, mapped onto rail rows by the surface: browse → the
 *  marketplace grid, installed → Installed, skills → Skills, agent-clis → the
 *  Agent CLIs shelf. `skills` is where the retired `skill-packs` settings tab
 *  now lands (MC-1936) — the packs are gone, but a link that asked for skills
 *  must still arrive at skills. `agent-clis` arrived with the Extensions drawer
 *  (2026-09-05), whose Agent CLIs row is a deep link like any other. */
export type ExtensionsSurfaceView = 'browse' | 'installed' | 'skills' | 'agent-clis'

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
    if (view === 'browse' || view === 'installed' || view === 'skills' || view === 'agent-clis') handler(view)
  }
  window.addEventListener(EXTENSIONS_SURFACE_TARGET_EVENT, listener)
  return () => window.removeEventListener(EXTENSIONS_SURFACE_TARGET_EVENT, listener)
}
