import { useEffect, useRef, useState } from 'react'

import { resolveWorkspaceWorktree } from '../../utils/workspaceWorktree'
import type { WorkspaceChangeSummary } from '../../../../shared/electron-api'
import type { Workspace } from '../../types/workspace'

// Per-workspace git facts for the sidebar's two-line rows (remote-sessions-ux /
// two-line-session-rows): branch + working-tree ±lines, keyed by workspace id.
//
// Deliberately a slow, visible-only poll rather than a watcher fleet, shaped
// by its adversarial review:
// - fetches are keyed by CHECKOUT — the workspace's worktree when it has one,
//   its folder otherwise — because that is what the answer depends on. Two
//   chats sharing a checkout genuinely have the same branch reading, so main
//   shares ONE read between them (`createCheckoutSpanShare`,
//   workspace-change-summary.ts) and entries are swept checkout by checkout so
//   those rows land inside the share's hold window. This is the dedupe the
//   checkpoint model had to remove and the branch model makes correct again
//   (epic decision 7); the bug it once caused — ten rows on `multicode` all
//   reading `+246 −94` — cannot return, because rows on DIFFERENT checkouts
//   never share and a shared checkout genuinely is one answer;
// - one sweep at a time: a sweep hung on a spun-down volume delays the next
//   tick instead of stacking subprocesses under it;
// - results MERGE over what is known (ids no longer present are pruned), so
//   one failed read never collapses a row that was showing facts;
// - an unchanged sweep commits nothing, so the sidebar does not re-render
//   for a no-op minute.
// A row missing its summary simply shows no git facts; nothing here throws.

const REFRESH_MS = 60_000
const CONCURRENCY = 4

/**
 * What the poll needs off a workspace: its id, and enough of it to resolve the
 * checkout its agents work in. Callers pass whole `Workspace` records.
 */
type SummaryInput = Pick<Workspace, 'id' | 'folderPath' | 'worktree' | 'sprintEngineState'>

/**
 * The checkout a workspace's row reports on: its worktree when it has one, its
 * folder otherwise — the same resolution the branch chip and the Git view use,
 * so all three name one tree. Null for a folderless workspace, which has no row
 * facts to fetch.
 */
export function checkoutPathFor(workspace: SummaryInput): string | null {
  if (!workspace.folderPath) return null
  return resolveWorkspaceWorktree(workspace)?.gitRoot ?? workspace.folderPath
}

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
 * one, paths may) and ordered checkout-contiguously, so the rows sharing a
 * checkout ask within one hold window and get one read between them
 * (`createCheckoutSpanShare`, main). Ids keep their order within a checkout so
 * a sweep is deterministic.
 */
export function sweepEntriesFrom(membership: string): Array<{ id: string; checkoutPath: string }> {
  return membership
    .split('\u0000')
    .filter(Boolean)
    .map((row) => {
      const separator = row.indexOf(' ')
      return { id: row.slice(0, separator), checkoutPath: row.slice(separator + 1) }
    })
    .sort((a, b) =>
      a.checkoutPath < b.checkoutPath
        ? -1
        : a.checkoutPath > b.checkoutPath
          ? 1
          : a.id < b.id
            ? -1
            : a.id > b.id
              ? 1
              : 0
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
    .map((workspace) => ({ id: workspace.id, checkoutPath: checkoutPathFor(workspace) }))
    .filter((entry): entry is { id: string; checkoutPath: string } => entry.checkoutPath !== null)
    .map((entry) => `${entry.id} ${entry.checkoutPath}`)
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
                  await window.api.getWorkspaceChangeSummary(entry.checkoutPath)
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
