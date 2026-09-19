import { useEffect, useRef, useState } from 'react'

import { resolveWorkspaceWorktree } from '../../utils/workspaceWorktree'
import type { WorkspaceChangeSummary } from '../../../../shared/electron-api'
import type { Workspace } from '../../types/workspace'

// Git facts for the sidebar's rows (remote-sessions-ux / two-line-session-rows):
// branch + working-tree ±lines, keyed by whatever the caller keys its entries
// on — a workspace id for a row, a checkout path for the per-terminal lines
// (sidebar-lists-every-terminal), where every line on one checkout reads one
// entry.
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
//   (epic decision 7); the bug it once caused — ten rows on `sprintengine` all
//   reading `+246 −94` — cannot return, because rows on DIFFERENT checkouts
//   never share and a shared checkout genuinely is one answer;
// - one sweep at a time: a sweep hung on a spun-down volume delays the next
//   tick instead of stacking subprocesses under it;
// - results MERGE over what is known (ids no longer present are pruned), so
//   one failed read never collapses a row that was showing facts;
// - an unchanged sweep commits nothing, so the sidebar does not re-render
//   for a no-op minute.
// A row missing its summary simply shows no git facts; nothing here throws.
//
// Owner ruling 2026-09-04 (the-diff-an-agent-made, decision 9): the caller
// passes only the rows that have an open terminal. A parked chat is not asked
// about at all — its branch and ±lines would be the checkout's present state,
// not anything the chat did, and after a restart every parked chat on one
// checkout read the same numbers. Membership is therefore a LIVENESS set as
// much as an identity set: a row whose last terminal exits leaves it and its
// facts are pruned on the sweep that follows; a row that gains one joins it and
// is swept at once, because the membership change re-runs the effect.

/**
 * Thirty seconds, down from sixty (owner, 2026-09-10): a branch that had just
 * been merged went on reading as unmerged for most of a minute, which is long
 * enough to go and look somewhere else to find out.
 *
 * This number and `CHECKOUT_SUMMARY_HOLD_MS` in `workspace-change-summary.ts`
 * are ONE decision and must move together. The hold has to stay under the
 * sweep, or every other sweep is answered from a cache the sweep was run to
 * refresh and the extra ticks buy nothing but wake-ups.
 */
const REFRESH_MS = 30_000
const CONCURRENCY = 4

/**
 * What resolving a workspace's checkout needs off it. Callers pass whole
 * `Workspace` records.
 */
type SummaryInput = Pick<Workspace, 'folderPath' | 'worktree' | 'moduleState'>

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
    //
    // `uncommitted` is compared too, and it is NOT decoration: a line whose
    // branch has landed draws those numbers and nothing else
    // (`lineDiffOf`/`landed`, terminalLines). A sweep that changed only the
    // uncommitted reading — the usual case on a squash-merged branch, whose
    // span sits still while the checkout keeps being edited — must commit, or
    // the line freezes on the reading it had when the pull request merged.
    if (
      left.branch !== right.branch ||
      left.additions !== right.additions ||
      left.deletions !== right.deletions ||
      left.changedFiles !== right.changedFiles ||
      left.scope !== right.scope ||
      left.uncommitted?.additions !== right.uncommitted?.additions ||
      left.uncommitted?.deletions !== right.uncommitted?.deletions ||
      left.uncommitted?.changedFiles !== right.uncommitted?.changedFiles ||
      // The FILE breakdown is what the line actually draws (owner decision
      // 2026-09-09), so it is a rendered field like any other: a sweep where a
      // file moved from added to updated changes the tooltip's words — and can
      // change the drawn numbers — with `changedFiles` sitting still.
      left.files?.added !== right.files?.added ||
      left.files?.updated !== right.files?.updated ||
      left.files?.removed !== right.files?.removed ||
      left.uncommitted?.files?.added !== right.uncommitted?.files?.added ||
      left.uncommitted?.files?.updated !== right.uncommitted?.files?.updated ||
      left.uncommitted?.files?.removed !== right.uncommitted?.files?.removed
    ) {
      return false
    }
  }
  return true
}

/**
 * One entry the poll reports on: the caller's key for it, and the checkout
 * whose facts it wants. A null checkout (a folderless workspace) is skipped.
 */
export type SummaryEntry = { id: string; checkoutPath: string | null }

/**
 * One row of the membership string. JSON, because an id may itself be a
 * checkout path (the per-terminal lines key on the checkout) and paths carry
 * spaces; the rows are NUL-joined, the one byte a path cannot contain.
 */
export function membershipRow(id: string, checkoutPath: string): string {
  return JSON.stringify([id, checkoutPath])
}

/**
 * The entries one sweep asks main about, in the order it asks. Parsed back
 * out of the NUL-joined membership string and ordered checkout-contiguously,
 * so the entries sharing a checkout ask within one hold window and get one
 * read between them (`createCheckoutSpanShare`, main). Ids keep their order
 * within a checkout so a sweep is deterministic.
 */
export function sweepEntriesFrom(membership: string): Array<{ id: string; checkoutPath: string }> {
  return membership
    .split('\u0000')
    .filter(Boolean)
    .map((row) => {
      const [id, checkoutPath] = JSON.parse(row) as [string, string]
      return { id, checkoutPath }
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
              : 0,
    )
}

export function useSidebarGitSummaries(entries: ReadonlyArray<SummaryEntry>): Record<string, WorkspaceChangeSummary> {
  const [summaries, setSummaries] = useState<Record<string, WorkspaceChangeSummary>>({})
  // The identity the poll keys on: which (id, checkout) pairs exist, as one
  // string, so the string round-trips exactly and the effect re-runs only on
  // membership change, never per render.
  const membership = entries
    .filter((entry): entry is { id: string; checkoutPath: string } => entry.checkoutPath !== null)
    .map((entry) => membershipRow(entry.id, entry.checkoutPath))
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
                fetched.set(entry.id, await window.api.getWorkspaceChangeSummary(entry.checkoutPath))
              } catch {
                // Quiet: the previously known facts for this row stand.
              }
            }
          }),
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
