// "Select this Backlog item" signal, dispatched by the agent terminal glyph and
// consumed by BacklogPanel.
//
// A latch+event pair: the Backlog panel is often cold when the glyph is
// clicked — the same click opens its workspace-pane tab
// (`revealBacklogItemInPane`), so it mounts a tick later and can miss a live
// event. The latch covers that race.

const BACKLOG_REVEAL_EVENT = 'sprintengine:reveal-backlog-item'

export type BacklogRevealDetail = {
  workspaceId: string
  // Project-relative `backlog/...` path of the item to select.
  relativePath: string
}

// Newest pending reveal per workspace; a later dispatch supersedes an undrained
// one (latest click wins).
const pendingReveals = new Map<string, string>()

export function dispatchBacklogReveal(detail: BacklogRevealDetail): void {
  pendingReveals.set(detail.workspaceId, detail.relativePath)
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent<BacklogRevealDetail>(BACKLOG_REVEAL_EVENT, { detail }))
  }
}

// Drain the pending reveal for a workspace (read once, then clear), so a reveal
// dispatched before the panel was listening is not lost on its mount.
export function consumePendingBacklogReveal(workspaceId: string): string | null {
  const relativePath = pendingReveals.get(workspaceId) ?? null
  if (relativePath !== null) pendingReveals.delete(workspaceId)
  return relativePath
}

export function subscribeBacklogReveal(handler: (detail: BacklogRevealDetail) => void): () => void {
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<BacklogRevealDetail>).detail
    if (detail && typeof detail.workspaceId === 'string' && typeof detail.relativePath === 'string') {
      handler(detail)
    }
  }
  window.addEventListener(BACKLOG_REVEAL_EVENT, listener)
  return () => window.removeEventListener(BACKLOG_REVEAL_EVENT, listener)
}
