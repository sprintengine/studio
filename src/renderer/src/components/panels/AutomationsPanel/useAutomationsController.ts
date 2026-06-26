import { useCallback, useEffect, useState } from 'react'

import type {
  AutomationDefinition,
  AutomationRun,
  AutomationStatus,
  AutomationsEngineStatus,
  AutomationsProviders,
} from '../../../../../shared/automations/contracts'
import { mergeFeedRuns, type AsyncState, type AutomationFeedRun } from './automationsFormat'

// A rejected IPC invoke (channel error, thrown handler) never returns an
// `{ ok: false }` result, so without this the loading/busy state would hang.
// Turn any throw into a readable message.
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The automations service did not respond.'
}

export type AutomationsController = {
  definitions: AutomationDefinition[]
  providers: AutomationsProviders | null
  /** Read-only engine/scheduler health from T5's engine-status channel. */
  engineStatus: AutomationsEngineStatus | null
  loadState: AsyncState
  loadError: string | null
  actionError: string | null
  busyId: string | null
  load: () => Promise<void>
  clearActionError: () => void
  /** Resolves with the terminal run on success (for notify/deep-link), null otherwise. */
  runNow: (def: AutomationDefinition) => Promise<AutomationRun | null>
  toggleStatus: (def: AutomationDefinition) => Promise<void>
  remove: (def: AutomationDefinition) => Promise<void>
  applySaved: (saved: AutomationDefinition) => void
  // Cross-definition runs feed (aggregated client-side from per-definition runs).
  feedRuns: AutomationFeedRun[]
  feedState: AsyncState
  feedError: string | null
  /** Number of definitions whose runs could not be loaded into the feed. */
  feedPartialCount: number
  loadRunsFeed: () => Promise<void>
  finalizeFeedRun: (automationId: string, runId: string, outcome: 'completed' | 'failed') => Promise<void>
}

// Owns the control center's data layer: the list + providers load and every
// mutation. All reads/writes go through the `window.api` automations bridge —
// the renderer never touches the on-disk store.
export function useAutomationsController(input: { folderPath: string | null; workspaceId: string }): AutomationsController {
  const { folderPath, workspaceId } = input
  const [definitions, setDefinitions] = useState<AutomationDefinition[]>([])
  const [providers, setProviders] = useState<AutomationsProviders | null>(null)
  const [engineStatus, setEngineStatus] = useState<AutomationsEngineStatus | null>(null)
  const [loadState, setLoadState] = useState<AsyncState>('idle')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [feedRuns, setFeedRuns] = useState<AutomationFeedRun[]>([])
  const [feedState, setFeedState] = useState<AsyncState>('idle')
  const [feedError, setFeedError] = useState<string | null>(null)
  const [feedPartialCount, setFeedPartialCount] = useState(0)

  const load = useCallback(async () => {
    if (!folderPath) {
      setLoadState('error')
      setLoadError('This workspace has no folder, so its automations store is unavailable.')
      return
    }
    setLoadState('loading')
    setLoadError(null)
    try {
      const [list, provs, engine] = await Promise.all([
        window.api.listAutomations({ workspaceRoot: folderPath }),
        window.api.listAutomationProviders(),
        window.api.getAutomationsEngineStatus(),
      ])
      if (!list.ok) {
        setLoadState('error')
        setLoadError(list.message)
        return
      }
      if (!provs.ok) {
        setLoadState('error')
        setLoadError(provs.message)
        return
      }
      setDefinitions(list.value)
      setProviders(provs.value)
      // Engine status is supplementary — a failure here surfaces as an "unknown"
      // health indicator, it must not block the list/editor from loading.
      setEngineStatus(engine.ok ? engine.value : null)
      setLoadState('ready')
    } catch (error) {
      setLoadState('error')
      setLoadError(errorMessage(error))
    }
  }, [folderPath])

  useEffect(() => {
    void load()
  }, [load])

  // Shared mutation runner: single-flights on the row, surfaces both handled
  // ({ ok: false }) and thrown IPC failures, and always clears the busy state so
  // a rejected invoke never leaves the row spinning.
  const mutate = useCallback(async (
    def: AutomationDefinition,
    run: () => Promise<{ ok: true } | { ok: false; message: string }>,
  ) => {
    if (!folderPath) return
    setActionError(null)
    setBusyId(def.id)
    try {
      const result = await run()
      if (!result.ok) setActionError(result.message)
    } catch (error) {
      setActionError(errorMessage(error))
    } finally {
      setBusyId(null)
    }
  }, [folderPath])

  const runNow = useCallback(async (def: AutomationDefinition) => {
    let finishedRun: AutomationRun | null = null
    await mutate(def, async () => {
      const result = await window.api.runAutomationNow({ workspaceRoot: folderPath!, workspaceId, automationId: def.id })
      if (result.ok) {
        finishedRun = result.value.run
        setDefinitions((prev) => prev.map((d) => (d.id === result.value.definition.id ? result.value.definition : d)))
      }
      return result
    })
    return finishedRun
  }, [folderPath, mutate, workspaceId])

  const toggleStatus = useCallback((def: AutomationDefinition) => mutate(def, async () => {
    const nextStatus: AutomationStatus = def.status === 'enabled' ? 'paused' : 'enabled'
    const result = await window.api.updateAutomation({ workspaceRoot: folderPath!, automationId: def.id, patch: { status: nextStatus } })
    if (result.ok) setDefinitions((prev) => prev.map((d) => (d.id === result.value.id ? result.value : d)))
    return result
  }), [folderPath, mutate])

  const remove = useCallback((def: AutomationDefinition) => mutate(def, async () => {
    const result = await window.api.deleteAutomation({ workspaceRoot: folderPath!, automationId: def.id })
    if (result.ok) setDefinitions((prev) => prev.filter((d) => d.id !== def.id))
    return result
  }), [folderPath, mutate])

  const applySaved = useCallback((saved: AutomationDefinition) => {
    setDefinitions((prev) => {
      const exists = prev.some((d) => d.id === saved.id)
      return exists ? prev.map((d) => (d.id === saved.id ? saved : d)) : [...prev, saved]
    })
  }, [])

  const clearActionError = useCallback(() => setActionError(null), [])

  // Build the cross-definition feed by aggregating per-definition run lists (no
  // new list-all IPC). A definition whose runs fail to load is skipped and
  // counted rather than failing the whole feed — the count is surfaced so the
  // gap is explicit, not silent.
  const loadRunsFeed = useCallback(async () => {
    if (!folderPath) return
    setFeedState('loading')
    setFeedError(null)
    try {
      let partial = 0
      const perDefinition = await Promise.all(definitions.map(async (def): Promise<AutomationFeedRun[]> => {
        try {
          const result = await window.api.listAutomationRuns({ workspaceRoot: folderPath, automationId: def.id })
          if (!result.ok) { partial += 1; return [] }
          return result.value.map((run) => ({
            run, definitionId: def.id, definitionName: def.name, triggerKind: def.trigger.kind,
          }))
        } catch {
          partial += 1
          return []
        }
      }))
      setFeedRuns(mergeFeedRuns(perDefinition))
      setFeedPartialCount(partial)
      setFeedState('ready')
    } catch (error) {
      setFeedState('error')
      setFeedError(errorMessage(error))
    }
  }, [folderPath, definitions])

  const finalizeFeedRun = useCallback(async (automationId: string, runId: string, outcome: 'completed' | 'failed') => {
    if (!folderPath) return
    setActionError(null)
    try {
      const result = await window.api.finalizeAutomationRun({ workspaceRoot: folderPath, automationId, runId, outcome })
      if (!result.ok) { setActionError(result.message); return }
    } catch (error) {
      setActionError(errorMessage(error))
      return
    }
    // Refresh the feed and the definitions (a finalized run updates lastRun*).
    await Promise.all([loadRunsFeed(), load()])
  }, [folderPath, loadRunsFeed, load])

  return {
    definitions,
    providers,
    engineStatus,
    loadState,
    loadError,
    actionError,
    busyId,
    load,
    clearActionError,
    runNow,
    toggleStatus,
    remove,
    applySaved,
    feedRuns,
    feedState,
    feedError,
    feedPartialCount,
    loadRunsFeed,
    finalizeFeedRun,
  }
}
