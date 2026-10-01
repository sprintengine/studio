// The host API gate: a module built for a host API this app does not provide
// does not load, whatever its trust says. Trust answers "may this code run?";
// this answers "can it run here?", and trusting a module cannot fix a "no".
//
// Both halves apply it. The main load plan marks the module ineligible with
// `incompatible_host_api`, so its main entry never runs and the resolver's
// message (shared/modules/resolve.ts) says what would fix it; the renderer
// entry server (third-party-renderer-entries.ts) never sends its bundle.

import { checkHostApiCompatibility } from '../../shared/modules/host-api'
import type { CapabilityManifest, ModuleResolutionErrorCode } from '../../shared/modules/manifest'

type GatedManifest = Pick<CapabilityManifest, 'id' | 'engines' | 'source'>

/** The modules whose manifest names a host API this app cannot load, keyed by id. */
export function computeHostApiIneligible(
  modules: readonly (GatedManifest | { manifest: GatedManifest })[],
): Record<string, 'incompatible_host_api'> {
  const ineligible: Record<string, 'incompatible_host_api'> = {}
  for (const entry of modules) {
    const manifest = 'manifest' in entry ? entry.manifest : entry
    if (!checkHostApiCompatibility(manifest).ok) ineligible[manifest.id] = 'incompatible_host_api'
  }
  return ineligible
}

/**
 * Fold the gate into a load plan's ineligible set, in place. An incompatible
 * module reads as that rather than as untrusted — trusting it would not help —
 * but an invalid signature keeps its own reason: a tampered module is the
 * louder fact.
 */
export function applyHostApiGate(
  ineligible: Record<string, ModuleResolutionErrorCode>,
  modules: readonly (GatedManifest | { manifest: GatedManifest })[],
): void {
  for (const id of Object.keys(computeHostApiIneligible(modules))) {
    if (ineligible[id] === 'invalid_signature') continue
    ineligible[id] = 'incompatible_host_api'
  }
}
