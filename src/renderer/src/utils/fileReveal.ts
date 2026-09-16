// "Select this file in the Files tree" signal, dispatched by the terminal link
// chooser (MC-1899) and consumed by FileExplorer.
//
// FileExplorer already knows how to reveal a path — it loads every parent
// directory, expands them, selects the row and scrolls it into view — but its
// only driver was the toolbar's "Reveal active file" button, so the path was
// hard-wired to the active editor file. This is the outside entry point.
//
// A latch+event pair: the Files panel is usually cold when the menu item is
// clicked — the same click reveals it via the panel rail, so it mounts a tick
// later and can miss a live event. The latch covers that race. Same shape, and
// for the same reason, as `backlogReveal.ts`.

const FILE_REVEAL_EVENT = 'multicode:reveal-file'

export type FileRevealDetail = {
  workspaceId: string
  // Absolute path of the file to expand to and select.
  path: string
}

// Newest pending reveal per workspace; a later dispatch supersedes an undrained
// one (latest click wins).
const pendingReveals = new Map<string, string>()

export function dispatchFileReveal(detail: FileRevealDetail): void {
  pendingReveals.set(detail.workspaceId, detail.path)
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent<FileRevealDetail>(FILE_REVEAL_EVENT, { detail }))
  }
}

// Drain the pending reveal for a workspace (read once, then clear), so a reveal
// dispatched before the panel was listening is not lost on its mount.
export function consumePendingFileReveal(workspaceId: string): string | null {
  const path = pendingReveals.get(workspaceId) ?? null
  if (path !== null) pendingReveals.delete(workspaceId)
  return path
}

export function subscribeFileReveal(handler: (detail: FileRevealDetail) => void): () => void {
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<FileRevealDetail>).detail
    if (detail && typeof detail.workspaceId === 'string' && typeof detail.path === 'string') {
      handler(detail)
    }
  }
  window.addEventListener(FILE_REVEAL_EVENT, listener)
  return () => window.removeEventListener(FILE_REVEAL_EVENT, listener)
}
