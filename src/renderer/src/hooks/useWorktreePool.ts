import { useCallback, useEffect, useRef, useState } from 'react'

import type { WorktreePoolSnapshot } from '../../../shared/electron-api'
import { comparablePath } from '../../../shared/host-paths'

/**
 * A repository's worktree pool as main last described it, kept current by the
 * `worktree-pool:changed` push. Null while the repository has no pool (nothing
 * has asked it for a worktree yet) or while the first read is in flight.
 */
export function useWorktreePool(repoRoot: string | null): {
  snapshot: WorktreePoolSnapshot | null
  reload: () => Promise<void>
} {
  const [snapshot, setSnapshot] = useState<WorktreePoolSnapshot | null>(null)
  // Main resolves the repository itself (a checkout opened from one of its own
  // worktrees still names the one pool), so a push is matched on the pool id
  // the first read returned, falling back to the path before that.
  const poolIdRef = useRef<string | null>(null)

  const reload = useCallback(async () => {
    if (!repoRoot || typeof window.api.getWorktreePoolSnapshot !== 'function') return
    const next = await window.api.getWorktreePoolSnapshot(repoRoot).catch(() => null)
    if (next) poolIdRef.current = next.poolId
    setSnapshot(next)
  }, [repoRoot])

  useEffect(() => {
    setSnapshot(null)
    poolIdRef.current = null
    if (!repoRoot) return
    void reload()
    if (typeof window.api.onWorktreePoolChanged !== 'function') return
    const key = comparablePath(repoRoot)
    return window.api.onWorktreePoolChanged((next) => {
      const ours = poolIdRef.current ? next.poolId === poolIdRef.current : comparablePath(next.repoRoot) === key
      if (!ours) return
      poolIdRef.current = next.poolId
      setSnapshot(next)
    })
  }, [reload, repoRoot])

  return { snapshot, reload }
}
