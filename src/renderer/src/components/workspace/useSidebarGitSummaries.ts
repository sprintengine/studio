import { useEffect, useRef, useState } from 'react'

import type { WorkspaceChangeSummary } from '../../../../shared/electron-api'

// Per-workspace git facts for the sidebar's two-line rows (remote-sessions-ux /
// two-line-session-rows): branch + working-tree ±lines, keyed by workspace id.
//
// Deliberately a slow, visible-only poll rather than a watcher fleet, shaped
// by its adversarial review:
// - fetches are per WORKSPACE. The old renderer-side folder dedupe ("ten
//   chats on one repo are one summary") was correct only because every chat
//   in a repo got the same answer — which is exactly the bug the owner caught,
//   ten rows on `multicode` all reading `+246 −94`. A checkpoint-scoped read
//   is a ref-to-ref diff rather than a worktree scan, so per-row stays cheap —
//   and the rows that DO fall back to the folder scan share ONE scan per
//   folder per sweep in main (`createFolderSummaryShare`,
//   workspace-change-summary.ts). Entries are swept folder by folder so a
//   folder's rows land inside that share's hold window;
// - one sweep at a time: a sweep hung on a spun-down volume delays the next
//   tick instead of stacking subprocesses under it;
// - results MERGE over what is known (ids no longer present are pruned), so
//   one failed read never collapses a row that was showing facts;
// - an unchanged sweep commits nothing, so the sidebar does not re-render
//   for a no-op minute.
// A row missing its summary simply shows no git facts; nothing here throws.

const REFRESH_MS = 60_000
const CONCURRENCY = 4

type SummaryInput = { id: string; folderPath: string | null }

function summariesEqual(a: Record<string, WorkspaceChangeSummary>, b: Record<string, WorkspaceChangeSummary>): boolean {
  const aKeys = Object.keys(a)
  if (aKeys.length !== Object.keys(b).length) return false
  for (const key of aKeys) {
    const left = a[key]
    const right = b[key]
    if (!right) return false
    // `scope` is compared like any other rendered field: a row flipping from the
    // folder reading to its own is a visible change even when the numbers match.
    if (
      left.branch !== right.branch
      || left.additions !== right.additions
      || left.deletions !== right.deletions
      || left.changedFiles !== right.changedFiles
      || left.scope !== right.scope
    ) {
      return false
    }
  }
  return true
}

/**
 * The rows one sweep asks main about, in the order it asks. Parsed back out
 * of the NUL-joined membership string (first space only: ids never contain
 * one, paths may) and ordered folder-contiguously, so the un-checkpointed rows
 * of one folder ask within one hold window and get one worktree scan between
 * them (`createFolderSummaryShare`, main). Ids keep their order within a
 * folder so a sweep is deterministic.
 */
export function sweepEntriesFrom(membership: string): Array<{ id: string; folderPath: string }> {
  return membership
    .split('\u0000')
    .filter(Boolean)
    .map((row) => {
      const separator = row.indexOf(' ')
      return { id: row.slice(0, separator), folderPath: row.slice(separator + 1) }
    })
    .sort((a, b) =>
      a.folderPath < b.folderPath ? -1 : a.folderPath > b.folderPath ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    )
}

export function useSidebarGitSummaries(
  workspaces: ReadonlyArray<SummaryInput>
): Record<string, WorkspaceChangeSummary> {
  const [summaries, setSummaries] = useState<Record<string, WorkspaceChangeSummary>>({})
  // The identity the poll keys on: which (id, folder) pairs exist. NUL-joined
  // — ids are nanoid and paths can contain anything BUT NUL — so the string
  // round-trips exactly and the effect re-runs only on membership change,
  // never per render.
  const membership = workspaces
    .filter((workspace) => workspace.folderPath)
    .map((workspace) => `${workspace.id} ${workspace.folderPath}`)
    .sort()
    .join('\u0000')
  const membershipRef = useRef(membership)
  membershipRef.current = membership

  useEffect(() => {
    let cancelled = false
    let inFlight = false
    const entries = sweepEntriesFrom(membership)
    async function sweep(): Promise<void> {
      if (cancelled || inFlight || document.hidden) return
      inFlight = true
      try {
        const queue = [...entries]
        const fetched = new Map<string, WorkspaceChangeSummary>()
        await Promise.all(
          Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
            for (;;) {
              const entry = queue.shift()
              if (!entry || cancelled) return
              try {
                fetched.set(
                  entry.id,
                  await window.api.getWorkspaceChangeSummary(entry.id, entry.folderPath)
                )
              } catch {
                // Quiet: the previously known facts for this row stand.
              }
            }
          })
        )
        if (cancelled || membershipRef.current !== membership) return
        setSummaries((previous) => {
          const next: Record<string, WorkspaceChangeSummary> = {}
          for (const entry of entries) {
            // Merge over what is known: one failed read must never collapse a
            // row that was showing facts a moment ago.
            const value = fetched.get(entry.id) ?? previous[entry.id]
            if (value) next[entry.id] = value
          }
          return summariesEqual(previous, next) ? previous : next
        })
      } finally {
        inFlight = false
      }
    }

    void sweep()
    const timer = window.setInterval(() => void sweep(), REFRESH_MS)
    const onVisible = (): void => {
      if (!document.hidden) void sweep()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [membership])

  return summaries
}
