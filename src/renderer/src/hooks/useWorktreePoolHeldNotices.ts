import { useEffect } from 'react'

import { publishDiagnosticSync } from '../utils/diagnostics'

/** A hold older than this, first seen in a push about something else, is old news. */
const FRESH_HOLD_MS = 60_000

/**
 * Says so, once, when a pooled worktree is held: an agent's worktree came back
 * with work in it, and the pool will not touch it until a person picks Commit,
 * Stash, Discard or Keep in the Worktree manager. Owned by the primary window
 * alone, so one hold is one notice.
 */
export function useWorktreePoolHeldNotices(enabled: boolean): void {
  useEffect(() => {
    if (!enabled || typeof window.api?.onWorktreePoolChanged !== 'function') return
    const announced = new Map<string, number>()
    return window.api.onWorktreePoolChanged((snapshot) => {
      for (const slot of snapshot.slots) {
        const key = `${snapshot.poolId}:${slot.id}`
        if (slot.state !== 'held' || !slot.held) {
          announced.delete(key)
          continue
        }
        if (announced.get(key) === slot.held.since) continue
        announced.set(key, slot.held.since)
        if (Date.now() - slot.held.since > FRESH_HOLD_MS) continue
        const what =
          slot.held.reason === 'dirty'
            ? `${slot.held.changedPaths ?? 'some'} uncommitted change${slot.held.changedPaths === 1 ? '' : 's'}`
            : (slot.held.detail ?? slot.held.reason)
        publishDiagnosticSync({
          level: 'warning',
          source: 'workspace',
          title: 'A worktree was held with work in it',
          message: `${slot.id}${slot.held.branch ? ` (${slot.held.branch})` : ''} in ${snapshot.repoRoot}: ${what}. Nothing was reset. Open the Worktree manager to commit, stash, discard or keep it.`,
        })
      }
    })
  }, [enabled])
}
