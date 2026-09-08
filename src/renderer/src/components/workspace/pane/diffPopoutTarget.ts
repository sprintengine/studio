// The deep-link latch for the Diff popout (the pane-to-popup mechanism,
// 2026-09-05). The pane strip's "Open in a popup" names the repository and the
// file the viewer should open on, then opens the `diff` modal surface — but a
// modal surface is addressed by id alone, and it may mount a tick after the
// open. So, exactly like the Automations and Extensions surface-target latches,
// the producer both stashes the pending target and emits a live event; the
// popout drains the latch on mount and also handles the live event, so a second
// "Open in a popup" while the popout is already up retargets it in place.
//
// Pure (a module-level ref + window CustomEvent, no store, no React) so the
// pane strip can import it without pulling the viewer bundle into its graph.

export type DiffPopoutTarget = {
  repoRoot: string
  focusPath: string | null
  focusKind: 'staged' | 'unstaged' | null
}

const DIFF_POPOUT_TARGET_EVENT = 'multicode:diff-popout-target'

// The newest pending target. A second dispatch before the popout drains
// supersedes the first — the latest "open this" wins.
let pendingTarget: DiffPopoutTarget | null = null

export function dispatchDiffPopoutTarget(target: DiffPopoutTarget): void {
  pendingTarget = target
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent<DiffPopoutTarget>(DIFF_POPOUT_TARGET_EVENT, { detail: target }))
  }
}

// Drain the pending target (read once, then clear). The popout calls this on
// mount so a target dispatched before it was listening is not lost.
export function consumePendingDiffPopoutTarget(): DiffPopoutTarget | null {
  const target = pendingTarget
  pendingTarget = null
  return target
}

// Subscribe to live target events. The handler should clear the latch (via
// consumePendingDiffPopoutTarget) so the live path and the mount-drain path
// don't double-fire. Returns an unsubscribe fn.
export function subscribeDiffPopoutTarget(handler: (target: DiffPopoutTarget) => void): () => void {
  const listener = (event: Event) => {
    const target = (event as CustomEvent<DiffPopoutTarget>).detail
    if (target && typeof target.repoRoot === 'string') handler(target)
  }
  window.addEventListener(DIFF_POPOUT_TARGET_EVENT, listener)
  return () => window.removeEventListener(DIFF_POPOUT_TARGET_EVENT, listener)
}
