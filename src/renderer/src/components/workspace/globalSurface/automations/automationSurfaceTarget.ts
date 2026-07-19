import type { NotificationNavigationTarget } from '../../../../types/workspace'
import { decodeAutomationTargetRef, type RunTargetRef } from '../../../automations/runTarget'

// The deep-link latch for the Automations full-page surface (global-surfaces
// epic 1704 / item 1707). A run notification's "Open" opens the door AND names
// the automation (and run) to select — but the door may open the surface a tick
// before it mounts and subscribes. So, exactly like the workspace `revealTarget`
// latch, the producer both stashes the pending ref and emits a live event; the
// surface drains the latch on mount and also handles the live event, so the
// deep-link lands whether the surface was already open or just mounted.
//
// Pure (a module-level ref + window CustomEvent, no store, no React) so it stays
// out of the eager module-registry graph and the notification-action provider
// can import it directly, the same discipline `revealTarget` follows.

export const AUTOMATION_SURFACE_TARGET_EVENT = 'multicode:automation-surface-target'

// The newest pending ref. A second dispatch before the surface drains supersedes
// the first — the latest "open this" wins, matching the most-recent-click intent.
let pendingRef: RunTargetRef | null = null

// Latch a navigation target for the surface to select. Accepts either the door
// kind or the legacy run kind (both decode to the same ref); a foreign/malformed
// target is ignored rather than latching a bad selection.
export function dispatchAutomationSurfaceTarget(target: NotificationNavigationTarget): void {
  const ref = decodeAutomationTargetRef(target)
  if (!ref) return
  pendingRef = ref
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent<RunTargetRef>(AUTOMATION_SURFACE_TARGET_EVENT, { detail: ref }))
  }
}

// Drain the pending ref (read once, then clear). The surface calls this on mount
// so a target dispatched before it was listening is not lost.
export function consumePendingAutomationSurfaceTarget(): RunTargetRef | null {
  const ref = pendingRef
  pendingRef = null
  return ref
}

// Subscribe to live target events. The handler should clear the latch (via
// consumePendingAutomationSurfaceTarget) so the live path and the mount-drain
// path don't double-fire. Returns an unsubscribe fn.
export function subscribeAutomationSurfaceTarget(handler: (ref: RunTargetRef) => void): () => void {
  const listener = (event: Event) => {
    const ref = (event as CustomEvent<RunTargetRef>).detail
    if (ref && typeof ref.automationId === 'string') handler(ref)
  }
  window.addEventListener(AUTOMATION_SURFACE_TARGET_EVENT, listener)
  return () => window.removeEventListener(AUTOMATION_SURFACE_TARGET_EVENT, listener)
}
