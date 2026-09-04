import { useEffect, useState } from 'react'

import type { GitStatusSnapshot } from '../../../shared/electron-api'

/**
 * The working tree's ±lines for a repo, for the chrome's git button
 * (the-diff-an-agent-made / git-button-shows-lines).
 *
 * Backed by `getGitRowSummary` — the same read the sidebar row uses — so the
 * two places the chrome shows a diff size agree by construction rather than by
 * coincidence. `useGitStatus` cannot supply this: it carries porcelain FILE
 * status, which has paths and states but no line counts, and that is precisely
 * why the badge used to count files.
 *
 * It refetches on the status snapshot rather than on a timer. The git watcher
 * already knows when the tree moved, so a poll would only add a second answer
 * that could disagree with the first — and a per-second badge is not worth a
 * subprocess.
 *
 * Returns zeros for everything unreadable: no repo, no bridge, a failed read.
 * A button that shows nothing is correct; one that throws is not.
 */
export type GitLineCounts = { additions: number; deletions: number }

const NONE: GitLineCounts = { additions: 0, deletions: 0 }

export function useGitLineCounts(
  repoRoot: string | null,
  status: GitStatusSnapshot | null
): GitLineCounts {
  const [counts, setCounts] = useState<GitLineCounts>(NONE)

  // The snapshot's own identity is the signal: `useGitStatus` publishes a new
  // object each time the watcher reports, so this re-runs exactly when the tree
  // has moved and not on every parent render.
  useEffect(() => {
    let cancelled = false
    if (!repoRoot || typeof window.api?.getGitRowSummary !== 'function') {
      setCounts(NONE)
      return
    }
    void (async () => {
      try {
        const summary = await window.api.getGitRowSummary(repoRoot)
        if (cancelled) return
        setCounts({ additions: summary.additions, deletions: summary.deletions })
      } catch {
        // Quiet: the button simply shows no numbers.
        if (!cancelled) setCounts(NONE)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [repoRoot, status])

  return counts
}

/**
 * Which badge the git button draws.
 *
 * `lines` is the answer we want; `files` survives as a fallback for one real
 * case rather than as legacy. A tree whose only changes are untracked files has
 * changes but no ±lines — `git diff` cannot see content it has never tracked —
 * and going blank the moment someone creates a file would read as "nothing
 * changed". So the file count holds that case, and only that case.
 */
export function gitBadgeMode(input: {
  hasChanges: boolean
  additions: number
  deletions: number
}): 'lines' | 'files' | 'none' {
  if (!input.hasChanges) return 'none'
  if (input.additions > 0 || input.deletions > 0) return 'lines'
  return 'files'
}
