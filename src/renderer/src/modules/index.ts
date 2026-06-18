import type { CapabilityManifest, ModuleEnablementOverrides } from '../../../shared/modules/manifest'
import { resolveModuleEnablement } from '../../../shared/modules/resolve'
import { MODULE_PROFILES, profileEnables, type ModuleProfileId } from '../../../shared/modules/profiles'
import { agentRuntimeRendererModule } from './agent-runtime-module'
import { automationsRendererModule } from './automations-module'
import { backlogRendererModule } from './backlog-module'
import { devToolsRendererModule } from './dev-tools-module'
import { gitRendererModule } from './git-module'
import { memoryRendererModule } from './memory-module'
import { mobileRelayRendererModule } from './mobile-relay-module'
import { multiloopRendererModule } from './multiloop-module'
import { sprintEngineRendererModule } from './sprint-engine-module'
import { switchboardRendererModule } from './switchboard-module'
import { voiceDictationRendererModule } from './voice-dictation-module'
import { createRendererHost, type RendererModule } from './renderer-host'

// Bundled renderer capability modules. Features migrate onto the host one at a
// time; this list grows as each renderer surface is extracted from the
// hardcoded factory switch / panel rail.
export const BUNDLED_RENDERER_MODULES: RendererModule[] = [
  agentRuntimeRendererModule,
  backlogRendererModule,
  devToolsRendererModule,
  memoryRendererModule,
  gitRendererModule,
  switchboardRendererModule,
  multiloopRendererModule,
  sprintEngineRendererModule,
  automationsRendererModule,
  mobileRelayRendererModule,
  voiceDictationRendererModule,
]

export const BUNDLED_RENDERER_MODULE_MANIFESTS: ReadonlyArray<CapabilityManifest> =
  BUNDLED_RENDERER_MODULES.map((module) => module.manifest)

// The optional (non-core) module ids — the universe profiles select from. Core
// modules are always on and never appear in an override map.
export const OPTIONAL_MODULE_IDS: ReadonlyArray<string> = BUNDLED_RENDERER_MODULE_MANIFESTS.filter(
  (manifest) => !manifest.core
).map((manifest) => manifest.id)

// Eager singleton: registering a panel only stores a (lazy) component reference,
// so there's no render cost. The actual bundle loads when the panel renders.
// Each module registers through a scoped host so its panels record their owning
// module id (used by the factory to gate a host panel by enablement).
const rendererHost = createRendererHost()
for (const module of BUNDLED_RENDERER_MODULES) {
  module.registerRenderer?.(rendererHost.hostFor(module.manifest.id))
}

export function getRendererHost(): ReturnType<typeof createRendererHost> {
  return rendererHost
}

// Trusted third-party renderer modules join the same host and the same
// enablement universe as bundled modules. Loading runs at boot, before the
// React root renders (main.tsx awaits it), so consumers never see a
// half-registered module; from then on enablement toggles gate contributions
// reactively exactly like bundled ones — no reload. Only cleanly loaded
// modules' manifests enter the resolution universe (a module that failed
// mid-registration stays gated off everywhere).
let thirdPartyRendererManifests: ReadonlyArray<CapabilityManifest> = []

export async function loadThirdPartyRendererModules(): Promise<void> {
  // Older preload bundles may not carry the bridge yet; treat that as "no
  // third-party renderer entries" rather than failing the boot.
  if (typeof window.api?.listThirdPartyRendererEntries !== 'function') return
  const served = await window.api.listThirdPartyRendererEntries()
  const { loadThirdPartyRendererEntries } = await import('./third-party-loader')
  thirdPartyRendererManifests = await loadThirdPartyRendererEntries(rendererHost, served)
  if (thirdPartyRendererManifests.length > 0) {
    // The memoized enabled-set is keyed per overrides object; the universe just
    // changed, so any set resolved before the manifests landed is stale.
    enabledSetCache = new WeakMap()
  }
}

// Resolving the module graph is pure but non-trivial (map build + dependency
// fixpoint + topo sort), and `selectModuleEnabled` runs inside many Zustand
// selectors on every store update. Memoize the resolved enabled-set per
// overrides object: the store hands out a new `appSettings.modules` reference
// only when enablement actually changes, so this is one resolution per change
// rather than one per call site per render.
let enabledSetCache = new WeakMap<object, Set<string>>()

function enablementUniverse(): CapabilityManifest[] {
  return [...BUNDLED_RENDERER_MODULE_MANIFESTS, ...thirdPartyRendererManifests]
}

function enabledModuleSet(overrides: ModuleEnablementOverrides): Set<string> {
  if (!overrides || typeof overrides !== 'object') {
    return new Set(resolveModuleEnablement(enablementUniverse(), {}).order)
  }
  let set = enabledSetCache.get(overrides)
  if (!set) {
    set = new Set(resolveModuleEnablement(enablementUniverse(), overrides).order)
    enabledSetCache.set(overrides, set)
  }
  return set
}

// Reactive enablement selector for store subscriptions. Returns a boolean, so
// it's safe to use directly inside useWorkspaceStore selectors.
export function selectModuleEnabled(
  overrides: ModuleEnablementOverrides,
  moduleId: string
): boolean {
  return enabledModuleSet(overrides).has(moduleId)
}

// The profile whose optional-module selection exactly matches the current
// enablement, or null for a custom mix. Used to highlight the active profile in
// the chooser and the Settings → Modules manager.
export function matchModuleProfile(overrides: ModuleEnablementOverrides): ModuleProfileId | null {
  const enabled = enabledModuleSet(overrides)
  for (const profile of MODULE_PROFILES) {
    const matches = OPTIONAL_MODULE_IDS.every((id) => enabled.has(id) === profileEnables(profile, id))
    if (matches) return profile.id
  }
  return null
}

export type { RendererModule } from './renderer-host'
