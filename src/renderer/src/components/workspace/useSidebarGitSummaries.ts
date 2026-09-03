import { useEffect, useRef, useState } from 'react'

import type { GitRowSummary } from '../../../../shared/electron-api'

// Per-workspace git facts for the sidebar's two-line rows (remote-sessions-ux /
// two-line-session-rows): branch + working-tree ±lines, keyed by workspace id.
//
// Deliberately a slow, visible-only poll rather than a watcher fleet, shaped
// by its adversarial review:
// - fetches are deduped by FOLDER, then fanned out to ids — ten chats on one
//   repo are one summary, not ten;
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

function summariesEqual(a: Record<string, GitRowSummary>, b: Record<string, GitRowSummary>): boolean {
  const aKeys = Object.keys(a)
  if (aKeys.length !== Object.keys(b).length) return false
  for (const key of aKeys) {
    const left = a[key]
    const right = b[key]
    if (!right) return false
    if (left.branch !== right.branch || left.additions !== right.additions || left.deletions !== right.deletions) {
      return false
    }
  }
  return true
}

export function useSidebarGitSummaries(
  workspaces: ReadonlyArray<SummaryInput>
): Record<string, GitRowSummary> {
  const [summaries, setSummaries] = useState<Record<string, GitRowSummary>>({})
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
    const entries = membership
      .split('\u0000')
      .filter(Boolean)
      .map((row) => {
        // First space only: ids never contain one, paths may.
        const separator = row.indexOf(' ')
        return { id: row.slice(0, separator), folderPath: row.slice(separator + 1) }
      })
    const idsByFolder = new Map<string, string[]>()
    for (const entry of entries) {
      const ids = idsByFolder.get(entry.folderPath)
      if (ids) ids.push(entry.id)
      else idsByFolder.set(entry.folderPath, [entry.id])
    }

    async function sweep(): Promise<void> {
      if (cancelled || inFlight || document.hidden) return
      inFlight = true
      try {
        const queue = [...idsByFolder.keys()]
        const byFolder = new Map<string, GitRowSummary>()
        await Promise.all(
          Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
            for (;;) {
              const folderPath = queue.shift()
              if (!folderPath || cancelled) return
              try {
                byFolder.set(folderPath, await window.api.getGitRowSummary(folderPath))
              } catch {
                // Quiet: the previously known facts for this folder stand.
              }
            }
          })
        )
        if (cancelled || membershipRef.current !== membership) return
        setSummaries((previous) => {
          const next: Record<string, GitRowSummary> = {}
          for (const [folderPath, ids] of idsByFolder) {
            const summary = byFolder.get(folderPath)
            for (const id of ids) {
              const value = summary ?? previous[id]
              if (value) next[id] = value
            }
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
