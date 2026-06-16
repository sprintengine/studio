// Cross-cutting "go look at this specific thing" signal, shell-generic and in
// the same window `CustomEvent` family as `multicode:panel-command` and
// `multicode:workspace-layer-revealed`.
//
// Why a latch: switching the active workspace does not guarantee the owning
// panel is mounted and listening yet (layouts are visibility-gated and a cold
// panel mounts a tick later). A naive "switch then dispatch" can fire before
// the consumer subscribes. So the dispatcher both stashes the pending target
// keyed by workspaceId AND emits a live event; the consumer drains the latch on
// its own mount/reveal and also handles the live event, so deep-link works
// whether the panel was already open or just spawned.
//
// The target payload is opaque to the shell — the owning module interprets
// `kind`/`ref` (e.g. Sprint Engine maps `{ kind: 'task', ref }` to board
// selection).

import type { NotificationNavigationTarget } from '../types/workspace'

export const REVEAL_TARGET_EVENT = 'multicode:reveal-target'

export type RevealTargetDetail = {
  workspaceId: string
  target: NotificationNavigationTarget
}

// Newest pending target per workspace. A second dispatch before the consumer
// drains supersedes the first — the latest "open this" wins, matching how a
// user expects the most recent click to land.
const pendingTargets = new Map<string, NotificationNavigationTarget>()

export function dispatchRevealTarget(detail: RevealTargetDetail): void {
  pendingTargets.set(detail.workspaceId, detail.target)
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent<RevealTargetDetail>(REVEAL_TARGET_EVENT, { detail }))
  }
}

// Drain the pending target for a workspace (read once, then clear). The
// consumer calls this on mount/reveal so a target dispatched before it was
// listening is not lost.
export function consumePendingRevealTarget(workspaceId: string): NotificationNavigationTarget | null {
  const target = pendingTargets.get(workspaceId) ?? null
  if (target) pendingTargets.delete(workspaceId)
  return target
}

// Subscribe to live reveal-target events. The handler should clear the latch
// for the workspace it consumes (via consumePendingRevealTarget) so the live
// path and the mount-drain path don't double-fire. Returns an unsubscribe fn.
export function subscribeRevealTarget(handler: (detail: RevealTargetDetail) => void): () => void {
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<RevealTargetDetail>).detail
    if (detail && typeof detail.workspaceId === 'string' && detail.target) handler(detail)
  }
  window.addEventListener(REVEAL_TARGET_EVENT, listener)
  return () => window.removeEventListener(REVEAL_TARGET_EVENT, listener)
}
