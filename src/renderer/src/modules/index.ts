import type { CapabilityManifest, ModuleEnablementOverrides } from '../../../shared/modules/manifest'
import { activeForChannel } from '../../../shared/modules/dev-only'
import { resolveModuleEnablement } from '../../../shared/modules/resolve'
import { agentRuntimeRendererModule } from './agent-runtime-module'
import { automationsRendererModule } from './automations-module'
import { backlogRendererModule } from './backlog-module'
import { devToolsRendererModule } from './dev-tools-module'
import { gitRendererModule } from './git-module'
import { memoryRendererModule } from './memory-module'
import { mobileRelayRendererModule } from './mobile-relay-module'
import { multiloopRendererModule } from './multiloop-module'
import { reviewRendererModule } from './review-module'
import { roadmapRendererModule } from './roadmap-module'
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
  reviewRendererModule,
  automationsRendererModule,
  roadmapRendererModule,
  mobileRelayRendererModule,
  voiceDictationRendererModule,
]

// Full bundled manifest list. Kept complete in every build channel: it backs
// the reserved-id drift guard (bundled-ids.test.ts) and the anti-impersonation
// set, so a third-party module can never claim a bundled id even in a build
// where the feature itself is absent. Do NOT narrow this to the active set.
export const BUNDLED_RENDERER_MODULE_MANIFESTS: ReadonlyArray<CapabilityManifest> =
  BUNDLED_RENDERER_MODULES.map((module) => module.manifest)

// True only in a real packaged (production) vite renderer build. We key on
// vite's `import.meta.env.PROD` rather than `DEV` on purpose: the unit-test
// bundles pass `--define:import.meta.env.DEV=false` (61 of them), which esbuild
// would fold into this gate and wrongly drop dev-only modules under test. No
// test defines `PROD`, so reading it defensively yields `false` everywhere
// except a genuine production build (where vite sets `PROD === true`), keeping
// the full module set active under both dev runs and tests. Do NOT "simplify"
// this back to `import.meta.env.DEV`.
const IS_PRODUCTION_BUILD: boolean = (import.meta as { env?: { PROD?: boolean } }).env?.PROD === true

// Active renderer modules for this build channel. Dev-only modules (Voice,
// Switchboard/Watchtower, Multiloop, Mobile Relay) are dropped from a packaged
// (production) renderer bundle so they are absent everywhere downstream: host
// registration, the enablement universe, profiles, and the Settings → Modules
// manager. In a dev build the full set is active and the modules remain
// user-toggleable. See src/shared/modules/dev-only.ts.

export const ACTIVE_RENDERER_MODULES: ReadonlyArray<RendererModule> = activeForChannel(
  BUNDLED_RENDERER_MODULES,
  (module) => module.manifest.id,
  !IS_PRODUCTION_BUILD
)

export const ACTIVE_RENDERER_MODULE_MANIFESTS: ReadonlyArray<CapabilityManifest> =
  ACTIVE_RENDERER_MODULES.map((module) => module.manifest)

// Bundled modules that exist but are not active in this build channel — i.e. the
// feature-flagged (dev-only) modules in a production build; empty in a dev build
// where every bundled module is active. The Settings → Modules manager shows
// these as greyed-out "Coming soon" rows so users can see what's on the way
// without being able to turn them on (they are absent from the enablement
// universe, so they can never resolve enabled).
const ACTIVE_RENDERER_MODULE_IDS = new Set(ACTIVE_RENDERER_MODULE_MANIFESTS.map((m) => m.id))
export const COMING_SOON_MODULE_MANIFESTS: ReadonlyArray<CapabilityManifest> =
  BUNDLED_RENDERER_MODULE_MANIFESTS.filter((manifest) => !ACTIVE_RENDERER_MODULE_IDS.has(manifest.id))

// Eager singleton: registering a panel only stores a (lazy) component reference,
// so there's no render cost. The actual bundle loads when the panel renders.
// Each module registers through a scoped host so its panels record their owning
// module id (used by the factory to gate a host panel by enablement). Only the
// active set registers, so a dev-only module's panels/commands/settings never
// exist on the host in a production build.
const rendererHost = createRendererHost()
for (const module of ACTIVE_RENDERER_MODULES) {
  module.registerRenderer?.(rendererHost.hostFor(module.manifest.id))
}

// Host methods that gate on live enablement without a caller-supplied
// predicate (the Backlog read API) resolve it through this hook. The store
// import is deferred so the eager module-registry graph stays store-free
// (unit-test bundles construct this module without the store); until it lands
// (a microtask after boot, before the React root renders any panel) the
// kernel treats providers as enabled — and watches re-check on every
// delivery, so nothing started in that window outlives the resolver.
if (typeof window !== 'undefined') {
  import('../store/workspaceStore')
    .then(({ useWorkspaceStore }) => {
      rendererHost.setModuleEnablementResolver((moduleId) =>
        selectModuleEnabled(useWorkspaceStore.getState().appSettings.modules, moduleId)
      )
    })
    .catch(() => {
      // Windowless bundles (unit tests) have no store; the kernel default applies.
    })
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
  // Active set only: a dev-only module excluded from this build channel must not
  // resolve as enabled, so it never surfaces a panel, command, or workspace mode.
  return [...ACTIVE_RENDERER_MODULE_MANIFESTS, ...thirdPartyRendererManifests]
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

export type { RendererModule } from './renderer-host'
