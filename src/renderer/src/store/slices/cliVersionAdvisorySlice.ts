import type { CliVersionAdvisoriesResult, CliVersionHostAdvisories } from '../../../../shared/electron-api'

// CLI version advisories as the renderer sees them: installed version against
// the registry's newest, per CLI, per machine (this one and each WSL
// distribution turned on). Not persisted; the main process recomputes them at
// boot, hourly, on Re-check and after an update it ran, and pushes when the
// answer changes.
export interface CliVersionAdvisorySliceState {
  cliVersionAdvisories: CliVersionHostAdvisories
  cliVersionAdvisoriesCheckedAt: string | null
  cliVersionAdvisoriesError: string | null
}

interface CliVersionAdvisorySliceActions {
  refreshCliVersionAdvisories: (options?: {
    // Ask the registry again, and answer even with version checks off.
    force?: boolean
    // Settings' Re-check: detect every CLI on every machine again first.
    detect?: boolean
  }) => Promise<CliVersionAdvisoriesResult | null>
  applyCliVersionAdvisories: (result: CliVersionAdvisoriesResult) => void
}

export type CliVersionAdvisorySlice = CliVersionAdvisorySliceState & CliVersionAdvisorySliceActions

type CliVersionAdvisorySliceSet = (mutator: (state: CliVersionAdvisorySliceState) => void) => void

type CliVersionApi = Pick<Window['api'], 'cliVersionAdvisories'>

function getCliVersionApi(): CliVersionApi | null {
  if (typeof window === 'undefined') return null
  const api = window.api
  return api && typeof api.cliVersionAdvisories === 'function' ? api : null
}

export function createCliVersionAdvisorySlice(
  set: CliVersionAdvisorySliceSet,
  deps: { getApi?: () => CliVersionApi | null } = {},
): CliVersionAdvisorySlice {
  const getApi = deps.getApi ?? getCliVersionApi

  const apply = (result: CliVersionAdvisoriesResult): void => {
    set((state) => {
      if (result.ok) {
        state.cliVersionAdvisories = result.advisories
        state.cliVersionAdvisoriesCheckedAt = result.checkedAt
        state.cliVersionAdvisoriesError = null
      } else {
        // Keep the last advisories: a registry hiccup is not "everything is
        // current", and it is not "nothing is known" either.
        state.cliVersionAdvisoriesError = result.message
      }
    })
  }

  return {
    cliVersionAdvisories: {},
    cliVersionAdvisoriesCheckedAt: null,
    cliVersionAdvisoriesError: null,
    applyCliVersionAdvisories: apply,
    refreshCliVersionAdvisories: async (options = {}) => {
      const api = getApi()
      if (!api) return null
      try {
        const result = await api.cliVersionAdvisories({
          ...(options.force ? { force: true } : {}),
          ...(options.detect ? { detect: true } : {}),
        })
        apply(result)
        return result
      } catch (error) {
        const failure: CliVersionAdvisoriesResult = {
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        }
        apply(failure)
        return failure
      }
    },
  }
}

export function subscribeCliVersionAdvisoryChanges(
  apply: (result: CliVersionAdvisoriesResult) => void,
  api: Pick<Window['api'], 'onCliVersionAdvisoriesChanged'> | null = typeof window === 'undefined' ? null : window.api,
): () => void {
  if (!api || typeof api.onCliVersionAdvisoriesChanged !== 'function') return () => {}
  return api.onCliVersionAdvisoriesChanged(apply)
}
