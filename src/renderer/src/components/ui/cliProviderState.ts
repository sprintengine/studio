import type { CliAvailability } from '../../../../shared/electron-api'
import type { StatusTone } from './tokens'

// The one reading of "what is true about this agent CLI right now", shared by
// every surface that renders a CLI as a ProviderRow: Settings → Agents, the
// onboarding essentials step, and any list that adopts the anatomy later.
// Pure and DOM-free so the mapping is unit-testable and cannot drift between
// hosts — a CLI that reads "Ready" in settings and "Not installed" in
// onboarding is worse than either answer alone.
//
// The three-state shape is forced by the probe contract. `detectAgentCliAvailability`
// (src/main/cli-availability.ts) OMITS a CLI from the map when its probe errored
// (a shell spawn failure, not a clean "not found"), precisely so the renderer
// does not mistake a broken probe for an absent binary. So a missing entry is
// `unknown`, never `missing`: the previous card UI collapsed the two and offered
// an Install button for a CLI that may well have been installed all along.

type CliProviderHealth = 'checking' | 'ready' | 'missing' | 'unknown' | 'probe-failed'

export type CliProviderState = {
  health: CliProviderHealth
  tone: StatusTone
  /** Mono version for the row's first line. Null renders nothing. */
  version: string | null
  /** Resolved binary path, when the probe found one. */
  resolvedPath: string | null
  /** True only on a definitive positive probe — the one condition under which
   *  configuration (rather than installation) is the useful next action. */
  installed: boolean
}

export type CliProbeStatus = 'loading' | 'ready' | 'error'

export function resolveCliProviderState(
  availability: CliAvailability | undefined,
  probeStatus: CliProbeStatus,
): CliProviderState {
  const version = availability?.version?.trim() || null
  const resolvedPath = availability?.resolvedPath ?? null

  // A CLI with an entry is decided, whatever the batch is doing now: a
  // background re-probe must not flip a settled row back to "Checking".
  if (availability) {
    const installed = availability.installed === true
    return {
      health: installed ? 'ready' : 'missing',
      tone: installed ? 'good' : 'warn',
      version,
      resolvedPath,
      installed,
    }
  }
  if (probeStatus === 'loading') {
    return { health: 'checking', tone: 'neutral', version: null, resolvedPath: null, installed: false }
  }
  if (probeStatus === 'error') {
    return { health: 'probe-failed', tone: 'error', version: null, resolvedPath: null, installed: false }
  }
  return { health: 'unknown', tone: 'warn', version: null, resolvedPath: null, installed: false }
}

// The words for each state. Kept beside the mapping so a new health state
// cannot ship without one — the dot is aria-hidden, so this text IS the state
// for a screen reader and for anyone who cannot separate the tones.
export function cliProviderStateWords(
  state: CliProviderState,
  options: { binary: string; probeError?: string | null },
): string {
  switch (state.health) {
    case 'checking':
      return 'Checking…'
    case 'ready':
      return 'Ready'
    case 'missing':
      return `Not installed — no ${options.binary} on PATH`
    case 'probe-failed':
      return options.probeError
        ? `Availability unknown — ${options.probeError}`
        : 'Availability unknown — the check did not complete'
    case 'unknown':
      return `Availability unknown — the ${options.binary} check did not complete`
  }
}
