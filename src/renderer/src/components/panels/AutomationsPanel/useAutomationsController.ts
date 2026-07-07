import { useCallback, useEffect, useState } from 'react'

import type {
  AutomationDefinition,
  AutomationRun,
  AutomationStatus,
  AutomationsEngineStatus,
  AutomationsProviders,
} from '../../../../../shared/automations/contracts'
import { aggregateFeedRuns, type AsyncState, type AutomationFeedRun } from './automationsFormat'

// Loose path identity for matching a broadcast's workspaceRoot against this
// panel's folderPath — both come from the workspace-sync snapshot, but guard
// against separator/case drift the same way the main process normalizes roots.
function normalizeRootPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/u, '').toLowerCase()
}

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
export function useAutomationsController(input: { folderPath: string | null; workspaceId?: string | null }): AutomationsController {
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

  // Definition writes can originate outside this panel — a module's entry.main
  // through the scoped Automations service, or another window — so reload when
  // the main process announces a change for this workspace's store.
  useEffect(() => {
    if (!folderPath || typeof window.api.onAutomationsDefinitionsChanged !== 'function') return
    const off = window.api.onAutomationsDefinitionsChanged((event) => {
      if (normalizeRootPath(event.workspaceRoot) !== normalizeRootPath(folderPath)) return
      void load()
    })
    return off
  }, [folderPath, load])

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
      // workspaceId scopes the launch target to the host control center when
      // present (workspace-hosted panel). The global Automations screen has no
      // backing workspace, so it omits it — the executor then spins up a fresh
      // standard workspace to host the launched agent.
      const result = await window.api.runAutomationNow({
        workspaceRoot: folderPath!,
        ...(workspaceId ? { workspaceId } : {}),
        automationId: def.id,
      })
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
  // new list-all IPC). A definition whose runs fail to load — handled failure,
  // thrown rejection, or a hung call that never settles — is skipped and counted
  // rather than failing or stranding the whole feed; the count is surfaced so the
  // gap is explicit, not silent. The settle-against-timeout/partial-count logic
  // lives in aggregateFeedRuns so it is unit-testable without the IPC bridge.
  const loadRunsFeed = useCallback(async () => {
    if (!folderPath) return
    setFeedState('loading')
    setFeedError(null)
    try {
      const { runs, partialCount } = await aggregateFeedRuns(
        definitions,
        (def) => window.api.listAutomationRuns({ workspaceRoot: folderPath, automationId: def.id }),
      )
      setFeedRuns(runs)
      setFeedPartialCount(partialCount)
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
    // Reload only the feed — calling the full load() would flip loadState to
    // 'loading' and flash the whole panel away. The definitions list's lastRun*
    // staying briefly stale matches the detail-pane finalize (it only reloads its
    // own runs too), and refreshes on the next list load.
    await loadRunsFeed()
  }, [folderPath, loadRunsFeed])

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
