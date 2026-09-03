import { useEffect, useRef, useState } from 'react'

import type { GitRowSummary } from '../../../../shared/electron-api'

// Per-workspace git facts for the sidebar's two-line rows (remote-sessions-ux /
// two-line-session-rows): branch + working-tree ±lines, keyed by workspace id.
//
// Deliberately a slow, visible-only poll rather than a watcher fleet: the
// summary is two git subprocesses per workspace, so it refreshes on mount, on
// the window becoming visible, and on a one-minute tick — never while the
// document is hidden, and workspaces are fetched a few at a time so a sidebar
// of thirty repos is a trickle, not a storm. A row missing its summary simply
// shows no git facts; nothing here ever throws into the tree.

const REFRESH_MS = 60_000
const CONCURRENCY = 4

type SummaryInput = { id: string; folderPath: string | null }

export function useSidebarGitSummaries(
  workspaces: ReadonlyArray<SummaryInput>
): Record<string, GitRowSummary> {
  const [summaries, setSummaries] = useState<Record<string, GitRowSummary>>({})
  // The identity the poll keys on: which (id, folder) pairs exist. A string so
  // the effect only re-runs when membership actually changes, not per render.
  const membership = workspaces
    .filter((workspace) => workspace.folderPath)
    .map((workspace) => `${workspace.id} ${workspace.folderPath}`)
    .sort()
    .join('\n')
  const membershipRef = useRef(membership)
  membershipRef.current = membership

  useEffect(() => {
    let cancelled = false
    const entries = membership
      .split('\n')
      .filter(Boolean)
      .map((row) => {
        // Split on the FIRST space only: ids never contain one, paths may.
        const separator = row.indexOf(' ')
        return { id: row.slice(0, separator), folderPath: row.slice(separator + 1) }
      })

    async function sweep(): Promise<void> {
      if (cancelled || document.hidden) return
      const queue = [...entries]
      const next: Record<string, GitRowSummary> = {}
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
          for (;;) {
            const entry = queue.shift()
            if (!entry || cancelled) return
            try {
              next[entry.id] = await window.api.getGitRowSummary(entry.folderPath)
            } catch {
              // Quiet: the row shows no git facts for this workspace.
            }
          }
        })
      )
      if (cancelled || membershipRef.current !== membership) return
      setSummaries(next)
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
