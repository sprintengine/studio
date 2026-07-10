import { useEffect, useState } from 'react'
import type { SprintEngineTokenUsageReport } from '../../../shared/sprintengine-token-usage'

// Shared fetch of the run's token-usage report (computed main-side from the
// durable token ledger + projection; the main process caches, so refetching on
// every projection tick stays cheap). One implementation for every panel so
// the reset semantics cannot diverge:
//
// - The report is cleared the moment `statePath` changes. Task ids are generic
//   per run (T0, T1, ...), so a previous run's report consulted against a new
//   run's task id would render another run's figure as a confident value.
// - A response for a superseded statePath/unmounted panel is dropped.
// - An unchanged report (same computedAt) does not re-render consumers.
// - A failed read yields null — the panels render nothing, never a zero.
export function useSprintEngineTokenUsage(
  statePath: string | null,
  stateUpdatedAt: number | string | null | undefined,
  enabled = true,
): SprintEngineTokenUsageReport | null {
  const [report, setReport] = useState<SprintEngineTokenUsageReport | null>(null)

  useEffect(() => {
    // Run-identity reset: never let one run's figures be read against another
    // run's task ids, even for the frames until the first fetch resolves.
    setReport(null)
  }, [statePath])

  useEffect(() => {
    if (!statePath || !enabled) return
    let cancelled = false
    window.api
      .readSprintEngineTokenUsage(statePath)
      .then((usage) => {
        if (cancelled) return
        setReport((previous) =>
          previous && previous.computedAt === usage.computedAt ? previous : usage,
        )
      })
      .catch(() => {
        if (!cancelled) setReport(null)
      })
    return () => {
      cancelled = true
    }
  }, [statePath, enabled, stateUpdatedAt])

  return report
}
