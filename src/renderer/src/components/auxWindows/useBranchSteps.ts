import { useCallback, useEffect, useMemo, useState } from 'react'

import { selectedEntry, stripEntriesFrom } from './branchSteps'
import type {
  BranchStepDiff,
  BranchStepSelection,
  BranchStepsSnapshot,
} from '../../../../shared/electron-api'

/**
 * The branch's steps and the selected step's diff
 * (the-diff-an-agent-made / changed-files-and-commit-steps).
 *
 * Read live and never cached across a change: a rebase or an amend
 * re-identifies commits, so a strip held from before one would be confidently
 * wrong about work that no longer exists under those hashes. `revision` is the
 * caller's git-status snapshot — the watcher already knows when the tree moved,
 * and re-reading on it is cheaper and more accurate than a timer.
 */
export type BranchStepsState = {
  snapshot: BranchStepsSnapshot | null
  diff: BranchStepDiff | null
  selection: BranchStepSelection
  loading: boolean
  select: (selection: BranchStepSelection) => void
}

const SPAN: BranchStepSelection = { kind: 'span' }

export function useBranchSteps(
  repoRoot: string | null,
  enabled: boolean,
  revision: unknown
): BranchStepsState {
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
    void (async () => {
      try {
        const next = await window.api.getBranchSteps(repoRoot)
        if (!cancelled) setSnapshot(next)
      } catch {
        // Quiet: the strip falls back to the span, which always reads.
        if (!cancelled) setSnapshot(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [repoRoot, enabled, revision])

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
