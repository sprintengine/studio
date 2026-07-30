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

// What the arriving caller wants to do with the automation it named. `runs` is
// the historical behaviour (a run notification lands on the run history);
// `editor` is the Extensions shelf handing a freshly added automation over to
// the one place it is tailored (MC-2035) — the door opens with the automation
// selected and its editor showing, in one navigation.
//
// This is an intent carried BESIDE the ref, not a second way to address an
// automation: `decodeAutomationTargetRef` stays the only decoder, and the legacy
// `run` target kind keeps resolving exactly as it did.
export type AutomationSurfaceView = 'runs' | 'editor'

export type AutomationSurfaceTarget = {
  ref: RunTargetRef
  view: AutomationSurfaceView
}

// The newest pending target. A second dispatch before the surface drains
// supersedes the first — the latest "open this" wins, matching the
// most-recent-click intent.
let pendingTarget: AutomationSurfaceTarget | null = null

// Latch a navigation target for the surface to select. Accepts either the door
// kind or the legacy run kind (both decode to the same ref); a foreign/malformed
// target is ignored rather than latching a bad selection.
export function dispatchAutomationSurfaceTarget(
  target: NotificationNavigationTarget,
  view: AutomationSurfaceView = 'runs',
): void {
  const ref = decodeAutomationTargetRef(target)
  if (!ref) return
  pendingTarget = { ref, view }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent<AutomationSurfaceTarget>(AUTOMATION_SURFACE_TARGET_EVENT, { detail: pendingTarget }),
    )
  }
}

// Drain the pending target (read once, then clear). The surface calls this on
// mount so a target dispatched before it was listening is not lost.
export function consumePendingAutomationSurfaceTarget(): AutomationSurfaceTarget | null {
  const target = pendingTarget
  pendingTarget = null
  return target
}

// Subscribe to live target events. The handler should clear the latch (via
// consumePendingAutomationSurfaceTarget) so the live path and the mount-drain
// path don't double-fire. Returns an unsubscribe fn.
export function subscribeAutomationSurfaceTarget(handler: (target: AutomationSurfaceTarget) => void): () => void {
  const listener = (event: Event) => {
    const target = (event as CustomEvent<AutomationSurfaceTarget>).detail
    if (target && typeof target.ref?.automationId === 'string') handler(target)
  }
  window.addEventListener(AUTOMATION_SURFACE_TARGET_EVENT, listener)
  return () => window.removeEventListener(AUTOMATION_SURFACE_TARGET_EVENT, listener)
}
