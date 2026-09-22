// The renderer half of model discovery: listens for catalogs main pushes and
// asks main for a pass with what this window holds, then stores each answer
// through `setCliModelCatalog` (the `discovered` layer the pickers merge).
//
// What this window holds matters to main for two reasons. The persisted
// catalogs go along as `previous`, so a row's `firstSeenAt` is carried forward
// and only an id this machine has not seen before reads as new. The CLI runtime
// settings go along so the probe runs the same command, under the same WSL
// switch, that a launch of that CLI would.
//
// Boot wiring is left to the caller: `startCliModelDiscovery(useWorkspaceStore)`
// once the store has hydrated, then `refreshCliModels({ force: true })` from
// Settings "Refresh models".
import type { DiscoveredCliModelCatalog } from '../../../shared/cli-model-catalog'
import type { CliModelDiscoveryResult } from '../../../shared/ipc/cli-model-discovery'
import type { AppSettings } from '../types/workspace'

type CliModelDiscoveryApi = Pick<Window['api'], 'cliModelsDiscover' | 'onCliModelsChanged'>

type CliModelDiscoveryStore = {
  getState: () => {
    appSettings: Pick<AppSettings, 'cliModelCatalog' | 'cliRuntimes'>
    setCliModelCatalog: (cli: string, catalog: DiscoveredCliModelCatalog | null) => void
  }
}

export type CliModelDiscoveryHandle = {
  // Resolves with main's answer, or null when there is no bridge or the call
  // failed; a failure leaves every stored catalog as it was.
  refreshCliModels: (options?: { force?: boolean; clis?: string[] }) => Promise<CliModelDiscoveryResult | null>
  stop: () => void
}

// Only a catalog is stored. A skipped or failed entry has none, and the last
// good catalog stays exactly where it is (rule 3 of the plan).
function applyResult(store: CliModelDiscoveryStore, result: CliModelDiscoveryResult | null | undefined): void {
  if (!result || !Array.isArray(result.entries)) return
  const { setCliModelCatalog } = store.getState()
  for (const entry of result.entries) {
    if (entry?.catalog) setCliModelCatalog(entry.cli, entry.catalog)
  }
}

function defaultApi(): CliModelDiscoveryApi | null {
  return typeof window === 'undefined' ? null : (window.api ?? null)
}

export function startCliModelDiscovery(
  store: CliModelDiscoveryStore,
  api: CliModelDiscoveryApi | null = defaultApi(),
): CliModelDiscoveryHandle {
  const unsubscribe =
    api && typeof api.onCliModelsChanged === 'function'
      ? api.onCliModelsChanged((result) => applyResult(store, result))
      : () => {}

  const refreshCliModels: CliModelDiscoveryHandle['refreshCliModels'] = async (options = {}) => {
    if (!api || typeof api.cliModelsDiscover !== 'function') return null
    const { cliModelCatalog, cliRuntimes } = store.getState().appSettings
    try {
      const result = await api.cliModelsDiscover({
        cliRuntimes,
        ...(cliModelCatalog ? { previous: cliModelCatalog } : {}),
        ...(options.force ? { force: true } : {}),
        ...(options.clis ? { clis: options.clis } : {}),
      })
      applyResult(store, result)
      return result
    } catch {
      return null
    }
  }

  return { refreshCliModels, stop: unsubscribe }
}
