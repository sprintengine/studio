import { useCallback, useEffect, useMemo, useState } from 'react'

import { selectedEntry, stripEntriesFrom } from './branchSteps'
import { isWindowVisible, onWindowVisibilityChange } from '../../utils/windowActivity'
import type { BranchStepDiff, BranchStepSelection, BranchStepsSnapshot } from '../../../../shared/electron-api'

/**
 * The branch's steps and the selected step's diff
 * (the-diff-an-agent-made / changed-files-and-commit-steps).
 *
 * Read live and never cached across a change: a rebase or an amend
 * re-identifies commits, so a strip held from before one would be confidently
 * wrong about work that no longer exists under those hashes.
 *
 * TWO triggers, and the second exists because the first is not enough. The
 * caller's git-status snapshot fires whenever the working tree moves, which is
 * the common case and the cheap one. But `GitStatusSnapshot` carries no branch
 * and no HEAD, so on a CLEAN tree a rebase, a `commit --amend` and a
 * `git checkout other-branch` all leave its signature identical — and a review
 * confirmed the strip then kept the previous branch's chips indefinitely, still
 * clickable, because the reflog keeps the objects. So main's git-directory
 * watch backs the snapshot up: every one of those moves rewrites HEAD or a ref,
 * and main says so (`watchGitCheckout`, git-repo-watch.ts). It used to be a
 * ten-second interval, which re-read the strip whether or not anything moved.
 */
export type BranchStepsState = {
  snapshot: BranchStepsSnapshot | null
  diff: BranchStepDiff | null
  selection: BranchStepSelection
  loading: boolean
  select: (selection: BranchStepSelection) => void
}

const SPAN: BranchStepSelection = { kind: 'span' }

export function useBranchSteps(repoRoot: string | null, enabled: boolean, revision: unknown): BranchStepsState {
  const [snapshot, setSnapshot] = useState<BranchStepsSnapshot | null>(null)
  const [diff, setDiff] = useState<BranchStepDiff | null>(null)
  const [selection, setSelection] = useState<BranchStepSelection>(SPAN)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!enabled || !repoRoot || typeof window.api?.getBranchSteps !== 'function') {
      setSnapshot(null)
      return
    }
    let cancelled = false
    // A read skipped while the window could not be seen runs when it is shown
    // again, so a ref that moved in the meantime is not missed until the next
    // change. The window-activity signal, not `document.hidden`, which macOS
    // leaves false for a minimized window.
    let missed = false
    const read = async (): Promise<void> => {
      if (!isWindowVisible()) {
        missed = true
        return
      }
      missed = false
      try {
        const next = await window.api.getBranchSteps(repoRoot)
        if (!cancelled) setSnapshot(next)
      } catch {
        // Quiet: the strip falls back to the span, which always reads.
        if (!cancelled) setSnapshot(null)
      }
    }
    void read()
    const stopWatching =
      typeof window.api.watchGitCheckout === 'function'
        ? window.api.watchGitCheckout(repoRoot, (change) => {
            if (change.kinds.includes('refs')) void read()
          })
        : null
    const stopVisibility = onWindowVisibilityChange((visible) => {
      if (visible && missed) void read()
    })
    return () => {
      cancelled = true
      stopWatching?.()
      stopVisibility()
    }
  }, [repoRoot, enabled, revision])

  // A repo change must not leave the previous repo's chips on screen while the
  // new snapshot is in flight — the selection would be resolved against a strip
  // belonging to somewhere else.
  useEffect(() => {
    setSnapshot(null)
    setSelection(SPAN)
  }, [repoRoot])

  // A selection can stop existing under us — a rebase drops the hash a person
  // had open. Resolving through the strip's own entries means the surface falls
  // back to the span rather than showing an empty list beneath a dead chip.
  const resolved = useMemo(() => {
    if (!enabled) return SPAN
    return selectedEntry(stripEntriesFrom(snapshot), selection).selection
  }, [enabled, snapshot, selection])

  useEffect(() => {
    if (!enabled || !repoRoot || typeof window.api?.getBranchStepDiff !== 'function') {
      setDiff(null)
      return
    }
    let cancelled = false
    setLoading(true)
    void (async () => {
      try {
        const next = await window.api.getBranchStepDiff(repoRoot, resolved)
        if (!cancelled) setDiff(next)
      } catch {
        if (!cancelled) setDiff(null)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
    // `resolved` is a fresh object each render, so the key is its content.
  }, [repoRoot, enabled, revision, resolved.kind, resolved.kind === 'commit' ? resolved.hash : ''])

  const select = useCallback((next: BranchStepSelection) => setSelection(next), [])

  return { snapshot, diff, selection: resolved, loading, select }
}
