// What an inline agent-CLI marketplace row says and offers. The row's
// state is RUNTIME state — is this CLI on the machine, can it be put there —
// read from the same two sources every other CLI surface reads: the plugin
// catalog (`pluginsList`) and the availability probe (`cliAvailabilitySlice` /
// resolveCliProviderState). No trust vocabulary here: the twelve inline entries
// ship inside the signed app bundle, so the signing tier says nothing a user
// can act on, while installed-or-not is the one fact this shelf exists to carry.
//
// Pure and DOM-free so every state is unit-testable and cannot drift from the
// pickers: a missing availability entry means the probe FAILED (see
// cliProviderState.ts), and such a CLI is never offered an Install — the same
// signal deployment pickers already hide uninstalled CLIs on.

import type {
  CliAvailability,
  CliInstallMethodInfo,
  CliVersionAdvisory,
  CliVersionAdvisoryMap,
} from '../../../../../shared/electron-api'
import type { PluginCatalogStatus } from '../../../types/workspace'
import { resolveCliProviderState, type CliProbeStatus, type CliProviderState } from '../../ui/cliProviderState'
import type { StatusTone } from '../../ui'

// The per-CLI install-methods probe (`cliInstallMethods`): unknown until asked,
// then the platform bucket's methods. An empty ready list is the definitive
// "this platform has no install path" — the one state that must never render a
// button.
export type CliInstallMethodsLoad =
  { status: 'unknown' } | { status: 'loading' } | { status: 'ready'; methods: readonly CliInstallMethodInfo[] }

export type AgentCliShelfRowState = {
  tone: StatusTone
  /** Mono version slot, from the probe. Null renders nothing. */
  version: string | null
  /** Words for states the probe vocabulary does not cover (checking the
   *  catalog, built into the app, unsupported platform). Null means the state
   *  line is the shared CliProviderStateLine rendered from `provider`. */
  words: string | null
  /** The probe-derived state, when this row is a runtime CLI. */
  provider: CliProviderState | null
  /** Is this CLI actually on the machine? False ONLY where absence is settled —
   *  a definitive negative probe, or a platform with no install path at all. A
   *  probe that never answered is not absence and stays `true`, so an unknown
   *  row is never receded into the background as if it were missing. The row
   *  lowers its contrast on this, the way the sidebar recedes a conversation
   *  that is not the active one. */
  present: boolean
  /** `install` only on a definitive negative probe WITH at least one install
   *  method for this platform — anything less would be a dead or lying button. */
  action: 'install' | 'none'
}

// The platform named in "Not available on …", from the same target resolution
// the installer uses: WSL is a logical target on Windows, not a platform.
export function agentCliPlatformLabel(platform: string, useWsl: boolean): string {
  if (platform === 'darwin') return 'macOS'
  if (platform === 'win32') return useWsl ? 'WSL' : 'Windows'
  return 'Linux'
}

export function agentCliShelfRowState(input: {
  /** Whether the plugin catalog (which CLIs are runtime-installable at all) has
   *  answered. Until it has, installed-vs-built-in is genuinely unknown. */
  catalogStatus: PluginCatalogStatus
  /** True when the catalog holds a CLI plugin for this entry's pluginId. The
   *  provider-kind bundled plugins (claude-agent, openrouter, xai) have no
   *  binary and no install spec — catalogue content with nothing to install. */
  inCatalog: boolean
  availability: CliAvailability | undefined
  availabilityStatus: CliProbeStatus
  installMethods: CliInstallMethodsLoad
  platform: string
  useWsl: boolean
}): AgentCliShelfRowState {
  if (input.catalogStatus === 'loading') {
    return { tone: 'neutral', version: null, words: 'Checking…', provider: null, present: true, action: 'none' }
  }
  if (input.catalogStatus === 'error') {
    // The registry read failing is its own fact; guessing "installed" or
    // "installable" over it would be the surface inventing a state.
    return {
      tone: 'warn',
      version: null,
      words: 'Runtime state unavailable — the plugin registry could not be read',
      provider: null,
      present: true,
      action: 'none',
    }
  }
  if (!input.inCatalog) {
    return {
      tone: 'neutral',
      version: null,
      words: 'Built into the app — nothing to install',
      provider: null,
      // Built in IS present: it ships inside the app bundle.
      present: true,
      action: 'none',
    }
  }

  const provider = resolveCliProviderState(input.availability, input.availabilityStatus)
  if (provider.health !== 'missing') {
    // ready / checking / unknown / probe-failed: the shared probe vocabulary is
    // the state line, and none of them may offer an Install — an unknown probe
    // may well be looking at an installed CLI.
    return { tone: provider.tone, version: provider.version, words: null, provider, present: true, action: 'none' }
  }

  // Definitively absent. Installable only once this platform is known to have
  // an install path; a platform with none says so instead of offering a button.
  if (input.installMethods.status === 'ready' && input.installMethods.methods.length === 0) {
    return {
      tone: 'neutral',
      version: null,
      words: `Not available on ${agentCliPlatformLabel(input.platform, input.useWsl)}`,
      provider: null,
      present: false,
      action: 'none',
    }
  }
  return {
    tone: provider.tone,
    version: null,
    words: null,
    provider,
    present: false,
    action: input.installMethods.status === 'ready' ? 'install' : 'none',
  }
}

// ── Updates ─────────────────────────────────────────────────────────────────

// A CLI is behind when the advisory says so and nothing else. `behind_latest`
// is the ONE status that means "there is something to do here": `unknown` is a
// registry we could not read and `current` is nothing to say, and neither of
// them earns a count on a row or on the tab above it.
export function cliUpdateAvailable(advisory: CliVersionAdvisory | undefined): boolean {
  return advisory?.status === 'behind_latest'
}

/**
 * How many of these CLIs are behind their published version — the number the
 * Agent CLIs tabs wear.
 *
 * It counts over the CLIs a tab actually LISTS rather than over the whole
 * advisory map: a tab that says "3" while showing two rows is the tab and the
 * list giving two answers to one question, which is the failure the count on
 * the tab already avoids for its own noun (catalogueTabs).
 */
export function countCliUpdates(advisories: CliVersionAdvisoryMap, cliIds: readonly string[]): number {
  const seen = new Set<string>()
  for (const id of cliIds) {
    if (seen.has(id)) continue
    if (cliUpdateAvailable(advisories[id as keyof CliVersionAdvisoryMap])) seen.add(id)
  }
  return seen.size
}
