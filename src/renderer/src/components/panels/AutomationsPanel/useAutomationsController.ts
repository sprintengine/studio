import { useCallback, useEffect, useState } from 'react'

import type {
  AutomationDefinition,
  AutomationStatus,
  AutomationsProviders,
} from '../../../../../shared/automations/contracts'
import type { AsyncState } from './automationsFormat'

// A rejected IPC invoke (channel error, thrown handler) never returns an
// `{ ok: false }` result, so without this the loading/busy state would hang.
// Turn any throw into a readable message.
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The automations service did not respond.'
}

export type AutomationsController = {
  definitions: AutomationDefinition[]
  providers: AutomationsProviders | null
  loadState: AsyncState
  loadError: string | null
  actionError: string | null
  busyId: string | null
  load: () => Promise<void>
  clearActionError: () => void
  runNow: (def: AutomationDefinition) => Promise<void>
  toggleStatus: (def: AutomationDefinition) => Promise<void>
  remove: (def: AutomationDefinition) => Promise<void>
  applySaved: (saved: AutomationDefinition) => void
}

// Owns the control center's data layer: the list + providers load and every
// mutation. All reads/writes go through the `window.api` automations bridge —
// the renderer never touches the on-disk store.
export function useAutomationsController(folderPath: string | null): AutomationsController {
  const [definitions, setDefinitions] = useState<AutomationDefinition[]>([])
  const [providers, setProviders] = useState<AutomationsProviders | null>(null)
  const [loadState, setLoadState] = useState<AsyncState>('idle')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!folderPath) {
      setLoadState('error')
      setLoadError('This workspace has no folder, so its automations store is unavailable.')
      return
    }
    setLoadState('loading')
    setLoadError(null)
    try {
      const [list, provs] = await Promise.all([
        window.api.listAutomations({ workspaceRoot: folderPath }),
        window.api.listAutomationProviders(),
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

  const runNow = useCallback((def: AutomationDefinition) => mutate(def, async () => {
    const result = await window.api.runAutomationNow({ workspaceRoot: folderPath!, automationId: def.id })
    if (result.ok) setDefinitions((prev) => prev.map((d) => (d.id === result.value.definition.id ? result.value.definition : d)))
    return result
  }), [folderPath, mutate])

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

  return {
    definitions,
    providers,
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
  }
}
