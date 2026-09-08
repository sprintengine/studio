import { useCallback, useEffect, useState } from 'react'

import type { AutomationDefinition, AutomationRun } from '../../../../../shared/automations/contracts'
import { parseTime, type AsyncState } from './automationsFormat'

// One automation's run timeline, loaded through the `window.api` automations
// bridge and reloaded whenever its `lastRunId` changes (e.g. after a run-now).
// Shared by the workspace-hosted detail pane and the full-page surface canvas
// (global-surfaces epic 1704) so both read run history — and finalize an
// in-progress run — the same way, scoped to whichever store root they pass.
export type AutomationRunHistory = {
  runs: AutomationRun[]
  state: AsyncState
  error: string | null
  finalizingRunId: string | null
  reload: () => Promise<void>
  /**
   * Finalize an in-progress agent-backed run: records the terminal outcome and
   * (for `completed`) backstop-commits + opens/links a PR for the run's branch.
   */
  finalize: (run: AutomationRun, outcome: 'completed' | 'failed') => Promise<void>
}

export function useAutomationRunHistory(
  workspaceRoot: string,
  definition: Pick<AutomationDefinition, 'id' | 'lastRunId'>,
): AutomationRunHistory {
  const { id: automationId, lastRunId } = definition
  const [runs, setRuns] = useState<AutomationRun[]>([])
  const [state, setState] = useState<AsyncState>('idle')
  const [error, setError] = useState<string | null>(null)
  const [finalizingRunId, setFinalizingRunId] = useState<string | null>(null)

  const reload = useCallback(async () => {
    if (!workspaceRoot) return
    setState('loading')
    setError(null)
    try {
      const result = await window.api.listAutomationRuns({ workspaceRoot, automationId })
      if (!result.ok) {
        setState('error')
        setError(result.message)
        return
      }
      // Newest first for the timeline.
      setRuns([...result.value].sort((a, b) => (parseTime(b.dueAt) ?? 0) - (parseTime(a.dueAt) ?? 0)))
      setState('ready')
    } catch (err) {
      setState('error')
      setError(err instanceof Error ? err.message : 'The automations service did not respond.')
    }
    // lastRunId in the dep list: a run-now bumps it, so the history reloads.
  }, [workspaceRoot, automationId, lastRunId])

  useEffect(() => { void reload() }, [reload])

  const finalize = useCallback(async (run: AutomationRun, outcome: 'completed' | 'failed') => {
    if (!workspaceRoot) return
    setFinalizingRunId(run.id)
    setError(null)
    try {
      const result = await window.api.finalizeAutomationRun({ workspaceRoot, automationId, runId: run.id, outcome })
      if (!result.ok) setError(result.message)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The automations service did not respond.')
    } finally {
      setFinalizingRunId(null)
      await reload()
    }
  }, [workspaceRoot, automationId, reload])

  return { runs, state, error, finalizingRunId, reload, finalize }
}
