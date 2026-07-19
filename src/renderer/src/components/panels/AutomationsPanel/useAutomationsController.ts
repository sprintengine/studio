import { useCallback, useEffect, useRef, useState } from 'react'

import type {
  AutomationDefinition,
  AutomationRun,
  AutomationStatus,
  AutomationsEngineStatus,
  AutomationsInstanceEntry,
  AutomationsInstanceProblem,
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

// Two scopes share this data layer (global-surfaces epic 1704 / item 1707):
// - folder: one host's `.multi-code/automations/` store, keyed by `folderPath`
//   (the workspace-hosted control-center panel). Every read/write targets that
//   single root; `workspaceId` scopes a run-now launch to the host workspace.
// - instance: every automation across every known project root, loaded through
//   the `listInstanceAutomations` index. Each definition carries its own store
//   root (from its instance entry), so mutations resolve the root per definition
//   rather than from one panel-wide folder. There is no single backing
//   workspace, so run-now omits `workspaceId` and the executor spins up its own.
export type AutomationsControllerInput =
  | { scope?: 'folder'; folderPath: string | null; workspaceId?: string | null }
  | { scope: 'instance' }

export type AutomationsController = {
  definitions: AutomationDefinition[]
  /**
   * Instance-scope only: each automation with its store root and live run state
   * (lastRun / isRunningNow) for the rail. Empty in folder scope.
   */
  entries: AutomationsInstanceEntry[]
  /**
   * Instance-scope only: project roots whose store could not be read, surfaced
   * rather than dropped so one bad store never masks the readable automations.
   */
  problems: AutomationsInstanceProblem[]
  /**
   * The store root a definition's reads/writes target (its instance entry's root
   * in instance scope; the single folder in folder scope). Null when unknown —
   * the surface passes it to the detail/editor/report panels, which are
   * root-scoped.
   */
  rootForDefinition: (automationId: string) => string | null
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
  /**
   * Fold a created/edited definition into the list. Pass `workspaceRoot` for a
   * brand-new instance-scope automation so its entry (and root mapping) exist
   * without a full reload; edits keep their existing root.
   */
  applySaved: (saved: AutomationDefinition, workspaceRoot?: string) => void
  // Cross-definition runs feed (aggregated client-side from per-definition runs).
  // Folder scope only; inert in instance scope (the surface loads per-automation
  // runs in its canvas instead).
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
export function useAutomationsController(input: AutomationsControllerInput): AutomationsController {
  const isInstance = input.scope === 'instance'
  const folderPath = isInstance ? null : input.folderPath
  const workspaceId = isInstance ? null : (input.workspaceId ?? null)

  const [definitions, setDefinitions] = useState<AutomationDefinition[]>([])
  const [entries, setEntries] = useState<AutomationsInstanceEntry[]>([])
  const [problems, setProblems] = useState<AutomationsInstanceProblem[]>([])
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

  // definition id → store root, for per-definition mutation targeting in
  // instance scope. A ref so mutation callbacks read the current mapping without
  // depending on (and rebuilding with) the entries array.
  const rootByDefIdRef = useRef<Map<string, string>>(new Map())

  const rootForDefinition = useCallback((automationId: string): string | null => {
    if (isInstance) return rootByDefIdRef.current.get(automationId) ?? null
    return folderPath
  }, [isInstance, folderPath])

  const load = useCallback(async () => {
    if (isInstance) {
      setLoadState('loading')
      setLoadError(null)
      try {
        const [index, provs, engine] = await Promise.all([
          window.api.listInstanceAutomations(),
          window.api.listAutomationProviders(),
          window.api.getAutomationsEngineStatus(),
        ])
        if (!index.ok) {
          setLoadState('error')
          setLoadError(index.message)
          return
        }
        if (!provs.ok) {
          setLoadState('error')
          setLoadError(provs.message)
          return
        }
        setEntries(index.value.entries)
        setProblems(index.value.problems)
        setDefinitions(index.value.entries.map((entry) => entry.definition))
        rootByDefIdRef.current = new Map(
          index.value.entries.map((entry) => [entry.definition.id, entry.workspaceRoot]),
        )
        setProviders(provs.value)
        setEngineStatus(engine.ok ? engine.value : null)
        setLoadState('ready')
      } catch (error) {
        setLoadState('error')
        setLoadError(errorMessage(error))
      }
      return
    }

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
  }, [isInstance, folderPath])

  useEffect(() => {
    void load()
  }, [load])

  // Definition writes can originate outside this panel — a module's entry.main
  // through the scoped Automations service, another window, or another project's
  // store — so reload when the main process announces a change. Folder scope
  // filters to this store's root; instance scope reloads on any root's change.
  useEffect(() => {
    if (typeof window.api.onAutomationsDefinitionsChanged !== 'function') return
    if (isInstance) {
      return window.api.onAutomationsDefinitionsChanged(() => {
        void load()
      })
    }
    if (!folderPath) return
    return window.api.onAutomationsDefinitionsChanged((event) => {
      if (normalizeRootPath(event.workspaceRoot) !== normalizeRootPath(folderPath)) return
      void load()
    })
  }, [isInstance, folderPath, load])

  // Replace a definition in both the list and (instance scope) its entry, so the
  // rail's state line and the root mapping stay in sync after a mutation.
  const replaceDefinition = useCallback((updated: AutomationDefinition) => {
    setDefinitions((prev) => prev.map((d) => (d.id === updated.id ? updated : d)))
    if (isInstance) {
      setEntries((prev) => prev.map((entry) => (entry.definition.id === updated.id ? { ...entry, definition: updated } : entry)))
    }
  }, [isInstance])

  const dropDefinition = useCallback((automationId: string) => {
    setDefinitions((prev) => prev.filter((d) => d.id !== automationId))
    if (isInstance) {
      setEntries((prev) => prev.filter((entry) => entry.definition.id !== automationId))
      rootByDefIdRef.current.delete(automationId)
    }
  }, [isInstance])

  // Shared mutation runner: single-flights on the row, surfaces both handled
  // ({ ok: false }) and thrown IPC failures, and always clears the busy state so
  // a rejected invoke never leaves the row spinning. The caller resolves the
  // store root and bails before calling this when the root is unknown.
  const mutate = useCallback(async (
    def: AutomationDefinition,
    run: () => Promise<{ ok: true } | { ok: false; message: string }>,
  ) => {
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
  }, [])

  const runNow = useCallback(async (def: AutomationDefinition) => {
    const root = rootForDefinition(def.id)
    if (!root) return null
    let finishedRun: AutomationRun | null = null
    await mutate(def, async () => {
      // workspaceId scopes the launch target to the host control center when
      // present (workspace-hosted panel). The global Automations surface has no
      // backing workspace, so it omits it — the executor then spins up a fresh
      // standard workspace to host the launched agent.
      const result = await window.api.runAutomationNow({
        workspaceRoot: root,
        ...(workspaceId ? { workspaceId } : {}),
        automationId: def.id,
      })
      if (result.ok) {
        finishedRun = result.value.run
        replaceDefinition(result.value.definition)
      }
      return result
    })
    return finishedRun
  }, [rootForDefinition, mutate, workspaceId, replaceDefinition])

  const toggleStatus = useCallback((def: AutomationDefinition) => {
    const root = rootForDefinition(def.id)
    if (!root) return Promise.resolve()
    return mutate(def, async () => {
      const nextStatus: AutomationStatus = def.status === 'enabled' ? 'paused' : 'enabled'
      const result = await window.api.updateAutomation({ workspaceRoot: root, automationId: def.id, patch: { status: nextStatus } })
      if (result.ok) replaceDefinition(result.value)
      return result
    })
  }, [rootForDefinition, mutate, replaceDefinition])

  const remove = useCallback((def: AutomationDefinition) => {
    const root = rootForDefinition(def.id)
    if (!root) return Promise.resolve()
    return mutate(def, async () => {
      const result = await window.api.deleteAutomation({ workspaceRoot: root, automationId: def.id })
      if (result.ok) dropDefinition(def.id)
      return result
    })
  }, [rootForDefinition, mutate, dropDefinition])

  const applySaved = useCallback((saved: AutomationDefinition, workspaceRoot?: string) => {
    setDefinitions((prev) => {
      const exists = prev.some((d) => d.id === saved.id)
      return exists ? prev.map((d) => (d.id === saved.id ? saved : d)) : [...prev, saved]
    })
    if (isInstance) {
      if (workspaceRoot) rootByDefIdRef.current.set(saved.id, workspaceRoot)
      const root = rootByDefIdRef.current.get(saved.id) ?? workspaceRoot ?? ''
      setEntries((prev) => {
        const existing = prev.find((entry) => entry.definition.id === saved.id)
        if (existing) {
          return prev.map((entry) => (entry.definition.id === saved.id ? { ...entry, definition: saved } : entry))
        }
        // A brand-new automation: seed an entry so the rail lists it immediately
        // with no run history yet. Its live run state fills in on the next index
        // load (a definitions-changed broadcast follows the create).
        return [...prev, { workspaceRoot: root, workspaceId: '', definition: saved, lastRun: null, isRunningNow: false }]
      })
    }
  }, [isInstance])

  const clearActionError = useCallback(() => setActionError(null), [])

  // Build the cross-definition feed by aggregating per-definition run lists (no
  // new list-all IPC). A definition whose runs fail to load — handled failure,
  // thrown rejection, or a hung call that never settles — is skipped and counted
  // rather than failing or stranding the whole feed; the count is surfaced so the
  // gap is explicit, not silent. Folder scope only (the global surface reads
  // per-automation runs in its canvas), so it early-returns without a folder.
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
    entries,
    problems,
    rootForDefinition,
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
